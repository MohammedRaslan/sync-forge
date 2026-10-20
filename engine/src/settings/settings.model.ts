import { z } from 'zod';

/** Bounds of a batch size, shared by the app settings and every job's `batchSize`. */
export const BATCH_SIZE_MIN = 1;
export const BATCH_SIZE_MAX = 10_000;
export const BATCH_SIZE_DEFAULT = 500;

/**
 * App-wide settings, machine-local. Every field has a default, so an older or partial settings file
 * still parses and new fields need no migration. Unknown keys are stripped (zod's default) rather than
 * rejected, so a file written by a newer version still loads.
 */
export const settingsSchema = z.object({
  /** Batch size a new job starts with. */
  defaultBatchSize: z.coerce.number().int().min(BATCH_SIZE_MIN).max(BATCH_SIZE_MAX).default(BATCH_SIZE_DEFAULT),
  /**
   * Largest CSV file accepted on upload, in megabytes. A CSV used as a lookup is held in memory as parsed rows,
   * roughly 5 times its size, so this also bounds memory: 512 MB already needs about 2.5 GB.
   */
  csvMaxUploadMb: z.coerce.number().int().min(1).max(512).default(100),
  /**
   * Largest HTTP API response read, in megabytes. A lookup on an endpoint holds every page in memory,
   * so this also bounds what one lookup can take.
   */
  httpMaxResponseMb: z.coerce.number().int().min(1).max(512).default(50),
});

export type Settings = z.infer<typeof settingsSchema>;

/** What `GET /settings` and `PUT /settings` return: the current values and the defaults to reset to. */
export interface SettingsView {
  settings: Settings;
  defaults: Settings;
}

/** The settings as stored: one file whose id is fixed. */
export interface StoredSettings extends Settings {
  id: typeof SETTINGS_ID;
}

export const SETTINGS_ID = 'app';

/** Defaults, derived from the schema so they cannot drift from it. */
export function defaultSettings(): Settings {
  return settingsSchema.parse({});
}
