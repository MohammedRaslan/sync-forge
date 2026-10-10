import { describe, expect, it } from 'vitest';
import { DataReader, DataWriter, Row } from '../src/connectors/connector.types';
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

function setup() {
  const saved: Array<StoredWatermark | null> = [];
  const written: Row[] = [];
  const records = new Map<string, RunRecord>();
  const reader: DataReader = {
    async *readBatches() {
      yield [{ id: 1, updated: 10 }, { id: 2, updated: 20 }];
    },
    count: async () => 2,
  };
  const target = {
    upsert: async (_collection: string, rows: Row[]) => void written.push(...rows),
    findByKeys: async () => [],
  } satisfies DataWriter;
  const jobs = {
    get: async () => job,
    getWatermark: async () => ({ type: 'number', value: 5 }),
    saveWatermark: async (_id: string, watermark: StoredWatermark | null) => void saved.push(watermark),
  } as unknown as JobsService;
  const sync = {
    withPipeline: <T>(_job: Job, work: (pipeline: Pipeline) => Promise<T>) =>
      work({
        source: reader,
        target,
        targetConnection: { kind: 'postgres' },
        mapper: RowMapper.compile(job.mappings, new TransformRegistry()),
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
  return { service, saved, written, finished };
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
