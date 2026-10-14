import { Injectable } from '@nestjs/common';
import { ConflictError } from '../common/errors';
import { SETTINGS_ID, Settings, SettingsView, defaultSettings, settingsSchema } from './settings.model';
import { SettingsRepository } from './settings.repository';

/** Reads and saves the app settings; a missing file means every default. */
@Injectable()
export class SettingsService {
  constructor(private readonly repository: SettingsRepository) {}

  /** The saved settings. A file edited into an invalid state is a conflict (409) that names the file and the field. */
  async get(): Promise<Settings> {
    const stored = await this.repository.get(SETTINGS_ID);
    if (!stored) return defaultSettings();
    // Parsing fills fields added since the file was written and drops the stored id.
    const result = settingsSchema.safeParse(stored);
    if (!result.success) {
      const issue = result.error.issues[0];
      throw new ConflictError(
        `Saved settings in ${this.repository.displayPath} are invalid (${issue.path.join('.')}: ${issue.message}). ` +
          'Save the Settings page again or delete the file.',
      );
    }
    return result.data;
  }

  /** Replaces the settings. Never reads the saved file, so it also repairs one that no longer parses. */
  async update(input: Settings): Promise<Settings> {
    const settings = settingsSchema.parse(input);
    await this.repository.save({ id: SETTINGS_ID, ...settings });
    return settings;
  }

  async view(): Promise<SettingsView> {
    return { settings: await this.get(), defaults: defaultSettings() };
  }
}
