import { describe, expect, it } from 'vitest';
import { ConflictError, NotFoundError, ValidationError } from '../src/common/errors';
import { DataReader, DataWriter, KeyReader, Row } from '../src/connectors/connector.types';
import { Job } from '../src/jobs/job.model';
import { JobsService } from '../src/jobs/jobs.service';
import { RunLocks } from '../src/jobs/run-locks';
import { LookupEnricher } from '../src/sync/lookup-enricher';
import { RowMapper } from '../src/sync/row-mapper';
import { RunRecord } from '../src/sync/run.model';
import { RunsRepository } from '../src/sync/runs.repository';
import { RunsService } from '../src/sync/runs.service';
import { SyncRunner } from '../src/sync/sync-runner';
import { Pipeline, SyncService } from '../src/sync/sync.service';
import { StoredWatermark } from '../src/sync/watermark';
import { TransformRegistry } from '../src/transforms/transform.registry';

const job: Job = {
  id: 'job-1',
  name: 'Orders',
  source: { connectionId: 'a', collection: 'src' },
  target: { connectionId: 'b', collection: 'dst', keyFields: ['id'] },
  mappings: [{ from: 'id', to: 'id', transform: 'none' }],
  mode: 'incremental',
  watermarkField: 'updated',
  batchSize: 10,
  errorPolicy: 'fail',
  createdAt: '',
  updatedAt: '',
};

/** `current.job` is what JobsService returns, so a test can change the job between runs; `source` is the source table. */
function setup(initialJob: Job = job, initialRows: Row[] = [{ id: 1, updated: 10 }, { id: 2, updated: 20 }]) {
  const current = { job: initialJob, source: initialRows };
  const saved: Array<StoredWatermark | null> = [];
  const written: Row[] = [];
  const records = new Map<string, RunRecord>();
  const reader: DataReader & KeyReader = {
    async *readBatches() {
      yield current.source;
    },
    count: async () => current.source.length,
    findByKeys: async (_collection: string, fields: string[], keys: Row[]) =>
      current.source.filter((row) => keys.some((key) => fields.every((field) => key[field] === row[field]))),
  };
  const target = {
    upsert: async (_collection: string, rows: Row[]) => void written.push(...rows),
    findByKeys: async () => [],
  } satisfies DataWriter;
  const jobs = {
    get: async () => current.job,
    getWatermark: async () => ({ type: 'number', value: 5 }),
    saveWatermark: async (_id: string, watermark: StoredWatermark | null) => void saved.push(watermark),
  } as unknown as JobsService;
  const sync = {
    withPipeline: <T>(opened: Job, work: (pipeline: Pipeline) => Promise<T>) =>
      work({
        source: reader,
        target,
        sourceConnection: { kind: 'postgres' },
        targetConnection: { kind: 'postgres' },
        mapper: RowMapper.compile(opened.mappings, new TransformRegistry()),
        enricher: LookupEnricher.none,
      } as unknown as Pipeline),
  } as unknown as SyncService;
  const runs = {
    save: async (run: RunRecord) => void records.set(run.id, structuredClone(run)),
    list: async () => [...records.values()],
    get: async (id: string) => records.get(id),
    delete: async (id: string) => records.delete(id),
  } as unknown as RunsRepository;
  const service = new RunsService(runs, jobs, new RunLocks(), sync, new SyncRunner());

  const finished = async (id: string) => {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const run = await service.get(id);
      if (run.status !== 'running') return run;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('run did not finish');
  };
  const store = (run: Partial<RunRecord> & Pick<RunRecord, 'id'>) =>
    records.set(run.id, {
      jobId: job.id,
      jobName: job.name,
      mode: 'full',
      status: 'succeeded',
      startedAt: '2025-01-01T00:00:00.000Z',
      finishedAt: '2025-01-01T00:01:00.000Z',
      stats: { read: 1, written: 0, skipped: 1, batches: 1 },
      watermarkFrom: null,
      watermarkTo: null,
      error: null,
      log: [],
      failures: [{ row: 1, key: '1', stage: 'write', reason: 'refused', sourceKey: { id: 1 } }],
      ...run,
    });
  return { service, current, saved, written, finished, store };
}

