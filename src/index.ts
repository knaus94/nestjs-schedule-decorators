import 'reflect-metadata';
import { scheduleJob, Job } from 'node-schedule';
import { Logger } from '@nestjs/common';
import type { Observable, Subscription } from 'rxjs';

// ───────────────────────────────────────────────────────────────────────────────
// Metadata & hidden per-instance state
// ───────────────────────────────────────────────────────────────────────────────

// Unique metadata key to store schedule definitions on the class
const SCHEDULE_METADATA_KEY = Symbol('SCHEDULE_METADATA_KEY');

// Hidden symbols for per-instance state and subscription
const SCHEDULE_STATE = Symbol('SCHEDULE_STATE');
const SCHEDULE_CONTROL_SUB = Symbol('SCHEDULE_CONTROL_SUB');

export interface ScheduleMetadata {
   // Human-readable job name for logs
   name: string;
   // Cron-like expression supported by node-schedule (e.g. '0/30 * * * * *')
   cronExpression: string;
   // Target method name
   propertyKey: string | symbol;
   // If true, skip new tick while previous run still in progress
   skipIfRunning?: boolean;
}

type PerJobState = {
   job?: Job;
   running?: boolean;
};

type StateMap = Map<string | symbol, PerJobState>;

function getOrCreateState(instance: any): StateMap {
   let state: StateMap = (instance as any)[SCHEDULE_STATE];
   if (!state) {
      state = new Map();
      // Define as non-enumerable to avoid accidental leaks on logs/serializations
      Object.defineProperty(instance, SCHEDULE_STATE, {
         value: state,
         enumerable: false,
         configurable: false,
         writable: false,
      });
   }
   return state;
}

function getScheduleDefs(ctor: any): ScheduleMetadata[] {
   return (Reflect.getMetadata(SCHEDULE_METADATA_KEY, ctor) as ScheduleMetadata[]) || [];
}

// ───────────────────────────────────────────────────────────────────────────────
// Decorators
// ───────────────────────────────────────────────────────────────────────────────

/**
 * Method decorator to register a job definition on the class.
 */
export function ScheduleJob(name: string, cronExpression: string, options?: { skipIfRunning?: boolean }): MethodDecorator {
   return (target: any, propertyKey: string | symbol) => {
      const defs = getScheduleDefs(target.constructor);
      defs.push({
         name,
         cronExpression,
         propertyKey,
         skipIfRunning: options?.skipIfRunning ?? true,
      });
      Reflect.defineMetadata(SCHEDULE_METADATA_KEY, defs, target.constructor);
   };
}

/**
 * Class decorator that wires up bootstrap/destroy hooks automatically.
 * - control$: factory returning Observable<boolean>; when true -> start jobs, false -> stop jobs
 * - If control$ is not provided, tries this.masterNodeService.isMaster$; if missing, starts immediately.
 */
export function AutoScheduleJobs(opts?: {
   control$?: (self: any) => Observable<boolean> | undefined;
   bootstrapHook?: 'onApplicationBootstrap' | 'onModuleInit';
}): ClassDecorator {
   const bootstrapHook = opts?.bootstrapHook ?? 'onApplicationBootstrap';

   return (target: any) => {
      const proto = target.prototype;

      const origBootstrap = proto[bootstrapHook];
      const origDestroy = proto.onModuleDestroy;

      // Patch bootstrap hook
      proto[bootstrapHook] = function (...args: any[]) {
         // Call user-defined hook first to preserve original semantics
         if (typeof origBootstrap === 'function') {
            origBootstrap.apply(this, args);
         }

         const ctorName = this.constructor?.name ?? target.name ?? 'UnknownClass';
         const defs = getScheduleDefs(this.constructor);

         if (!defs.length) {
            Logger.log(`No @ScheduleJob definitions found for ${ctorName}`, 'AutoScheduleJobs');
            return;
         }

         // Resolve control$ (if any)
         let control$: Observable<boolean> | undefined;
         try {
            control$ =
               opts?.control$?.(this) ??
               // Heuristic: try this.masterNodeService.isMaster$ if it looks like an observable
               (this?.masterNodeService?.isMaster$ && typeof this.masterNodeService.isMaster$?.subscribe === 'function'
                  ? this.masterNodeService.isMaster$
                  : undefined);
         } catch {
            // noop: fall back to immediate start
         }

         if (control$ && typeof control$.subscribe === 'function') {
            // Subscribe to master/non-master toggle
            const sub: Subscription = control$.subscribe({
               next: (enabled: boolean) => {
                  if (enabled) {
                     initializeScheduledJobs(this);
                  } else {
                     cleanupScheduledJobs(this);
                  }
               },
               error: (err: any) => {
                  Logger.error(`control$ error: ${err instanceof Error ? err.message : String(err)}`, ctorName);
               },
            });

            Object.defineProperty(this, SCHEDULE_CONTROL_SUB, {
               value: sub,
               enumerable: false,
               configurable: false,
               writable: false,
            });
         } else {
            // No control$ detected — start immediately
            initializeScheduledJobs(this);
         }
      };

      // Patch destroy hook to cleanup jobs and subscription
      proto.onModuleDestroy = function (...args: any[]) {
         try {
            cleanupScheduledJobs(this);
            const sub: Subscription | undefined = (this as any)[SCHEDULE_CONTROL_SUB];
            sub?.unsubscribe?.();
         } finally {
            if (typeof origDestroy === 'function') {
               origDestroy.apply(this, args);
            }
         }
      };
   };
}

