import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NotFoundError, ValidationError } from '../../src/common/errors';
import { Row } from '../../src/connectors/connector.types';
import { PostgresConnector } from '../../src/connectors/postgres/postgres.connector';
import { StoredWatermark, toStoredWatermark } from '../../src/sync/watermark';
import { ContractHarness, SEED_ROWS, describeConnectorContract } from './connector-contract';
import { Started, startPostgres } from './containers';
import { PostgresConfig } from '../../src/connections/connection.model';

let database: Started<PostgresConfig>;
let pool: Pool;
let connector: PostgresConnector;
let targets = 0;

async function createTable(name: string): Promise<string> {
  await pool.query(
    `CREATE TABLE public.${name} (id text PRIMARY KEY, name text NOT NULL, qty integer, updated_at timestamptz, meta jsonb)`,
  );
  return `public.${name}`;
}

beforeAll(async () => {
  database = await startPostgres();
  const { host, port, database: name, user, password } = database.config;
  pool = new Pool({ host, port, database: name, user, password, max: 2 });
  await createTable('items');
  for (const row of SEED_ROWS) {
    await pool.query('INSERT INTO public.items (id, name, qty, updated_at) VALUES ($1, $2, $3, $4)', [
      row.id,
      row.name,
      row.qty,
      row.updated_at,
    ]);
  }
  connector = new PostgresConnector(database.config);
});

afterAll(async () => {
  await connector?.close();
  await pool?.end();
  await database?.stop();
});

const harness = (): ContractHarness => ({
  connector,
  sourceCollection: 'public.items',
  createTarget: () => createTable(`target_${++targets}`),
});

describeConnectorContract('Postgres', harness);

