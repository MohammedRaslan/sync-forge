import { Module } from '@nestjs/common';
import { ConnectionsModule } from '../connections/connections.module';
import { JobsModule } from '../jobs/jobs.module';
import { Workspace } from '../storage/workspace';
import { ReconcilesRepository } from './reconciles.repository';
import { ReconcilesService } from './reconciles.service';
import { RunsRepository } from './runs.repository';
import { RunsService } from './runs.service';
import { ReconcilesController, RunsController, SyncController } from './sync.controller';
import { SyncRunner } from './sync-runner';
import { SyncService } from './sync.service';

@Module({
  imports: [ConnectionsModule, JobsModule],
  controllers: [SyncController, RunsController, ReconcilesController],
  providers: [
    SyncService,
    SyncRunner,
    RunsService,
    ReconcilesService,
    {
      provide: RunsRepository,
      useFactory: (workspace: Workspace) => new RunsRepository(workspace.local('runs')),
      inject: [Workspace],
    },
    {
      provide: ReconcilesRepository,
      useFactory: (workspace: Workspace) => new ReconcilesRepository(workspace.local('reconciles')),
      inject: [Workspace],
    },
  ],
})
export class SyncModule {}
