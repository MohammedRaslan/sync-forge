import { describe, expect, it } from 'vitest';
import { DataReader, DataWriter, ReadRequest, Row } from '../src/connectors/connector.types';
import { Job } from '../src/jobs/job.model';
import { LookupEnricher } from '../src/sync/lookup-enricher';
import { RowMapper } from '../src/sync/row-mapper';
import { RowFailure, RunCancelledError, RunHooks, SyncRunner, dedupeByKey } from '../src/sync/sync-runner';
import { StoredWatermark } from '../src/sync/watermark';
import { TransformRegistry } from '../src/transforms/transform.registry';

class MemoryReader implements DataReader {
  requests: ReadRequest[] = [];
  constructor(private readonly batches: Row[][]) {}
  async *readBatches(request: ReadRequest) {
    this.requests.push(request);
    for (const batch of this.batches) yield batch;
  }
  async count() {
    return this.batches.flat().length;
  }
}

/** Writes all rows of a call or none, like a Postgres batch in one transaction. */
class MemoryWriter implements DataWriter {
  written: Row[] = [];
  /** Returns an error message for rows the "database" refuses. */
  reject: (row: Row, written: Row[]) => string | undefined = () => undefined;
  async upsert(_collection: string, rows: Row[]) {
    const refused = rows.map((row) => this.reject(row, this.written)).find(Boolean);
    if (refused) throw new Error(refused);
    this.written.push(...rows);
  }
  async findByKeys() {
    return [];
  }
}

function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: 'job-1',
    name: 'Job',
    source: { connectionId: 'a', collection: 'src' },
    target: { connectionId: 'b', collection: 'dst', keyFields: ['id'] },
    mappings: [
      { from: 'id', to: 'id', transform: 'none' },
      { from: 'qty', to: 'quantity', transform: 'number' },
    ],
    mode: 'full',
    batchSize: 2,
    errorPolicy: 'fail',
    createdAt: '',
    updatedAt: '',
    ...overrides,
  };
}

function setup(job: Job, batches: Row[][], enricher = LookupEnricher.none) {
  const reader = new MemoryReader(batches);
  const writer = new MemoryWriter();
  const checkpoints: Array<StoredWatermark | null> = [];
  const logs: string[] = [];
  const failures: RowFailure[] = [];
  const hooks: RunHooks = {
    log: (_level, message) => logs.push(message),
    onBatchWritten: async (_stats, checkpoint) => {
      checkpoints.push(checkpoint);
    },
    onRowFailed: (failure) => failures.push(failure),
  };
  const mapper = RowMapper.compile(job.mappings, new TransformRegistry());
  const run = (signal = new AbortController().signal, from: StoredWatermark | null = null) =>
    new SyncRunner().run({ job, source: reader, target: writer, mapper, enricher, from, signal, hooks });
  return { reader, writer, checkpoints, logs, failures, run };
}

