import { describe, expect, it } from 'vitest';
import { ValidationError } from '../src/common/errors';
import { ConnectionKind, ConnectionView } from '../src/connections/connection.model';
import { Connector } from '../src/connectors/connector.types';
import { JobInput, jobInputSchema } from '../src/jobs/job.model';
import { ConnectionOpener, SyncService } from '../src/sync/sync.service';
import { TransformRegistry } from '../src/transforms/transform.registry';

/** The kind of each connection a test job can use. */
const KINDS: Record<string, ConnectionKind> = { files: 'csv', pg: 'postgres', mongo: 'mongo', api: 'http' };

/** A SyncService whose connectors fail if read: the rules must refuse a job before any row is read. */
function setup() {
  const opener: ConnectionOpener = {
    async open(id: string) {
      const view: ConnectionView = { id, name: id, kind: KINDS[id], summary: id, settings: {}, hasSecret: false, createdAt: '', updatedAt: '' };
      const connector = {
        close: async () => undefined,
        readBatches: () => {
          throw new Error('the rules must refuse the job before reading');
        },
      } as unknown as Connector;
      return { connector, view };
    },
  };
  return new SyncService(opener, new TransformRegistry());
}

function makeJob(overrides: Partial<JobInput> = {}): JobInput {
  return jobInputSchema.parse({
    name: 'Customers',
    source: { connectionId: 'files', collection: 'customers.csv' },
    target: { connectionId: 'pg', collection: 'public.customers', keyFields: ['id'] },
    mappings: [{ from: 'id', to: 'id', transform: 'none' }],
    ...overrides,
  });
}

async function refusal(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error('expected the job to be refused');
}

describe('rules that depend on the kinds of connection a job uses', () => {
  it('runs a CSV source in full mode only', async () => {
    const job = makeJob({ mode: 'incremental', watermarkField: 'updated_at' });
    const error = await refusal(setup().preview(job));
    expect(error).toBeInstanceOf(ValidationError);
    expect(error.message).toBe('CSV sources run in full mode: each upload replaces the file, and upserts make re-running it safe');

    const sourceOnly = await refusal(setup().previewSource({ ...job, lookups: [] }));
    expect(sourceOnly.message).toMatch(/^CSV sources run in full mode/);
  });

  it('refuses a CSV connection as the target', async () => {
    const job = makeJob({
      source: { connectionId: 'mongo', collection: 'customers' },
      target: { connectionId: 'files', collection: 'customers.csv', keyFields: ['id'] },
    });
    const error = await refusal(setup().preview(job));
    expect(error).toBeInstanceOf(ValidationError);
    expect(error.message).toBe('CSV connections can be a source or a lookup, not a target, for now');
  });

  it('refuses a SQL query source on a CSV connection', async () => {
    const job = makeJob({ source: { connectionId: 'files', collection: 'q', query: 'SELECT 1' } });
    expect((await refusal(setup().preview(job))).message).toBe('Custom SQL queries are only supported for PostgreSQL and MySQL sources');
  });

  it('runs an HTTP API source in full mode only', async () => {
    const job = makeJob({ source: { connectionId: 'api', collection: 'users' }, mode: 'incremental', watermarkField: 'updatedAt' });
    const error = await refusal(setup().preview(job));
    expect(error).toBeInstanceOf(ValidationError);
    expect(error.message).toBe('HTTP API sources run in full mode: each run fetches every page, and upserts make re-running it safe');
    expect((await refusal(setup().previewSource({ ...job, lookups: [] }))).message).toMatch(/^HTTP API sources run in full mode/);
  });

  it('refuses an HTTP API connection as the target', async () => {
    const job = makeJob({
      source: { connectionId: 'mongo', collection: 'customers' },
      target: { connectionId: 'api', collection: 'users', keyFields: ['id'] },
    });
    const error = await refusal(setup().preview(job));
    expect(error).toBeInstanceOf(ValidationError);
    expect(error.message).toBe('HTTP API connections can be a source or a lookup, not a target');
  });

  it('refuses a SQL query source on an HTTP API connection', async () => {
    const job = makeJob({ source: { connectionId: 'api', collection: 'q', query: 'SELECT 1' } });
    expect((await refusal(setup().preview(job))).message).toBe('Custom SQL queries are only supported for PostgreSQL and MySQL sources');
    const sourceOnly = await refusal(setup().previewSource({ ...job, lookups: [] }));
    expect(sourceOnly.message).toBe('Custom SQL queries are only supported for PostgreSQL and MySQL sources');
  });

  it('refuses an HTTP API target from a run or a reconcile too, which share the pipeline', async () => {
    const job = makeJob({
      source: { connectionId: 'mongo', collection: 'customers' },
      target: { connectionId: 'api', collection: 'users', keyFields: ['id'] },
    });
    const error = await refusal(setup().withPipeline(job, async () => 'never reached'));
    expect(error.message).toBe('HTTP API connections can be a source or a lookup, not a target');
    const saved = { ...job, id: 'customers-1', createdAt: '', updatedAt: '' };
    expect((await refusal(setup().reconcile(saved))).message).toBe('HTTP API connections can be a source or a lookup, not a target');
  });
});
