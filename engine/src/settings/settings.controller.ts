import { Body, Controller, Get, Put } from '@nestjs/common';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { Settings, SettingsView, defaultSettings, settingsSchema } from './settings.model';
import { SettingsService } from './settings.service';

@Controller('settings')
export class SettingsController {
  constructor(private readonly settings: SettingsService) {}

  @Get()
  get(): Promise<SettingsView> {
    return this.settings.view();
  }

  /** Replaces the settings; omitted fields take their defaults. */
  @Put()
  async update(@Body(new ZodValidationPipe(settingsSchema)) input: Settings): Promise<SettingsView> {
    return { settings: await this.settings.update(input), defaults: defaultSettings() };
  }
}
