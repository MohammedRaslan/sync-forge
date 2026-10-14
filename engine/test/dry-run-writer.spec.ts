import { describe, expect, it } from 'vitest';
import { getPath } from '../src/common/paths';
import { keyString } from '../src/common/values';
import { ConnectionKind } from '../src/connections/connection.model';
import { Connector, KeyReader, Row } from '../src/connectors/connector.types';
import { DryRunWriter, dryRunWriterFor } from '../src/sync/dry-run-writer';

/** A target that can only be read, so any write attempt would fail the test. */
class ReadOnlyTarget implements KeyReader {
  constructor(private readonly rows: Row[]) {}
  async findByKeys(_collection: string, keyFields: string[], keys: Row[]) {
    const wanted = new Set(keys.map((key) => keyString(keyFields.map((field) => key[field]))));
    return this.rows.filter((row) => wanted.has(keyString(keyFields.map((field) => getPath(row, field)))));
  }
}

describe('DryRunWriter', () => {
  it('reports rows that would be inserted, updated or left unchanged, and writes nothing', async () => {
    const target = new ReadOnlyTarget([
      { id: 1, email: 'a@x.io', city: 'Cologne' },
      { id: '2', email: 'b@x.io', city: 'Berlin' },
    ]);
    const writer = new DryRunWriter(target);

    await writer.upsert('customers', [
      { id: 1, email: 'a@x.io', city: 'Cologne' }, // unchanged
      { id: 2, email: 'b@x.io', city: 'Cairo' }, // "2" in the target is the same key
      { id: 3, email: 'c@x.io', city: 'Hamburg' }, // new
    ], ['id']);

    expect(writer.report).toEqual({
      inserts: 1,
      updates: 1,
      unchanged: 1,
      newKeys: ['3'],
      changes: [{ key: '2', field: 'city', current: 'Berlin', next: 'Cairo' }],
    });
  });

  it('adds up across batches and keeps only the first examples', async () => {
    const writer = new DryRunWriter(new ReadOnlyTarget([]));
    for (let batch = 0; batch < 3; batch += 1) {
      await writer.upsert('t', Array.from({ length: 50 }, (_, n) => ({ id: batch * 50 + n })), ['id']);
    }
    expect(writer.report.inserts).toBe(150);
    expect(writer.report.newKeys).toHaveLength(100);
  });

  it('counts a key seen in an earlier batch as an update, as a real run would', async () => {
    const writer = new DryRunWriter(new ReadOnlyTarget([]));
    await writer.upsert('t', [{ id: 'CUS-1', v: 1 }], ['id']);
    await writer.upsert('t', [{ id: 'CUS-1', v: 2 }], ['id']);
    expect(writer.report).toMatchObject({ inserts: 1, updates: 1 });
  });

  it('reports fields a whole-document target would remove', async () => {
    const target = new ReadOnlyTarget([{ id: 'a', name: 'Ann', legacyFlag: true, address: { city: 'Cairo' } }]);
    const writer = new DryRunWriter(target, { replacesWholeDocument: true });
    await writer.upsert('c', [{ id: 'a', name: 'Ann', 'address.city': 'Cairo' }], ['id']);
    expect(writer.report).toMatchObject({ updates: 1, unchanged: 0 });
    expect(writer.report.changes).toEqual([{ key: 'a', field: 'legacyFlag', current: true, next: null, removed: true }]);

    const merging = new DryRunWriter(target);
    await merging.upsert('c', [{ id: 'a', name: 'Ann' }], ['id']);
    expect(merging.report.unchanged).toBe(1);
  });

  describe('on the target chosen by its database kind', () => {
    const writerFor = (kind: ConnectionKind, rows: Row[]) =>
      dryRunWriterFor({ target: new ReadOnlyTarget(rows) as unknown as Connector, targetConnection: { kind } as PipelineView });

    it('reports text written over a boolean as a change on a document target, which stores each value with its type', async () => {
      const writer = writerFor('mongo', [{ id: 'a', active: true }]);
      await writer.upsert('c', [{ id: 'a', active: '1' }], ['id']);
      expect(writer.report).toMatchObject({ updates: 1, unchanged: 0 });
      expect(writer.report.changes).toEqual([{ key: 'a', field: 'active', current: true, next: '1' }]);
    });

    it('leaves a decimal written as other text unchanged on a SQL target, which converts it to the column type', async () => {
      const writer = writerFor('postgres', [{ id: 'a', price: '12.5' }]);
      await writer.upsert('t', [{ id: 'a', price: '12.50' }], ['id']);
      expect(writer.report).toMatchObject({ updates: 0, unchanged: 1 });
    });
  });
});

type PipelineView = Parameters<typeof dryRunWriterFor>[0]['targetConnection'];