// ───────────────────────────────────────────────────────────────────────────────
// Start/stop implementation (idempotent, per-instance)
// ───────────────────────────────────────────────────────────────────────────────

/**
 * Initializes all scheduled jobs for the given instance if not already running.
 */
export function initializeScheduledJobs(instance: any): void {
   const ctor = instance?.constructor;
   const defs = getScheduleDefs(ctor);

   if (!defs.length) {
      Logger.log(`No scheduled jobs found for ${ctor?.name ?? 'Unknown'}`, 'Scheduler');
      return;
   }

   const state = getOrCreateState(instance);
   Logger.log(`Initializing ${defs.length} scheduled job(s) for ${ctor.name}`, 'Scheduler');

   for (const def of defs) {
      const key = def.propertyKey;
      const entry = state.get(key) ?? {};
      if (entry.job) {
         // Already scheduled for this instance -> skip
         continue;
      }

      const method = instance[key];
      if (typeof method !== 'function') {
         throw new Error(`Method "${String(key)}" not found on ${ctor.name}`);
      }

      // Create node-schedule job
      let job: Job | undefined;
      try {
         const context = `${ctor.name}.${String(key)}`;
         job = scheduleJob(def.cronExpression, async () => {
            if (def.skipIfRunning && entry.running) {
               // Skip overlapping run to avoid piling up work
               Logger.warn(`Job "${def.name}" skipped (previous run in progress)`, context);
               return;
            }

            entry.running = true;
            const started = Date.now();
            try {
               await Promise.resolve(method.apply(instance));
            } catch (error: any) {
               Logger.error(`Error executing job "${def.name}": ${error instanceof Error ? error.message : String(error)}`, context);
            } finally {
               entry.running = false;
               const elapsed = Date.now() - started;
               Logger.debug(`Job "${def.name}" finished in ${elapsed}ms`, context);
            }
         });
      } catch (e: any) {
         Logger.error(
            `Failed to schedule job "${def.name}" (${String(def.propertyKey)}): ${e instanceof Error ? e.message : String(e)}`,
            ctor.name,
         );
         continue;
      }

      entry.job = job!;
      state.set(key, entry);

      Logger.log(`Scheduled "${def.name}" -> "${String(def.propertyKey)}" with cron "${def.cronExpression}"`, ctor.name);
   }
}

/**
 * Cancels all scheduled jobs for the given instance and clears state.
 */
export function cleanupScheduledJobs(instance: any): void {
   const ctor = instance?.constructor;
   const defs = getScheduleDefs(ctor);
   if (!defs.length) return;

   const state: StateMap | undefined = (instance as any)[SCHEDULE_STATE];
   if (!state || state.size === 0) return;

   Logger.debug(`Cleaning up scheduled jobs for ${ctor.name}`, 'Scheduler');

   for (const [key, entry] of state) {
      try {
         entry.job?.cancel();
      } catch {
         // ignore cancel error; we are destroying anyway
      } finally {
         entry.job = undefined;
         entry.running = false;
         state.set(key, entry);
      }
   }
}
