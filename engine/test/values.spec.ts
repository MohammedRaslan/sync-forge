import { ObjectId, Decimal128 } from 'mongodb';
import { describe, expect, it } from 'vitest';
import { keyString, normalizeValue, valuesEqual } from '../src/common/values';

describe('normalizeValue', () => {
  it('converts BSON types to portable values', () => {
    const id = new ObjectId('64b7f0c2a1b2c3d4e5f60718');
    expect(normalizeValue(id)).toBe('64b7f0c2a1b2c3d4e5f60718');
    expect(normalizeValue(Decimal128.fromString('12.50'))).toBe('12.50');
  });

  it('normalizes nested structures and keeps dates', () => {
    const date = new Date('2024-01-01T00:00:00Z');
    expect(normalizeValue({ a: [1n, undefined], b: { c: date } })).toEqual({ a: ['1', null], b: { c: date } });
  });
});

describe('valuesEqual', () => {
  it('treats representation differences as equal', () => {
    expect(valuesEqual(12.5, '12.50')).toBe(true);
    expect(valuesEqual(new Date('2024-01-01T00:00:00Z'), '2024-01-01T00:00:00.000Z')).toBe(true);
    expect(valuesEqual({ b: 1, a: 2 }, '{"a":2,"b":1}')).toBe(true);
    expect(valuesEqual(undefined, null)).toBe(true);
  });

  it('detects real differences', () => {
    expect(valuesEqual('a', 'b')).toBe(false);
    expect(valuesEqual(null, 0)).toBe(false);
    expect(valuesEqual({ a: 1 }, { a: 2 })).toBe(false);
  });
});

describe('keyString', () => {
  it('matches keys across drivers', () => {
    const id = new ObjectId('64b7f0c2a1b2c3d4e5f60718');
    expect(keyString([1])).toBe(keyString(['1']));
    expect(keyString([id])).toBe(keyString(['64b7f0c2a1b2c3d4e5f60718']));
  });
});
