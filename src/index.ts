import { scheduleJob, Job } from 'node-schedule';
import { Logger } from '@nestjs/common';

// Уникальный ключ для метаданных (Reflect Metadata)
const SCHEDULE_METADATA_KEY = Symbol('SCHEDULE_METADATA_KEY');

/**
 * Интерфейс, описывающий данные о расписании для одного метода
 */
interface ScheduleMetadata {
   /** Удобочитаемое имя задачи */
   name: string;
   /** CRON-выражение (например, "0 * * * *") */
   cronExpression: string;
   /** Название метода, который будет запускаться */
   propertyKey: string;
   /** Ссылка на объект Job из node-schedule (чтобы потом можно было отменить) */
   job?: Job;
}

/**
 * Декоратор, который ставит метод "в очередь" на запуск по расписанию
 * @param name - имя задачи (произвольное, для логов или отладки)
 * @param cronExpression - Cron строка (например, '0/30 * * * * *')
 */
export function ScheduleJob(name: string, cronExpression: string): MethodDecorator {
   return (target: any, propertyKey: string | symbol) => {
      // Считываем уже существующие задачи из метаданных класса (если есть)
      const existingJobs: ScheduleMetadata[] = Reflect.getMetadata(SCHEDULE_METADATA_KEY, target.constructor) || [];

      // Добавляем новую задачу в список
      existingJobs.push({
         name,
         cronExpression,
         propertyKey: propertyKey as string,
      });

      // Сохраняем обратно в метаданные
      Reflect.defineMetadata(SCHEDULE_METADATA_KEY, existingJobs, target.constructor);
   };
}

/**
 * Функция, которую можно вызвать при старте приложения (onModuleInit),
 * чтобы найти все методы с декоратором @ScheduleJob и запустить для них cron-задачи
 */
export function initializeScheduledJobs(instance: any): void {
   const constructor = instance.constructor;
   // Забираем список расписаний из метаданных
   const jobs: ScheduleMetadata[] = Reflect.getMetadata(SCHEDULE_METADATA_KEY, constructor) || [];

   if (!jobs.length) {
      Logger.log(`No scheduled jobs found for ${constructor.name}`, 'initializeScheduledJobs');
      return;
   }

   Logger.log(`Initializing scheduled jobs for ${constructor.name}`, 'initializeScheduledJobs');

   jobs.forEach((jobMetadata) => {
      const method = instance[jobMetadata.propertyKey];
      if (typeof method !== 'function') {
         throw new Error(`Method "${String(jobMetadata.propertyKey)}" not found on ${constructor.name}`);
      }

      // Создаем задачу в node-schedule
      const newJob = scheduleJob(jobMetadata.cronExpression, async () => {
         try {
            await method.apply(instance);
         } catch (error) {
            Logger.error(`Error executing job "${jobMetadata.name}": ${error instanceof Error ? error.message : error}`, constructor.name);
         }
      });

      // Сохраняем объект задачи, чтобы потом уметь отменять
      jobMetadata.job = newJob;

      Logger.log(
         `Scheduled job "${jobMetadata.name}" -> method "${jobMetadata.propertyKey}" with cron "${jobMetadata.cronExpression}"`,
         constructor.name,
      );
   });
}

/**
 * Функция, которую можно вызвать перед выключением приложения (onModuleDestroy),
 * чтобы отменить все ранее запущенные задачи из этого класса
 */
export function cleanupScheduledJobs(instance: any): void {
   const constructor = instance.constructor;
   const jobs: ScheduleMetadata[] = Reflect.getMetadata(SCHEDULE_METADATA_KEY, constructor) || [];

   if (!jobs.length) {
      return;
   }

   Logger.debug(`Cleaning up scheduled jobs for ${constructor.name}`, 'cleanupScheduledJobs');

   jobs.forEach((jobMetadata) => {
      if (jobMetadata.job) {
         // Отменяем задачу
         jobMetadata.job.cancel();
         jobMetadata.job = undefined;
      }
   });
}
