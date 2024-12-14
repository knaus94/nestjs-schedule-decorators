import { Logger } from '@nestjs/common';
import { CronJob } from 'cron';
import { SchedulerRegistry } from '@nestjs/schedule';
import { CronExpression } from '@nestjs/schedule';

const SCHEDULE_METADATA_KEY = Symbol('SCHEDULE_METADATA_KEY');

interface ScheduleMetadata {
   name: string;
   cronExpression: string;
   propertyKey: string;
   lastExecution?: Date;
   executing?: boolean;
   intervalId?: NodeJS.Timeout;
}

export function ScheduleJob(name: string, cronExpression: CronExpression): MethodDecorator {
   return (target: any, propertyKey: string | symbol) => {
      const existingJobs: ScheduleMetadata[] = Reflect.getMetadata(SCHEDULE_METADATA_KEY, target.constructor) || [];
      existingJobs.push({ name, cronExpression, propertyKey: propertyKey as string });
      Reflect.defineMetadata(SCHEDULE_METADATA_KEY, existingJobs, target.constructor);
   };
}

export function initializeScheduledJobs(instance: any, schedulerRegistry?: SchedulerRegistry) {
   const constructor = instance.constructor;
   const jobs: ScheduleMetadata[] = Reflect.getMetadata(SCHEDULE_METADATA_KEY, constructor) || [];

   if (!schedulerRegistry) {
      schedulerRegistry = instance?.schedulerRegistry;
      if (!schedulerRegistry) {
         throw new Error('SchedulerRegistry is not provided or available in the instance context.');
      }
   }

   Logger.log(`Initializing scheduled jobs for ${constructor.name}`);

   jobs.forEach((job) => {
      const method = instance[job.propertyKey];

      if (typeof method !== 'function') {
         throw new Error(`Method ${job.propertyKey} not found on ${constructor.name}`);
      }

      if (schedulerRegistry.doesExist('cron', job.name)) {
         Logger.warn(`Job ${job.name} already exists, skipping initialization`, constructor.name);
         return;
      }

      const cronJob = new CronJob(job.cronExpression, async () => {
         if (job.executing) {
            Logger.warn(`Job ${job.name} is already executing. Skipping this run.`, constructor.name);
            return;
         }

         try {
            job.executing = true;
            const now = new Date();
            job.lastExecution = now;
            await method.apply(instance);
         } catch (error) {
            Logger.error(`Error executing job ${job.name}: ${error.message}`, constructor.name);
         } finally {
            job.executing = false;
         }
      });

      schedulerRegistry.addCronJob(job.name, cronJob);
      cronJob.start();

      Logger.log(`Scheduled job ${job.propertyKey} with cron expression ${job.cronExpression} and name ${job.name}`, constructor.name);

      job.intervalId = setInterval(async () => {
         const now = new Date();
         if (job.lastExecution && now.getTime() - job.lastExecution.getTime() > getCronInterval(job.cronExpression)) {
            if (job.executing) {
               Logger.warn(`Job ${job.name} is already executing. Skipping this run.`, constructor.name);
               return;
            }

            try {
               job.executing = true;
               await method.apply(instance);
               job.lastExecution = now;
            } catch (error) {
               Logger.error(`Error executing missed job ${job.name}: ${error.message}`, constructor.name);
            } finally {
               job.executing = false;
            }
         }
      }, getCronInterval(job.cronExpression) / 2); // Check twice as often as the cron interval
   });
}

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

   jobs.forEach((job) => {
      try {
         schedulerRegistry.deleteCronJob(job.name);
         if (job.intervalId) {
            clearInterval(job.intervalId);
            job.intervalId = undefined;
         }
      } catch (error) {
         Logger.error(`Failed to delete job ${job.name}: ${error.message}`, constructor.name);
      }
   });
}

function getCronInterval(cronExpression: string): number {
   const [seconds, minutes, hours] = cronExpression.split(' ').map(Number);

   const msInHour = 3600000;
   const msInMinute = 60000;
   const msInSecond = 1000;

   return (hours || 0) * msInHour + (minutes || 0) * msInMinute + (seconds || 0) * msInSecond;
}
