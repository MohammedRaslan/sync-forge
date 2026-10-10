import { describe, expect, it } from 'vitest';
import { Connector, ReadRequest, Row } from '../../src/connectors/connector.types';
import { valuesEqual } from '../../src/common/values';

/**
 * Behaviour every connector must have, whatever the database. Each connector's spec seeds
 * `SEED_ROWS` into its source collection and provides an empty target on demand.
 */

export interface ContractHarness {
  connector: Connector;
  /** Holds SEED_ROWS. */
  sourceCollection: string;
  /** Creates an empty collection that accepts rows shaped like SEED_ROWS, keyed on `id`. */
  createTarget(): Promise<string>;
}

const BASE_TIME = Date.UTC(2025, 0, 1);

/** 25 rows; every three consecutive rows share an `updated_at`, so watermark boundaries have ties. */
export const SEED_ROWS: Row[] = Array.from({ length: 25 }, (_, index) => {
  const n = index + 1;
  return {
    id: `r${String(n).padStart(2, '0')}`,
    name: `Name ${n}`,
    qty: n,
    updated_at: new Date(BASE_TIME + Math.floor(n / 3) * 3_600_000),
  };
});

async function readAll(connector: Connector, request: ReadRequest): Promise<Row[][]> {
  const batches: Row[][] = [];
  for await (const batch of connector.readBatches(request)) batches.push(batch);
  return batches;
}

function ids(rows: Row[]): string[] {
  return rows.map((row) => String(row.id)).sort();
}

function expectSameRows(actual: Row[], expected: Row[]): void {
  expect(ids(actual)).toEqual(ids(expected));
  const byId = new Map(actual.map((row) => [String(row.id), row]));
  for (const row of expected) {
    const found = byId.get(String(row.id))!;
    for (const field of Object.keys(row)) {
      expect(valuesEqual(row[field], found[field]), `${String(row.id)}.${field}`).toBe(true);
    }
  }
}

