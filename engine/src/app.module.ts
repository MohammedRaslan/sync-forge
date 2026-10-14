import { Controller, Get, Module } from '@nestjs/common';
import { ConnectionsModule } from './connections/connections.module';
import { CoreModule } from './core.module';
import { JobsModule } from './jobs/jobs.module';
import { SettingsModule } from './settings/settings.module';
import { SyncModule } from './sync/sync.module';

@Controller('health')
class HealthController {
  @Get()
  check() {
    return { status: 'ok' };
  }
}

@Module({
  imports: [CoreModule, SettingsModule, ConnectionsModule, JobsModule, SyncModule],
  controllers: [HealthController],
})
export class AppModule {}
