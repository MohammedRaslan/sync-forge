import { Long, ObjectId } from 'mongodb';
import { describe, expect, it } from 'vitest';
import { Job } from '../src/jobs/job.model';
import { sourceKeyFields, sourceKeyOf } from '../src/sync/source-key';

type KeyedJob = Pick<Job, 'source' | 'target' | 'mappings' | 'lookups'>;

function makeJob(overrides: Partial<KeyedJob> = {}): KeyedJob {
  return {
    source: { connectionId: 'a', collection: 'orders' },
    target: { connectionId: 'b', collection: 'dst', keyFields: ['id'] },
    mappings: [
      { from: 'order_id', to: 'id', transform: 'none' },
      { from: 'total', to: 'amount', transform: 'number' },
    ],
    ...overrides,
  };
}

describe('sourceKeyFields', () => {
  it('is the source field each key field is copied from', () => {
    expect(sourceKeyFields(makeJob())).toEqual({ fields: ['order_id'] });
  });

  it('follows composite keys in key order and lists a shared source field once', () => {
    const job = makeJob({
      target: { connectionId: 'b', collection: 'dst', keyFields: ['tenant', 'id', 'copy'] },
      mappings: [
        { from: 'order_id', to: 'id', transform: 'none' },
        { from: 'tenant_id', to: 'tenant', transform: 'none' },
        { from: 'order_id', to: 'copy', transform: 'string' },
      ],
    });
    expect(sourceKeyFields(job)).toEqual({ fields: ['tenant_id', 'order_id'] });
  });

  it('accepts transforms that read only the source field, since the raw source value finds the row', () => {
    for (const transform of ['string', 'number', 'trim', 'lowercase', 'uppercase', 'date', 'boolean', 'json'] as const) {
      const job = makeJob({ mappings: [{ from: 'order_id', to: 'id', transform }] });
      expect(sourceKeyFields(job)).toEqual({ fields: ['order_id'] });
    }
  });

  it('is not derivable for a SQL query source', () => {
    const job = makeJob({ source: { connectionId: 'a', collection: 'q', query: 'SELECT 1 AS order_id' } });
    expect(sourceKeyFields(job)).toEqual({ reason: "rows of a SQL query source can't be fetched by key" });
  });

  it('is not derivable when a key is set by an expression, a constant or a default', () => {
    const expression = makeJob({ mappings: [{ from: 'order_id', to: 'id', transform: 'expression', argument: 'value + 1' }] });
    expect(sourceKeyFields(expression)).toEqual({
      reason: 'key field "id" is set by an expression; map it from a source field to re-run failed rows',
    });
    const constant = makeJob({ mappings: [{ to: 'id', transform: 'constant', argument: '1' }] });
    expect(sourceKeyFields(constant)).toMatchObject({ reason: expect.stringContaining('a constant') });
    const fallback = makeJob({ mappings: [{ from: 'order_id', to: 'id', transform: 'default', argument: '0' }] });
    expect(sourceKeyFields(fallback)).toMatchObject({ reason: expect.stringContaining('a default value') });
  });

  it('is not derivable when a key is not mapped from a source field or comes from a lookup', () => {
    expect(sourceKeyFields(makeJob({ mappings: [{ to: 'other', transform: 'none', from: 'x' }] }))).toEqual({
      reason: 'key field "id" is not mapped from a source field',
    });
    const job = makeJob({
      lookups: [{ as: 'customer', connectionId: 'c', collection: 'customers', on: [{ source: 'ref', lookup: 'ref' }], required: false }],
      mappings: [{ from: 'customer.id', to: 'id', transform: 'none' }],
    });
    expect(sourceKeyFields(job)).toEqual({ reason: 'key field "id" comes from the lookup "customer", not from the source' });
  });
});

describe('sourceKeyOf', () => {
  it('takes the raw values of the source key fields, nested paths included', () => {
    expect(sourceKeyOf({ id: 7, address: { zip: '10115' }, other: 1 }, ['id', 'address.zip'])).toEqual({ id: 7, 'address.zip': '10115' });
  });

  it('keeps big integers as text and BSON numbers as numbers', () => {
    expect(sourceKeyOf({ id: 9007199254740993n }, ['id'])).toEqual({ id: '9007199254740993' });
    expect(sourceKeyOf({ id: Long.fromNumber(42) }, ['id'])).toEqual({ id: 42 });
  });

  it('has no key when a value is empty or would not be matched again after JSON', () => {
    expect(sourceKeyOf({ id: null }, ['id'])).toBeUndefined();
    expect(sourceKeyOf({}, ['id'])).toBeUndefined();
    expect(sourceKeyOf({ id: new ObjectId() }, ['id'])).toBeUndefined();
    expect(sourceKeyOf({ id: new Date() }, ['id'])).toBeUndefined();
    expect(sourceKeyOf({ id: Number.NaN }, ['id'])).toBeUndefined();
    expect(sourceKeyOf({ id: 1, tenant: true }, ['id', 'tenant'])).toBeUndefined();
  });
});