describe('Postgres connector', () => {
  // The integration tests run in Europe/Athens (vitest.integration.config.ts), where pg's default parsing is off by hours.
  describe('naive date columns (timestamp without time zone, date) as UTC', () => {
    beforeAll(async () => {
      await pool.query('CREATE TABLE public.naive_dates (id int PRIMARY KEY, at timestamp, day date)');
      await pool.query("INSERT INTO public.naive_dates VALUES (1, '2025-03-01 10:00:00', '2025-03-01'), (2, '2025-03-02 23:30:00', '2025-03-02')");
    });

    it('reads them as UTC', async () => {
      const [row] = await connector.findByKeys('public.naive_dates', ['id'], [{ id: 1 }]);
      expect(row).toEqual({ id: 1, at: new Date('2025-03-01T10:00:00.000Z'), day: new Date('2025-03-01T00:00:00.000Z') });
    });

    it('writes Dates as their UTC wall time', async () => {
      await pool.query('CREATE TABLE public.naive_written (id int PRIMARY KEY, at timestamp, day date)');
      await connector.upsert('public.naive_written', [{ id: 1, at: new Date('2025-03-01T23:30:00Z'), day: new Date('2025-03-01T00:00:00Z') }], ['id']);
      const { rows } = await pool.query('SELECT at::text AS at, day::text AS day FROM public.naive_written');
      expect(rows).toEqual([{ at: '2025-03-01 23:30:00', day: '2025-03-01' }]);
    });

    const readFrom = async (from?: StoredWatermark) => {
      const rows: Row[] = [];
      for await (const batch of connector.readBatches({ collection: 'public.naive_dates', batchSize: 10, watermark: { field: 'at', from } })) {
        rows.push(...batch);
      }
      return rows;
    };

    it('resumes a watermark on a timestamp column at the same moment it was read', async () => {
      const last = toStoredWatermark((await readFrom()).at(-1)!.at)!;
      expect(last).toEqual({ type: 'date', value: '2025-03-02T23:30:00.000Z', utc: true });
      expect((await readFrom(last)).map((row) => row.id)).toEqual([2]);
      expect(await readFrom({ type: 'date', value: '2025-03-02T23:30:00.001Z', utc: true })).toEqual([]);
    });

    it('still reads the boundary row from a watermark an older engine saved west of UTC', async () => {
      // The old engine read naive timestamps as local time: in New York, 23:30 was saved as 04:30 UTC the next day.
      const saved: StoredWatermark = { type: 'date', value: '2025-03-03T04:30:00.000Z' };
      expect((await readFrom(saved)).map((row) => row.id)).toEqual([2]);
    });
  });

  it('writes a batch completely or not at all', async () => {
    const target = await createTable(`target_${++targets}`);
    const rows: Row[] = [
      { id: 'a', name: 'ok', qty: 1 },
      { id: 'b', name: null, qty: 2 }, // violates NOT NULL
    ];
    await expect(connector.upsert(target, rows, ['id'])).rejects.toThrow(/null value/);
    expect(await connector.count(target)).toBe(0);
  });

  it('splits batches that exceed the bind parameter limit', async () => {
    const target = await createTable(`target_${++targets}`);
    // 5 columns x 15,000 rows = 75,000 parameters, above the 65,535 limit of one statement.
    const rows = Array.from({ length: 15_000 }, (_, n) => ({
      id: `k${n}`,
      name: `n${n}`,
      qty: n,
      updated_at: new Date(0),
      meta: null,
    }));
    await connector.upsert(target, rows, ['id']);
    expect(await connector.count(target)).toBe(15_000);
  });

  it('writes objects to jsonb and reads nested paths through their column', async () => {
    const target = await createTable(`target_${++targets}`);
    await connector.upsert(target, [{ id: 'j', name: 'json', meta: { channel: 'web', tags: ['a'] } }], ['id']);

    const [found] = await connector.findByKeys(target, ['id'], [{ id: 'j' }]);
    expect(found.meta).toEqual({ channel: 'web', tags: ['a'] });

    const batches: Row[][] = [];
    for await (const batch of connector.readBatches({ collection: target, batchSize: 10, fields: ['id', 'meta.channel'] })) {
      batches.push(batch);
    }
    expect(batches.flat()[0].meta).toEqual({ channel: 'web', tags: ['a'] });
  });

  it('rejects nested watermark paths', async () => {
    const read = connector.readBatches({ collection: 'public.items', batchSize: 10, watermark: { field: 'meta.at' } });
    await expect(read[Symbol.asyncIterator]().next()).rejects.toBeInstanceOf(ValidationError);
  });

  it('reports a missing table as not found', async () => {
    await expect(connector.describeCollection('public.nope')).rejects.toBeInstanceOf(NotFoundError);
  });

  describe('query sources', () => {
    const query = 'SELECT id, qty * 2 AS doubled, updated_at FROM public.items WHERE qty <= 20;';

    async function readQuery(request: Partial<Parameters<PostgresConnector['readBatches']>[0]> = {}): Promise<Row[]> {
      const rows: Row[] = [];
      for await (const batch of connector.readBatches({ collection: 'doubled', query, batchSize: 7, ...request })) rows.push(...batch);
      return rows;
    }

    it('reads and counts the query result', async () => {
      const rows = await readQuery();
      expect(rows).toHaveLength(20);
      expect(rows.find((row) => row.id === 'r05')?.doubled).toBe(10);
      expect(await connector.count('doubled', { query })).toBe(20);
    });

    it('applies watermarks and projections to the query result', async () => {
      const from = (SEED_ROWS[9].updated_at as Date).toISOString();
      const rows = await readQuery({ fields: ['id'], watermark: { field: 'updated_at', from: { type: 'date', value: from, utc: true } } });
      expect(rows.map((row) => row.id)).toEqual(expect.arrayContaining(['r09', 'r20']));
      expect(rows).toHaveLength(12);
      expect(Object.keys(rows[0]).sort()).toEqual(['id', 'updated_at']);
    });

    it('describes the columns a query returns', async () => {
      const fields = await connector.describeQuery(query);
      expect(fields.map(({ path, type }) => [path, type])).toEqual([
        ['id', 'text'],
        ['doubled', 'int4'],
        ['updated_at', 'timestamptz'],
      ]);
    });

    it('cannot modify the database', async () => {
      // A data-modifying CTE is already rejected inside a subquery; a function call is not.
      await pool.query("CREATE FUNCTION public.wipe() RETURNS int LANGUAGE sql AS 'DELETE FROM public.items; SELECT 1'");
      const destructive = 'SELECT public.wipe() AS id';
      await expect(connector.count('gone', { query: destructive })).rejects.toThrow(/read-only transaction/);
      await connector.describeQuery(destructive); // LIMIT 0: the function is never called
      const read = connector.readBatches({ collection: 'gone', query: destructive, batchSize: 10 });
      await expect(read[Symbol.asyncIterator]().next()).rejects.toThrow(/read-only transaction/);
      expect(await connector.count('public.items')).toBe(SEED_ROWS.length);
    });
  });
});