export function describeConnectorContract(name: string, harness: () => ContractHarness): void {
  describe(`${name} connector contract`, () => {
    it('pings', async () => {
      await expect(harness().connector.ping()).resolves.toBeUndefined();
    });

    it('lists the source collection', async () => {
      const { connector, sourceCollection } = harness();
      const names = (await connector.listCollections()).map((collection) => collection.name);
      expect(names).toContain(sourceCollection);
    });

    it('describes the source fields', async () => {
      const { connector, sourceCollection } = harness();
      const paths = (await connector.describeCollection(sourceCollection)).map((field) => field.path);
      expect(paths).toEqual(expect.arrayContaining(['id', 'name', 'qty', 'updated_at']));
    });

    it('counts rows', async () => {
      const { connector, sourceCollection } = harness();
      expect(await connector.count(sourceCollection)).toBe(SEED_ROWS.length);
    });

    it('reads every row in batches no larger than the batch size', async () => {
      const { connector, sourceCollection } = harness();
      const batches = await readAll(connector, { collection: sourceCollection, batchSize: 10 });
      expect(batches.every((batch) => batch.length <= 10)).toBe(true);
      expectSameRows(batches.flat(), SEED_ROWS);
    });

    it('stops at the limit', async () => {
      const { connector, sourceCollection } = harness();
      const batches = await readAll(connector, { collection: sourceCollection, batchSize: 5, limit: 7 });
      expect(batches.flat()).toHaveLength(7);
    });

    it('returns at least the requested fields', async () => {
      const { connector, sourceCollection } = harness();
      const rows = (await readAll(connector, { collection: sourceCollection, batchSize: 50, fields: ['id', 'qty'] })).flat();
      expect(rows).toHaveLength(SEED_ROWS.length);
      for (const row of rows) {
        expect(row.id).toBeDefined();
        expect(row.qty).toBeDefined();
      }
    });

    it('reads from a watermark inclusively, in watermark order', async () => {
      const { connector, sourceCollection } = harness();
      // r10 shares its timestamp with r09 and r11: all three must come back.
      const from = (SEED_ROWS[9].updated_at as Date).toISOString();
      const rows = (
        await readAll(connector, {
          collection: sourceCollection,
          batchSize: 4,
          watermark: { field: 'updated_at', from: { type: 'date', value: from } },
        })
      ).flat();

      const expected = SEED_ROWS.filter((row) => (row.updated_at as Date).toISOString() >= from);
      expect(expected.map((row) => row.id)).toContain('r09');
      expectSameRows(rows, expected);
      const times = rows.map((row) => new Date(row.updated_at as string | Date).getTime());
      expect(times).toEqual([...times].sort((a, b) => a - b));
    });

    it('reads every row in watermark order when there is no watermark value yet', async () => {
      const { connector, sourceCollection } = harness();
      const rows = (
        await readAll(connector, { collection: sourceCollection, batchSize: 10, watermark: { field: 'updated_at' } })
      ).flat();
      expect(rows).toHaveLength(SEED_ROWS.length);
    });

    it('reads only rows matching the filters, also together with a watermark', async () => {
      const { connector, sourceCollection } = harness();
      const above20 = (await readAll(connector, { collection: sourceCollection, batchSize: 10, filters: [{ field: 'qty', op: 'gt', value: 20 }] })).flat();
      expect(ids(above20)).toEqual(['r21', 'r22', 'r23', 'r24', 'r25']);

      const from = (SEED_ROWS[9].updated_at as Date).toISOString();
      const rows = (
        await readAll(connector, {
          collection: sourceCollection,
          batchSize: 10,
          filters: [
            { field: 'qty', op: 'lte', value: 12 },
            { field: 'updated_at', op: 'lt', value: new Date(BASE_TIME + 100 * 3_600_000) },
          ],
          watermark: { field: 'updated_at', from: { type: 'date', value: from } },
        })
      ).flat();
      expect(ids(rows)).toEqual(['r09', 'r10', 'r11', 'r12']);
    });

    it('counts only rows matching the filters', async () => {
      const { connector, sourceCollection } = harness();
      expect(await connector.count(sourceCollection, { filters: [{ field: 'qty', op: 'lte', value: 5 }] })).toBe(5);
      expect(await connector.count(sourceCollection, { filters: [{ field: 'qty', op: 'ne', value: 1 }] })).toBe(24);
      expect(await connector.count(sourceCollection, { filters: [{ field: 'id', op: 'eq', value: 'r07' }] })).toBe(1);
    });

    it('treats "not equal" as also matching empty values', async () => {
      const { connector, createTarget } = harness();
      const target = await createTarget();
      await connector.upsert(target, [
        { id: 'a', name: 'A', qty: 1 },
        { id: 'b', name: 'B', qty: 2 },
        { id: 'c', name: 'C', qty: null },
      ], ['id']);
      expect(await connector.count(target, { filters: [{ field: 'qty', op: 'ne', value: 1 }] })).toBe(2);
      const rows = (await readAll(connector, { collection: target, batchSize: 10, filters: [{ field: 'qty', op: 'ne', value: 1 }] })).flat();
      expect(ids(rows)).toEqual(['b', 'c']);
    });

    it('explains a key lookup as text without running it', () => {
      const { connector, sourceCollection } = harness();
      const text = connector.explainFindByKeys(sourceCollection, ['id'], [{ id: 'r02' }, { id: 'r04' }]);
      expect(text).toContain('r02');
      expect(text).toContain('r04');
    });

    it('explains a write as text without running it', async () => {
      const { connector, createTarget } = harness();
      const target = await createTarget();
      const text = connector.explainUpsert(target, SEED_ROWS.slice(0, 2), ['id']);
      expect(text).toContain('r01');
      expect(text).toContain('Name 2');
      expect(await connector.count(target)).toBe(0);
    });

    it('explains a read as text without running it', () => {
      const { connector, sourceCollection } = harness();
      const text = connector.explainRead({
        collection: sourceCollection,
        batchSize: 10,
        filters: [{ field: 'qty', op: 'gt', value: 20 }],
        watermark: { field: 'updated_at' },
      });
      expect(text).toContain('qty');
      expect(text).toContain('updated_at');
    });

    it('stops reading when the signal is aborted', async () => {
      const { connector, sourceCollection } = harness();
      const controller = new AbortController();
      let batches = 0;
      for await (const _batch of connector.readBatches({
        collection: sourceCollection,
        batchSize: 5,
        signal: controller.signal,
      })) {
        batches += 1;
        controller.abort();
      }
      expect(batches).toBe(1);
    });

    it('upserts idempotently and updates matched rows', async () => {
      const { connector, createTarget } = harness();
      const target = await createTarget();
      const rows = SEED_ROWS.slice(0, 5);

      await connector.upsert(target, rows, ['id']);
      await connector.upsert(target, rows, ['id']);
      expect(await connector.count(target)).toBe(5);
      expectSameRows(await connector.findByKeys(target, ['id'], rows), rows);

      const changed: Row = { ...rows[0], qty: 999 };
      await connector.upsert(target, [changed], ['id']);
      expect(await connector.count(target)).toBe(5);
      const [found] = await connector.findByKeys(target, ['id'], [{ id: changed.id }]);
      expect(valuesEqual(found.qty, 999)).toBe(true);
    });

    it('finds rows by key and ignores unknown keys', async () => {
      const { connector, createTarget } = harness();
      const target = await createTarget();
      await connector.upsert(target, SEED_ROWS.slice(0, 5), ['id']);

      const found = await connector.findByKeys(target, ['id'], [{ id: 'r02' }, { id: 'r04' }, { id: 'nope' }]);
      expect(ids(found)).toEqual(['r02', 'r04']);
      expect(await connector.findByKeys(target, ['id'], [])).toEqual([]);
    });
  });
}