describe('SyncRunner', () => {
  it('maps and writes every batch', async () => {
    const { writer, run } = setup(makeJob(), [[{ id: 1, qty: '2' }, { id: 2, qty: '3' }], [{ id: 3, qty: '4' }]]);
    const { stats } = await run();
    expect(stats).toEqual({ read: 3, written: 3, skipped: 0, batches: 2 });
    expect(writer.written).toEqual([
      { id: 1, quantity: 2 },
      { id: 2, quantity: 3 },
      { id: 3, quantity: 4 },
    ]);
  });

  it('fails the run on a bad row by default', async () => {
    const { run } = setup(makeJob(), [[{ id: 1, qty: 'oops' }]]);
    await expect(run()).rejects.toThrow('Row 1: "quantity": "oops" is not a number');
  });

  it('skips bad rows and rows without a key when asked to', async () => {
    const { writer, failures, run } = setup(makeJob({ errorPolicy: 'skip' }), [[{ id: 1, qty: 'oops' }, { id: null, qty: '1' }, { id: 3, qty: '1' }]]);
    const { stats } = await run();
    expect(stats.skipped).toBe(2);
    expect(writer.written).toEqual([{ id: 3, quantity: 1 }]);
    expect(failures).toEqual([
      { row: 1, key: null, stage: 'map', reason: '"quantity": "oops" is not a number' },
      { row: 2, key: null, stage: 'map', reason: 'key field "id" is empty' },
    ]);
  });

  it('checkpoints the watermark of the last row of each batch', async () => {
    const job = makeJob({ mode: 'incremental', watermarkField: 'updated' });
    const { reader, checkpoints, run } = setup(job, [
      [{ id: 1, qty: 1, updated: 10 }, { id: 2, qty: 1, updated: 20 }],
      [{ id: 3, qty: 1, updated: 30 }],
    ]);
    const { watermark } = await run(undefined, { type: 'number', value: 5 });
    expect(reader.requests[0].watermark).toEqual({ field: 'updated', from: { type: 'number', value: 5 } });
    expect(checkpoints).toEqual([
      { type: 'number', value: 20 },
      { type: 'number', value: 30 },
    ]);
    expect(watermark).toEqual({ type: 'number', value: 30 });
  });

  describe('a date watermark saved by an older engine', () => {
    const job = makeJob({ mode: 'incremental', watermarkField: 'updated' });
    const legacy: StoredWatermark = { type: 'date', value: '2025-03-03T04:30:00.000Z' };
    const movedBack: StoredWatermark = { type: 'date', value: '2025-03-02T14:30:00.000Z', utc: true };

    it('starts 14 hours earlier, says so once, and saves the moved-back start when no row is read', async () => {
      const { reader, checkpoints, logs, run } = setup(job, []);
      const { watermark } = await run(undefined, legacy);
      expect(reader.requests[0].watermark).toEqual({ field: 'updated', from: movedBack });
      expect(logs.filter((line) => line.includes('older version'))).toEqual([
        'Reading rows where updated >= 2025-03-02T14:30:00.000Z (watermark saved by an older version: starting 14 h earlier to be safe)',
      ]);
      expect(checkpoints).toEqual([movedBack]);
      expect(watermark).toEqual(movedBack);
    });

    it('resumes the saved moved-back start exactly, without shifting it again or saving it again', async () => {
      const { reader, checkpoints, logs, run } = setup(job, []);
      await run(undefined, movedBack);
      expect(reader.requests[0].watermark).toEqual({ field: 'updated', from: movedBack });
      expect(logs).toContain('Reading rows where updated >= 2025-03-02T14:30:00.000Z');
      expect(checkpoints).toEqual([]);
    });

    it('checkpoints the rows it reads as usual', async () => {
      const { checkpoints, run } = setup(job, [[{ id: 1, qty: 1, updated: new Date('2025-03-02T23:30:00Z') }]]);
      await run(undefined, legacy);
      expect(checkpoints).toEqual([{ type: 'date', value: '2025-03-02T23:30:00.000Z', utc: true }]);
    });
  });

  it('stops when cancelled', async () => {
    const controller = new AbortController();
    controller.abort();
    const { writer, run } = setup(makeJob(), [[{ id: 1, qty: 1 }]]);
    await expect(run(controller.signal)).rejects.toBeInstanceOf(RunCancelledError);
    expect(writer.written).toEqual([]);
  });
});

