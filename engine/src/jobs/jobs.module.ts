import { Module } from '@nestjs/common';
import { ConnectionsModule } from '../connections/connections.module';
import { Workspace } from '../storage/workspace';
import { TransformsController } from '../transforms/transforms.controller';
import { JobsController } from './jobs.controller';
import { JobStateRepository, JobsRepository } from './jobs.repository';
import { JobsService } from './jobs.service';
import { RunLocks } from './run-locks';

@Module({
  imports: [ConnectionsModule],
  controllers: [JobsController, TransformsController],
  providers: [
    JobsService,
    RunLocks,
    {
      provide: JobsRepository,
      useFactory: (workspace: Workspace) => new JobsRepository(workspace.jobsDir),
      inject: [Workspace],
    },
    {
      provide: JobStateRepository,
      useFactory: (workspace: Workspace) => new JobStateRepository(workspace.local('state')),
      inject: [Workspace],
    },
  ],
  exports: [JobsService, RunLocks],
})
export class JobsModule {}
