import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Layout of the folder that holds everything Syncforge persists:
 *
 *   workspace/
 *     jobs/          job specs (plain JSON, meant to be committed and reviewed)
 *     .local/        machine-specific state, never committed
 *       secret.key   encryption key for connection credentials
 *       connections/ encrypted connection settings
 *       runs/        run history
 *       state/       incremental watermarks per job
 */
export class Workspace {
  constructor(readonly root: string) {}

  get jobsDir(): string {
    return join(this.root, 'jobs');
  }

  local(...segments: string[]): string {
    return join(this.root, '.local', ...segments);
  }

  async prepare(): Promise<void> {
    await Promise.all(
      [this.jobsDir, this.local('connections'), this.local('runs'), this.local('state')].map((dir) =>
        mkdir(dir, { recursive: true }),
      ),
    );
    await this.ensureGitignore();
  }

  private async ensureGitignore(): Promise<void> {
    const file = join(this.root, '.gitignore');
    const existing = await readFile(file, 'utf8').catch(() => '');
    if (!existing.split('\n').includes('.local/')) {
      await writeFile(file, `${existing}${existing && !existing.endsWith('\n') ? '\n' : ''}.local/\n`);
    }
  }
}