describe('RunsService dry runs', () => {
  it('never writes and never moves the watermark', async () => {
    const { service, saved, written, finished } = setup();
    const run = await finished((await service.start(job.id, { dryRun: true })).id);

    expect(run).toMatchObject({ status: 'succeeded', dryRun: true, watermarkFrom: { type: 'number', value: 5 } });
    expect(run.watermarkTo).toEqual(run.watermarkFrom);
    expect(run.plan).toMatchObject({ inserts: 2, updates: 0 });
    expect(saved).toEqual([]);
    expect(written).toEqual([]);
  });

  it('saves the watermark on a real run', async () => {
    const { service, saved, written, finished } = setup();
    const run = await finished((await service.start(job.id)).id);

    expect(run.status).toBe('succeeded');
    expect(saved).toEqual([{ type: 'number', value: 20 }]);
    expect(written).toHaveLength(2);
  });
});

describe('RunsService retrying failed rows', () => {
  const skipJob: Job = {
    ...job,
    errorPolicy: 'skip',
    mappings: [
      { from: 'id', to: 'id', transform: 'none' },
      { from: 'qty', to: 'quantity', transform: 'number' },
    ],
  };
  const rows = [
    { id: 1, qty: '1', updated: 10 },
    { id: 2, qty: 'oops', updated: 20 },
    { id: 3, qty: '3', updated: 30 },
  ];
  const fixed: Job = { ...skipJob, mappings: [skipJob.mappings[0], { from: 'qty', to: 'quantity', transform: 'none' }] };

  it('reads only the failed rows again, writes them with the current mappings and leaves the watermark alone', async () => {
    const { service, current, saved, written, finished } = setup(skipJob, rows);
    const first = await finished((await service.start(job.id)).id);
    expect(first.failures).toEqual([{ row: 2, key: null, stage: 'map', reason: '"quantity": "oops" is not a number', sourceKey: { id: 2 } }]);
    expect(saved).toEqual([{ type: 'number', value: 30 }]);

    current.job = fixed;
    written.length = 0;
    const retry = await finished((await service.start(job.id, { retryOf: first.id })).id);

    expect(retry).toMatchObject({ status: 'succeeded', retryOf: first.id, watermarkFrom: null, watermarkTo: null, failures: [] });
    expect(retry.stats).toEqual({ read: 1, written: 1, skipped: 0, batches: 1 });
    expect(written).toEqual([{ id: 2, quantity: 'oops' }]);
    expect(saved).toEqual([{ type: 'number', value: 30 }]);
    expect(retry.log[0].message).toBe(`Retrying 1 failed rows of run ${first.id} from ${first.startedAt.slice(0, 16).replace('T', ' ')} UTC, read again from the source by id`);
  });

  it('lists rows that still fail with their source key, so a retry can be retried', async () => {
    const { service, current, written, finished } = setup(skipJob, rows);
    const first = await finished((await service.start(job.id)).id);
    const second = await finished((await service.start(job.id, { retryOf: first.id })).id);
    expect(second.stats).toMatchObject({ read: 1, written: 0, skipped: 1 });
    expect(second.failures).toEqual([{ row: 1, key: null, stage: 'map', reason: '"quantity": "oops" is not a number', sourceKey: { id: 2 } }]);
    // A retry never reads the watermark, so its skipped rows are not behind it.
    expect(second.log.some((entry) => entry.message.includes('behind the watermark'))).toBe(false);

    current.job = fixed;
    written.length = 0;
    const third = await finished((await service.start(job.id, { retryOf: second.id })).id);
    expect(third).toMatchObject({ status: 'succeeded', retryOf: second.id });
    expect(written).toEqual([{ id: 2, quantity: 'oops' }]);
  });

  it('lists rows the source no longer has as read failures, which can be retried later', async () => {
    const { service, current, written, finished } = setup(skipJob, rows);
    const first = await finished((await service.start(job.id)).id);
    current.source = rows.filter((row) => row.id !== 2);
    written.length = 0;
    const retry = await finished((await service.start(job.id, { retryOf: first.id })).id);

    expect(retry.status).toBe('succeeded');
    expect(retry.stats).toMatchObject({ read: 0, written: 0, skipped: 0 });
    expect(written).toEqual([]);
    expect(retry.failures).toEqual([{ row: 1, key: null, stage: 'read', reason: 'No longer in the source', sourceKey: { id: 2 } }]);
    expect(retry.log.map((entry) => entry.message)).toContain('1 rows are no longer in the source: 2');
  });

  it('says how many failures cannot be retried and how many the run did not keep', async () => {
    const { service, store, finished } = setup(skipJob, rows);
    store({
      id: 'run-old',
      stats: { read: 600, written: 0, skipped: 600, batches: 1 },
      failures: [
        { row: 1, key: null, stage: 'map', reason: 'bad', sourceKey: { id: 2 } },
        { row: 2, key: null, stage: 'map', reason: 'bad' },
        { row: 3, key: null, stage: 'map', reason: 'bad', sourceKey: { code: 'x' } },
      ],
    });
    const retry = await finished((await service.start(job.id, { retryOf: 'run-old' })).id);
    const messages = retry.log.map((entry) => entry.message);
    expect(messages[0]).toMatch(/^Retrying 1 failed rows of run run-old from 2025-01-01 00:00 UTC/);
    expect(messages[1]).toMatch(/^2 failed rows cannot be retried: they were recorded by an older version/);
    expect(messages[2]).toBe('597 more rows failed in that run but were not kept with it (it keeps the first 500); run the job again to cover them');
  });

  it('keeps the retried run as the job\'s latest run in overviews', async () => {
    const { service, current, finished } = setup(skipJob, rows);
    const first = await finished((await service.start(job.id)).id);
    current.job = fixed;
    await finished((await service.start(job.id, { retryOf: first.id })).id);
    expect((await service.latestByJob())[job.id].id).toBe(first.id);
  });

  describe('refuses', () => {
    it('a retry that is also a dry run', async () => {
      const { service, store } = setup(skipJob, rows);
      store({ id: 'run-old' });
      await expect(service.start(job.id, { retryOf: 'run-old', dryRun: true })).rejects.toThrow(ValidationError);
    });

    it('an unknown run, a run of another job, a run in progress and a dry run', async () => {
      const { service, store } = setup(skipJob, rows);
      store({ id: 'run-other', jobId: 'job-2' });
      store({ id: 'run-busy', status: 'running' });
      store({ id: 'run-dry', dryRun: true });
      await expect(service.start(job.id, { retryOf: 'run-missing' })).rejects.toThrow(NotFoundError);
      await expect(service.start(job.id, { retryOf: 'run-other' })).rejects.toThrow('Run "run-other" belongs to another job');
      await expect(service.start(job.id, { retryOf: 'run-busy' })).rejects.toThrow(ConflictError);
      await expect(service.start(job.id, { retryOf: 'run-dry' })).rejects.toThrow("A dry run writes nothing, so its failed rows can't be re-run");
    });

    it('a run without failed rows, or whose failures have no usable source key', async () => {
      const { service, store } = setup(skipJob, rows);
      store({ id: 'run-clean', failures: [] });
      store({ id: 'run-older', failures: undefined });
      store({ id: 'run-unkeyed', failures: [{ row: 1, key: null, stage: 'map', reason: 'bad' }] });
      await expect(service.start(job.id, { retryOf: 'run-clean' })).rejects.toThrow('Run "run-clean" has no failed rows to re-run');
      await expect(service.start(job.id, { retryOf: 'run-older' })).rejects.toThrow('has no failed rows to re-run');
      await expect(service.start(job.id, { retryOf: 'run-unkeyed' })).rejects.toThrow('None of the 1 failed rows of run "run-unkeyed" can be re-run');
    });

    it('a job whose rows cannot be fetched by key, and releases the lock afterwards', async () => {
      const { service, current, store, finished } = setup(skipJob, rows);
      store({ id: 'run-old' });
      current.job = { ...skipJob, source: { ...skipJob.source, query: 'SELECT * FROM src' } };
      await expect(service.start(job.id, { retryOf: 'run-old' })).rejects.toThrow(
        "Failed rows can't be re-run: rows of a SQL query source can't be fetched by key",
      );
      current.job = { ...skipJob, mappings: [{ from: 'id', to: 'id', transform: 'expression', argument: 'value' }] };
      await expect(service.start(job.id, { retryOf: 'run-old' })).rejects.toThrow('key field "id" is set by an expression');

      current.job = skipJob;
      expect((await finished((await service.start(job.id)).id)).status).toBe('succeeded');
    });
  });
});
