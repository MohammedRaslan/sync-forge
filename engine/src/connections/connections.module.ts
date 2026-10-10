import { Module } from '@nestjs/common';
import { Workspace } from '../storage/workspace';
import { ConnectionsController } from './connections.controller';
import { ConnectionsRepository } from './connections.repository';
import { ConnectionsService } from './connections.service';

@Module({
  controllers: [ConnectionsController],
  providers: [
    ConnectionsService,
    {
      provide: ConnectionsRepository,
      useFactory: (workspace: Workspace) => new ConnectionsRepository(workspace.local('connections')),
      inject: [Workspace],
    },
  ],
  exports: [ConnectionsService],
})
export class ConnectionsModule {}