describe('SyncRunner write failures', () => {
  const duplicate = 'duplicate key value violates unique constraint "customer_email_key"';

  it('writes the rest of a batch when one row is refused, and lists that row', async () => {
    const { writer, failures, logs, run } = setup(makeJob({ errorPolicy: 'skip' }), [
      [{ id: 1, qty: 1 }, { id: 2, qty: 2 }, { id: 3, qty: 3 }],
      [{ id: 4, qty: 4 }],
    ]);
    writer.reject = (row) => (row.id === 2 ? duplicate : undefined);

    const { stats } = await run();

    expect(stats).toEqual({ read: 4, written: 3, skipped: 1, batches: 2 });
    expect(writer.written.map((row) => row.id)).toEqual([1, 3, 4]);
    expect(failures).toEqual([{ row: 2, key: '2', stage: 'write', reason: duplicate, values: { id: 2, quantity: 2 } }]);
    expect(logs).toContain(`Row 2 (2): ${duplicate}. It will be retried once at the end.`);
    expect(logs).toContain('1 of 1 rows still could not be written; they are listed with the run');
  });

  it('retries failed rows once at the end, which fixes order problems', async () => {
    // Row 2 references row 5, which only arrives in a later batch (like a foreign key).
    const { writer, failures, logs, run } = setup(makeJob({ errorPolicy: 'skip' }), [
      [{ id: 1, qty: 1 }, { id: 2, qty: 5 }],
      [{ id: 5, qty: 0 }],
    ]);
    writer.reject = (row, written) =>
      row.quantity === 5 && !written.some((other) => other.id === 5) ? 'violates foreign key constraint' : undefined;

    const { stats } = await run();

    expect(stats).toMatchObject({ read: 3, written: 3, skipped: 0 });
    expect(writer.written.map((row) => row.id)).toEqual([1, 5, 2]);
    expect(failures).toEqual([]);
    expect(logs).toContain('All 1 rows were written on retry');
  });

  it('still stops at the first write error with the fail policy', async () => {
    const { writer, failures, run } = setup(makeJob(), [[{ id: 1, qty: 1 }, { id: 2, qty: 2 }]]);
    writer.reject = (row) => (row.id === 2 ? duplicate : undefined);
    await expect(run()).rejects.toThrow(duplicate);
    expect(writer.written).toEqual([]);
    expect(failures).toEqual([]);
  });
});

describe('SyncRunner with lookups', () => {
  const customers = { async findByKeys() { return [{ ref: 'C1', email: 'a@x.io' }]; } };
  const enricher = new LookupEnricher([
    {
      spec: { as: 'customer', connectionId: 'crm', collection: 'customers', on: [{ source: 'ref', lookup: 'ref' }], required: true },
      reader: customers,
    },
  ]);
  const job = (overrides: Partial<Job> = {}) =>
    makeJob({
      mappings: [
        { from: 'id', to: 'id', transform: 'none' },
        { from: 'customer.email', to: 'email', transform: 'none' },
      ],
      ...overrides,
    });

  it('maps fields from lookups and reads only the source fields it needs', async () => {
    const { reader, writer, run } = setup(job(), [[{ id: 1, ref: 'C1' }]], enricher);
    await run();
    expect(writer.written).toEqual([{ id: 1, email: 'a@x.io' }]);
    expect(reader.requests[0].fields).toEqual(['id', 'ref']);
  });

  it('treats a missing required lookup as a row error', async () => {
    const { writer, logs, failures, run } = setup(job({ errorPolicy: 'skip' }), [[{ id: 1, ref: 'C1' }, { id: 2, ref: 'C2' }]], enricher);
    const { stats } = await run();
    expect(stats).toMatchObject({ read: 2, written: 1, skipped: 1 });
    expect(writer.written).toEqual([{ id: 1, email: 'a@x.io' }]);
    expect(logs).toContain('Row 2: no customer found where ref = "C2"');
    expect(failures).toEqual([{ row: 2, key: null, stage: 'lookup', reason: 'no customer found where ref = "C2"' }]);
  });

  it('passes a query source to the reader', async () => {
    const source = { connectionId: 'a', collection: 'totals', query: 'SELECT 1 AS id' };
    const { reader, run } = setup(makeJob({ source }), [[]]);
    await run();
    expect(reader.requests[0].query).toBe('SELECT 1 AS id');
  });
});

describe('dedupeByKey', () => {
  it('keeps the last row per key', () => {
    expect(dedupeByKey([{ id: 1, v: 'a' }, { id: '1', v: 'b' }, { id: 2, v: 'c' }], ['id'])).toEqual([
      { id: '1', v: 'b' },
      { id: 2, v: 'c' },
    ]);
  });
});
