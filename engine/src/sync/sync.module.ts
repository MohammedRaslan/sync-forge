import { Module } from '@nestjs/common';
import { ConnectionsModule } from '../connections/connections.module';
import { JobsModule } from '../jobs/jobs.module';
import { Workspace } from '../storage/workspace';
import { RunsRepository } from './runs.repository';
import { RunsService } from './runs.service';
import { RunsController, SyncController } from './sync.controller';
import { SyncRunner } from './sync-runner';
import { SyncService } from './sync.service';

@Module({
  imports: [ConnectionsModule, JobsModule],
  controllers: [SyncController, RunsController],
  providers: [
    SyncService,
    SyncRunner,
    RunsService,
    {
      provide: RunsRepository,
      useFactory: (workspace: Workspace) => new RunsRepository(workspace.local('runs')),
      inject: [Workspace],
    },
  ],
})
export class SyncModule {}
