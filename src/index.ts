import { Logger } from '@nestjs/common';
import { CronJob } from 'cron';
import { SchedulerRegistry } from '@nestjs/schedule';
import { CronExpression } from '@nestjs/schedule';

// Метаданные, где храним наши расписания
const SCHEDULE_METADATA_KEY = Symbol('SCHEDULE_METADATA_KEY');

// Интерфейс для метаданных о задаче
interface ScheduleMetadata {
   name: string;
   cronExpression: string;
   propertyKey: string;
   lastExecution?: Date; // последнее реальное выполнение
   executing?: boolean; // идёт ли сейчас выполнение
   intervalId?: NodeJS.Timeout; // не используется в новой реализации, но сохраним
}

// =================== Декоратор для методов ===================

export function ScheduleJob(name: string, cronExpression: CronExpression): MethodDecorator {
   return (target: any, propertyKey: string | symbol) => {
      const existingJobs: ScheduleMetadata[] = Reflect.getMetadata(SCHEDULE_METADATA_KEY, target.constructor) || [];

      existingJobs.push({ name, cronExpression, propertyKey: propertyKey as string });
      Reflect.defineMetadata(SCHEDULE_METADATA_KEY, existingJobs, target.constructor);
   };
}

// =================== Инициализация cron-задач ===================

export function initializeScheduledJobs(instance: any, schedulerRegistry?: SchedulerRegistry) {
   const constructor = instance.constructor;
   // Достаём все задачи из метаданных
   const jobs: ScheduleMetadata[] = Reflect.getMetadata(SCHEDULE_METADATA_KEY, constructor) || [];

   if (!schedulerRegistry) {
      schedulerRegistry = instance?.schedulerRegistry;
      if (!schedulerRegistry) {
         throw new Error('SchedulerRegistry is not provided or available in the instance context.');
      }
   }

   Logger.log(`Initializing scheduled jobs for ${constructor.name}`);

   // 1) Регистрируем для каждой задачи CronJob
   jobs.forEach((job) => {
      const method = instance[job.propertyKey];

      if (typeof method !== 'function') {
         throw new Error(`Method ${job.propertyKey} not found on ${constructor.name}`);
      }

      // Проверяем, не был ли уже зарегистрирован такой cron
      if (!schedulerRegistry.doesExist('cron', job.name)) {
         const cronJob = new CronJob(job.cronExpression, async () => {
            if (job.executing) return;

            try {
               job.executing = true;
               await method.apply(instance);
            } catch (error) {
               Logger.error(`Error executing job ${job.name}: ${error.message}`, constructor.name);
            } finally {
               job.executing = false;
               job.lastExecution = new Date();
            }
         });

         schedulerRegistry.addCronJob(job.name, cronJob);
         cronJob.start();

         Logger.log(`Scheduled job "${job.propertyKey}" with cron "${job.cronExpression}" and name "${job.name}"`, constructor.name);
      }
   });

   // 2) Создаём один общий setInterval для проверки «пропущенных» задач
   const CHECK_INTERVAL = 30_000; // как часто проверять (каждые 30 секунд)
   const intervalName = `missed_jobs_checker-${constructor.name}`;

   // Если интервал еще не зарегистрирован, регистрируем
   if (!schedulerRegistry.doesExist('interval', intervalName)) {
      const missedJobsChecker = setInterval(async () => {
         const now = Date.now();

         for (const job of jobs) {
            // Если метод не был ещё запущен ни разу, пропускаем
            if (!job.lastExecution) {
               continue;
            }

            const expectedInterval = getCronInterval(job.cronExpression);
            // Если getCronInterval() не смог корректно распарсить cron-строку (вернулось 0 или NaN), то пропускаем
            if (!expectedInterval || isNaN(expectedInterval)) {
               continue;
            }

            // Проверяем, сколько прошло времени с последнего запуска
            const elapsed = now - job.lastExecution.getTime();

            // Если прошло заметно больше, чем ожидаемый интервал, считаем это "пропущенным" запуском
            if (elapsed > expectedInterval * 1.5 && !job.executing) {
               try {
                  Logger.warn(`Missed execution detected for job ${job.name}`, constructor.name);
                  job.executing = true;
                  await instance[job.propertyKey].apply(instance);
               } catch (error) {
                  Logger.error(`Error executing missed job ${job.name}: ${error.message}`, constructor.name);
               } finally {
                  job.executing = false;
                  job.lastExecution = new Date();
               }
            }
         }
      }, CHECK_INTERVAL);

      // Регистрируем этот общий таймер в SchedulerRegistry,
      // чтобы при необходимости можно было его удалить
      schedulerRegistry.addInterval(intervalName, missedJobsChecker);
   } else {
      Logger.warn(`Interval "${intervalName}" is already registered in SchedulerRegistry. Skipping creation.`, constructor.name);
   }
}

// =================== Очистка cron-задач ===================

export function cleanupScheduledJobs(instance: any, schedulerRegistry?: SchedulerRegistry) {
   const constructor = instance.constructor;
   const jobs: ScheduleMetadata[] = Reflect.getMetadata(SCHEDULE_METADATA_KEY, constructor) || [];

   if (!schedulerRegistry) {
      schedulerRegistry = instance?.schedulerRegistry;
      if (!schedulerRegistry) {
         throw new Error('SchedulerRegistry is not provided or available in the instance context.');
      }
   }

   Logger.debug(`Cleaning up scheduled jobs for ${constructor.name}`);

   // Удаляем cron-задания
   jobs.forEach((job) => {
      try {
         schedulerRegistry.deleteCronJob(job.name);
      } catch (error) {
         // Игнорируем возможные ошибки "job not found"
      }
   });

   // Удаляем общий таймер
   const intervalName = `missed_jobs_checker-${constructor.name}`;
   try {
      schedulerRegistry.deleteInterval(intervalName);
      Logger.debug(`Deleted interval "${intervalName}"`, constructor.name);
   } catch (error) {
      // Игнорируем
   }
}

function getCronInterval(cronExpression: string): number {
   const parts = cronExpression.split(' ').map(Number);
   // Ожидаем ровно 3 части (сек, мин, час)
   if (parts.length < 3) {
      Logger.error(`Invalid cron expression "${cronExpression}" (less than 3 segments)`);
      return 0;
   }

   const [seconds, minutes, hours] = parts;

   const msInHour = 3_600_000;
   const msInMinute = 60_000;
   const msInSecond = 1_000;

   return hours * msInHour + minutes * msInMinute + seconds * msInSecond;
}
