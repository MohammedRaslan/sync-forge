import { Module } from '@nestjs/common';
import { Workspace } from '../storage/workspace';
import { ConnectionsController } from './connections.controller';
import { ConnectionsRepository } from './connections.repository';
import { ConnectionsService } from './connections.service';
import { CsvFileStore } from './csv-file-store';

@Module({
  controllers: [ConnectionsController],
  providers: [
    ConnectionsService,
    CsvFileStore,
    {
      provide: ConnectionsRepository,
      useFactory: (workspace: Workspace) => new ConnectionsRepository(workspace.local('connections')),
      inject: [Workspace],
    },
  ],
  exports: [ConnectionsService],
})
export class ConnectionsModule {}
