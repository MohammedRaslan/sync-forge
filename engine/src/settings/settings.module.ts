import { Global, Module } from '@nestjs/common';
import { Workspace } from '../storage/workspace';
import { SettingsController } from './settings.controller';
import { SettingsRepository } from './settings.repository';
import { SettingsService } from './settings.service';

/** App settings. Global because feature modules (e.g. CSV uploads in connections) read them. */
@Global()
@Module({
  providers: [
    {
      provide: SettingsRepository,
      useFactory: (workspace: Workspace) => new SettingsRepository(workspace),
      inject: [Workspace],
    },
    SettingsService,
  ],
  controllers: [SettingsController],
  exports: [SettingsService],
})
export class SettingsModule {}
