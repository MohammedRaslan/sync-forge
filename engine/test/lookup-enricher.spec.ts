import { describe, expect, it } from 'vitest';
import { getPath } from '../src/common/paths';
import { keyString } from '../src/common/values';
import { KeyReader, Row } from '../src/connectors/connector.types';
import { Lookup } from '../src/jobs/job.model';
import { LookupEnricher } from '../src/sync/lookup-enricher';

class MemoryKeyReader implements KeyReader {
  calls: Row[][] = [];
  constructor(private readonly rows: Row[]) {}
  async findByKeys(_collection: string, keyFields: string[], keys: Row[]) {
    this.calls.push(keys);
    const wanted = new Set(keys.map((key) => keyString(keyFields.map((field) => key[field]))));
    return this.rows.filter((row) => wanted.has(keyString(keyFields.map((field) => getPath(row, field)))));
  }
}

function lookup(overrides: Partial<Lookup> = {}): Lookup {
  return {
    as: 'customer',
    connectionId: 'crm',
    collection: 'customers',
    on: [{ source: 'customer_ref', lookup: 'ref' }],
    required: false,
    ...overrides,
  };
}

const customers = [
  { ref: 'C1', email: 'a@x.io', regionId: 1 },
  { ref: 'C2', email: 'b@x.io', regionId: 2 },
];

describe('LookupEnricher', () => {
  it('attaches the matching row under the lookup name with one query per batch', async () => {
    const reader = new MemoryKeyReader(customers);
    const enricher = new LookupEnricher([{ spec: lookup(), reader }]);
    const source = [
      { id: 1, customer_ref: 'C1' },
      { id: 2, customer_ref: 'C2' },
      { id: 3, customer_ref: 'C1' },
    ];

    const results = await enricher.enrich(source);

    expect(results.map(({ row }) => getPath(row, 'customer.email'))).toEqual(['a@x.io', 'b@x.io', 'a@x.io']);
    expect(reader.calls).toEqual([[{ ref: 'C1' }, { ref: 'C2' }]]);
    expect(source[0]).not.toHaveProperty('customer');
  });

  it('leaves optional lookups empty when nothing matches or the key is missing', async () => {
    const enricher = new LookupEnricher([{ spec: lookup(), reader: new MemoryKeyReader(customers) }]);
    const results = await enricher.enrich([{ customer_ref: 'C9' }, { customer_ref: null }]);
    expect(results).toEqual([{ row: { customer_ref: 'C9', customer: null } }, { row: { customer_ref: null, customer: null } }]);
  });

  it('reports a row error when a required lookup has no match', async () => {
    const enricher = new LookupEnricher([{ spec: lookup({ required: true }), reader: new MemoryKeyReader(customers) }]);
    const [result] = await enricher.enrich([{ customer_ref: 'C9' }]);
    expect(result.error).toBe('no customer found where ref = "C9"');
  });

  it('matches keys across representations', async () => {
    const enricher = new LookupEnricher([
      { spec: lookup({ on: [{ source: 'region', lookup: 'regionId' }] }), reader: new MemoryKeyReader(customers) },
    ]);
    // A Postgres bigint arrives as a string; the lookup stores a number.
    const [result] = await enricher.enrich([{ region: '2' }]);
    expect(getPath(result.row, 'customer.email')).toBe('b@x.io');
  });

  it('lets a lookup match on fields of an earlier lookup', async () => {
    const regions = new MemoryKeyReader([{ id: 1, name: 'North' }]);
    const enricher = new LookupEnricher([
      { spec: lookup(), reader: new MemoryKeyReader(customers) },
      { spec: lookup({ as: 'region', on: [{ source: 'customer.regionId', lookup: 'id' }] }), reader: regions },
    ]);
    const [result] = await enricher.enrich([{ customer_ref: 'C1' }]);
    expect(getPath(result.row, 'region.name')).toBe('North');
  });

  it('matches on several fields and keeps the first of duplicate matches', async () => {
    const reader = new MemoryKeyReader([
      { tenant: 't1', code: 'a', v: 'first' },
      { tenant: 't1', code: 'a', v: 'second' },
      { tenant: 't2', code: 'a', v: 'other tenant' },
    ]);
    const spec = lookup({ as: 'item', on: [{ source: 'tenant', lookup: 'tenant' }, { source: 'code', lookup: 'code' }] });
    const [result] = await new LookupEnricher([{ spec, reader }]).enrich([{ tenant: 't1', code: 'a' }]);
    expect(getPath(result.row, 'item.v')).toBe('first');
  });

  it('splits large batches into several lookup queries', async () => {
    const reader = new MemoryKeyReader([]);
    const rows = Array.from({ length: 450 }, (_, n) => ({ customer_ref: `C${n}` }));
    await new LookupEnricher([{ spec: lookup(), reader }]).enrich(rows);
    expect(reader.calls.map((keys) => keys.length)).toEqual([200, 200, 50]);
  });

  describe('sourceFields', () => {
    const enricher = new LookupEnricher([
      { spec: lookup(), reader: new MemoryKeyReader([]) },
      { spec: lookup({ as: 'region', on: [{ source: 'customer.regionId', lookup: 'id' }] }), reader: new MemoryKeyReader([]) },
    ]);

    it('drops lookup paths and adds the fields lookups match on', () => {
      expect(enricher.sourceFields(['id', 'customer.email', 'region.name'])).toEqual(['id', 'customer_ref']);
    });

    it('keeps "every field" as is', () => {
      expect(enricher.sourceFields(undefined)).toBeUndefined();
      expect(LookupEnricher.none.sourceFields(['id'])).toEqual(['id']);
    });
  });
});
