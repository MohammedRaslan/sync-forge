import { Injectable } from '@nestjs/common';
import { ConflictError, NotFoundError } from '../common/errors';
import { createId } from '../common/ids';
import { ConnectionsService } from '../connections/connections.service';
import { StoredWatermark } from '../sync/watermark';
import { buildJobScript } from './job-script';
import { Job, JobInput } from './job.model';
import { JobStateRepository, JobsRepository } from './jobs.repository';
import { RunLocks } from './run-locks';

@Injectable()
export class JobsService {
  constructor(
    private readonly jobs: JobsRepository,
    private readonly states: JobStateRepository,
    private readonly connections: ConnectionsService,
    private readonly locks: RunLocks,
  ) {}

  async list(): Promise<Job[]> {
    return (await this.jobs.list()).sort((a, b) => a.name.localeCompare(b.name));
  }

  async get(id: string): Promise<Job> {
    const job = await this.jobs.get(id);
    if (!job) throw new NotFoundError(`Job "${id}" does not exist`);
    return job;
  }

  async create(input: JobInput): Promise<Job> {
    await this.assertConnectionsExist(input);
    const now = new Date().toISOString();
    const job: Job = { id: createId(input.name), ...input, createdAt: now, updatedAt: now };
    await this.jobs.save(job);
    return job;
  }

  /** Changing which rows an incremental job reads also resets its watermark (see `readsDifferently`). */
  async update(id: string, input: JobInput): Promise<Job> {
    const existing = await this.get(id);
    await this.assertConnectionsExist(input);
    const resetWatermark = readsDifferently(existing, input);
    if (resetWatermark) this.assertNotRunning(id);
    const job: Job = { id, ...input, createdAt: existing.createdAt, updatedAt: new Date().toISOString() };
    await this.jobs.save(job);
    if (resetWatermark) await this.states.delete(id);
    return job;
  }

  async remove(id: string): Promise<void> {
    this.assertNotRunning(id);
    if (!(await this.jobs.delete(id))) throw new NotFoundError(`Job "${id}" does not exist`);
    await this.states.delete(id);
  }

  /** A runnable script for the job, with every connection it uses; secrets are left to environment variables. */
  async exportScript(id: string): Promise<{ fileName: string; content: string }> {
    const job = await this.get(id);
    const views = await Promise.all(connectionIds(job).map((connectionId) => this.connections.get(connectionId)));
    return buildJobScript(job, views, new Date().toISOString().slice(0, 10));
  }

  async getWatermark(id: string): Promise<StoredWatermark | null> {
    return (await this.states.get(id))?.watermark ?? null;
  }

  async saveWatermark(id: string, watermark: StoredWatermark | null): Promise<void> {
    await this.states.save({ id, watermark, updatedAt: new Date().toISOString() });
  }

  async resetWatermark(id: string): Promise<void> {
    await this.get(id);
    this.assertNotRunning(id);
    await this.states.delete(id);
  }

  private assertNotRunning(id: string): void {
    if (this.locks.isLocked(id)) throw new ConflictError('This job is running. Cancel the run first.');
  }

  private async assertConnectionsExist(input: JobInput): Promise<void> {
    await Promise.all(connectionIds(input).map((id) => this.connections.get(id)));
  }
}

/**
 * True when an incremental job now reads a different set of rows (source, query, conditions or watermark).
 * Its saved watermark then has to go: rows the old settings left out may lie behind it and would never be read.
 */
function readsDifferently(before: JobInput, after: JobInput): boolean {
  const readSettings = (job: JobInput) => JSON.stringify([job.source, job.mode, job.watermarkField]);
  return before.mode === 'incremental' && readSettings(before) !== readSettings(after);
}

/** Every connection a job uses: source, target and lookups, each once. */
function connectionIds(job: JobInput): string[] {
  const ids = [job.source.connectionId, job.target.connectionId, ...(job.lookups ?? []).map((lookup) => lookup.connectionId)];
  return [...new Set(ids)];
}
