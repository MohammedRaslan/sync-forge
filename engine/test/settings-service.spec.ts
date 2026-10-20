import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ConflictError } from '../src/common/errors';
import { defaultSettings, settingsSchema } from '../src/settings/settings.model';
import { SettingsRepository } from '../src/settings/settings.repository';
import { SettingsService } from '../src/settings/settings.service';
import { Workspace } from '../src/storage/workspace';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'syncforge-settings-'));
  dirs.push(root);
  const workspace = new Workspace(root);
  return { workspace, service: new SettingsService(new SettingsRepository(workspace)) };
}

/** Writes the settings file by hand, as an older version or a manual edit would. */
async function writeSettingsFile(workspace: Workspace, content: unknown): Promise<void> {
  await mkdir(workspace.local('settings'), { recursive: true });
  await writeFile(workspace.local('settings', 'app.json'), JSON.stringify(content));
}

async function failure(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error('expected a failure');
}

describe('SettingsService', () => {
  it('gives the defaults when no settings were saved', async () => {
    const { service } = await setup();
    expect(await service.get()).toEqual({ defaultBatchSize: 500, csvMaxUploadMb: 100, httpMaxResponseMb: 50 });
  });

  it('keeps saved settings for the next read', async () => {
    const { service } = await setup();
    await service.update({ defaultBatchSize: 2000, csvMaxUploadMb: 50, httpMaxResponseMb: 8 });
    expect(await service.get()).toEqual({ defaultBatchSize: 2000, csvMaxUploadMb: 50, httpMaxResponseMb: 8 });
  });

  it('fills fields missing from an older settings file with their defaults', async () => {
    const { workspace, service } = await setup();
    await writeSettingsFile(workspace, { id: 'app', defaultBatchSize: 250 });
    expect(await service.get()).toEqual({ defaultBatchSize: 250, csvMaxUploadMb: 100, httpMaxResponseMb: 50 });
  });

  it('reports a damaged settings file as a conflict that names the file and the field', async () => {
    const { workspace, service } = await setup();
    await writeSettingsFile(workspace, { id: 'app', csvMaxUploadMb: 'lots' });
    const error = await failure(service.get());
    expect(error).toBeInstanceOf(ConflictError);
    expect(error.message).toBe(
      `Saved settings in ${join('.local', 'settings', 'app.json')} are invalid (csvMaxUploadMb: Expected number, received nan). ` +
        'Save the Settings page again or delete the file.',
    );
  });

  it('saves new settings over a damaged settings file without reading it', async () => {
    const { workspace, service } = await setup();
    await writeSettingsFile(workspace, { id: 'app', defaultBatchSize: -1 });
    expect(await service.update(defaultSettings())).toEqual(defaultSettings());
    expect(await service.get()).toEqual(defaultSettings());
  });

  it('returns current values with the defaults in its view', async () => {
    const { service } = await setup();
    await service.update({ defaultBatchSize: 10, csvMaxUploadMb: 1, httpMaxResponseMb: 1 });
    expect(await service.view()).toEqual({
      settings: { defaultBatchSize: 10, csvMaxUploadMb: 1, httpMaxResponseMb: 1 },
      defaults: defaultSettings(),
    });
  });
});

describe('settingsSchema', () => {
  it('rejects values out of range', () => {
    expect(settingsSchema.safeParse({ defaultBatchSize: 0 }).success).toBe(false);
    expect(settingsSchema.safeParse({ defaultBatchSize: 10_001 }).success).toBe(false);
    expect(settingsSchema.safeParse({ csvMaxUploadMb: 513 }).success).toBe(false);
    expect(settingsSchema.safeParse({ csvMaxUploadMb: 512 }).success).toBe(true);
    expect(settingsSchema.safeParse({ csvMaxUploadMb: 1.5 }).success).toBe(false);
    expect(settingsSchema.safeParse({ httpMaxResponseMb: 0 }).success).toBe(false);
    expect(settingsSchema.safeParse({ httpMaxResponseMb: 513 }).success).toBe(false);
    expect(settingsSchema.safeParse({ httpMaxResponseMb: 512 }).success).toBe(true);
  });

  it('drops keys it does not know, so a newer settings file still loads', () => {
    expect(settingsSchema.parse({ futureSetting: true })).toEqual(defaultSettings());
  });
});
