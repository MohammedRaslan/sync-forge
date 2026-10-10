import { randomBytes } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ID_PATTERN } from '../common/ids';

export interface Identifiable {
  id: string;
}

/**
 * Persists one entity per JSON file. Plain files keep the tool dependency-free,
 * make job specs reviewable in git, and are easy to inspect when something goes wrong.
 * Writes are atomic (write to a temp file, then rename), so a crash never leaves a half-written file.
 */
export class JsonDirectoryStore<T extends Identifiable> {
  constructor(private readonly directory: string) {}

  async list(): Promise<T[]> {
    await mkdir(this.directory, { recursive: true });
    const files = (await readdir(this.directory)).filter((file) => file.endsWith('.json'));
    const entities: Array<T | undefined> = await Promise.all(
      files.map((file) => this.readFile(join(this.directory, file))),
    );
    return entities.filter((entity): entity is T => entity !== undefined);
  }

  async get(id: string): Promise<T | undefined> {
    if (!ID_PATTERN.test(id)) return undefined;
    return this.readFile(this.fileFor(id));
  }

  async save(entity: T): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    const target = this.fileFor(entity.id);
    const temp = `${target}.${randomBytes(4).toString('hex')}.tmp`;
    await writeFile(temp, `${JSON.stringify(entity, null, 2)}\n`, { mode: 0o600 });
    await rename(temp, target);
  }

  async delete(id: string): Promise<boolean> {
    if (!ID_PATTERN.test(id)) return false;
    try {
      await rm(this.fileFor(id));
      return true;
    } catch (error) {
      if (isMissingFile(error)) return false;
      throw error;
    }
  }

  private fileFor(id: string): string {
    if (!ID_PATTERN.test(id)) throw new Error(`Invalid id "${id}"`);
    return join(this.directory, `${id}.json`);
  }

  private async readFile(file: string): Promise<T | undefined> {
    try {
      return JSON.parse(await readFile(file, 'utf8')) as T;
    } catch (error) {
      if (isMissingFile(error)) return undefined;
      throw new Error(`Could not read ${file}: ${(error as Error).message}`);
    }
  }
}

function isMissingFile(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === 'ENOENT';
}
