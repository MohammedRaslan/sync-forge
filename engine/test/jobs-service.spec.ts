import { describe, expect, it } from 'vitest';
import { ConflictError } from '../src/common/errors';
import { ConnectionsService } from '../src/connections/connections.service';
import { Job, JobInput, JobState } from '../src/jobs/job.model';
import { JobStateRepository, JobsRepository } from '../src/jobs/jobs.repository';
import { JobsService } from '../src/jobs/jobs.service';
import { RunLocks } from '../src/jobs/run-locks';

/** In-memory stand-in for a JsonDirectoryStore. */
class MemoryStore<T extends { id: string }> {
  readonly items = new Map<string, T>();
  async list() {
    return [...this.items.values()];
  }
  async get(id: string) {
    return this.items.get(id);
  }
  async save(item: T) {
    this.items.set(item.id, item);
  }
  async delete(id: string) {
    return this.items.delete(id);
  }
}

const input: JobInput = {
  name: 'Orders',
  source: { connectionId: 'legacy', collection: 'public.orders' },
  target: { connectionId: 'newcore', collection: 'public.orders', keyFields: ['id'] },
  mappings: [{ from: 'id', to: 'id', transform: 'none' }],
  mode: 'incremental',
  watermarkField: 'updated_at',
  batchSize: 500,
  errorPolicy: 'fail',
};

function setup() {
  const jobs = new MemoryStore<Job>();
  const states = new MemoryStore<JobState>();
  const locks = new RunLocks();
  const connections = { get: async (id: string) => ({ id }) } as unknown as ConnectionsService;
  const service = new JobsService(jobs as unknown as JobsRepository, states as unknown as JobStateRepository, connections, locks);
  return { service, states, locks };
}

describe('JobsService.update and the watermark', () => {
  it('resets the watermark when an incremental job changes which rows it reads', async () => {
    const { service, states } = setup();
    const job = await service.create(input);
    await service.saveWatermark(job.id, { type: 'date', value: '2025-06-01T00:00:00.000Z' });

    await service.update(job.id, { ...input, source: { ...input.source, filters: [{ field: 'region', op: 'eq', type: 'string', value: 'EU' }] } });

    expect(states.items.has(job.id)).toBe(false);
  });

  it('keeps the watermark for changes that do not affect which rows are read', async () => {
    const { service } = setup();
    const job = await service.create(input);
    await service.saveWatermark(job.id, { type: 'number', value: 7 });

    await service.update(job.id, { ...input, name: 'Orders (renamed)', batchSize: 100 });

    expect(await service.getWatermark(job.id)).toEqual({ type: 'number', value: 7 });
  });

  it('refuses such a change while the job is running', async () => {
    const { service, locks } = setup();
    const job = await service.create(input);
    locks.tryAcquire(job.id);
    await expect(service.update(job.id, { ...input, watermarkField: 'created_at' })).rejects.toBeInstanceOf(ConflictError);
  });
});
