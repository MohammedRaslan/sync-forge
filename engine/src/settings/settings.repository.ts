import { relative } from 'node:path';
import { JsonDirectoryStore } from '../storage/json-directory-store';
import { Workspace } from '../storage/workspace';
import { SETTINGS_ID, StoredSettings } from './settings.model';

/** The app settings: one JSON file in the workspace's local state. */
export class SettingsRepository extends JsonDirectoryStore<StoredSettings> {
  /** The settings file relative to the workspace, for messages that tell the user which file to fix. */
  readonly displayPath: string;

  constructor(workspace: Workspace) {
    super(workspace.local('settings'));
    this.displayPath = relative(workspace.root, workspace.local('settings', `${SETTINGS_ID}.json`));
  }
}
