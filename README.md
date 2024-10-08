# @knaus94/nestjs-schedule-decorators

## Installation

```bash
npm install @knaus94/nestjs-schedule-decorators @nestjs/schedule
```

## Usage
```typescript
import { Injectable, Logger } from '@nestjs/common';
import { OnApplicationBootstrap } from '@nestjs/common';
import { SchedulerRegistry, CronExpression } from '@nestjs/schedule';
import { MasterNodeService } from '@master-node/master-node.service';
import { initializeScheduledJobs, cleanupScheduledJobs, ScheduleJob } from '@knaus94/nestjs-schedule-decorators';

@Injectable()
export class YourService implements OnApplicationBootstrap {
   private readonly logger = new Logger(YourService.name);

   constructor(
      private readonly masterNodeService: MasterNodeService,
      private readonly schedulerRegistry: SchedulerRegistry,
   ) {}

   async onApplicationBootstrap() {
      this.masterNodeService.isMaster$
         .pipe(
            tap((isMaster) => {
               if (isMaster) {
                  initializeScheduledJobs(this, this.schedulerRegistry);
               } else {
                  cleanupScheduledJobs(this, this.schedulerRegistry);
               }
            }),
         )
         .subscribe();
   }

   @ScheduleJob('test-func', CronExpression.EVERY_DAY_AT_4AM)
   async test() {
      console.log('running');
   }
}
```
