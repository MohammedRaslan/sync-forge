import { ObjectId, Decimal128, Long } from 'mongodb';
import { describe, expect, it } from 'vitest';
import { documentValuesEqual, keyString, normalizeValue, parseDateText, valuesEqual } from '../src/common/values';

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

  it('reads a date-time text without an offset as UTC, whatever the machine zone', () => {
    // The unit-test config runs in Europe/Athens; local parsing would be off by two hours.
    expect(new Date(2025, 2, 1).getTimezoneOffset()).not.toBe(0);
    const tenUtc = new Date('2025-03-01T10:00:00Z');
    expect(valuesEqual(tenUtc, '2025-03-01 10:00:00')).toBe(true);
    expect(valuesEqual('2025-03-01T10:00:00', tenUtc)).toBe(true);
    expect(valuesEqual(tenUtc, '2025-03-01T12:00:00+02:00')).toBe(true);
    expect(valuesEqual(new Date('2025-03-01T00:00:00Z'), '2025-03-01')).toBe(true);
    expect(valuesEqual(tenUtc, '2025-03-01T08:00:00')).toBe(false);
    expect(valuesEqual(tenUtc, tenUtc.getTime())).toBe(true);
  });

  it('compares two canonical decimal texts as numbers', () => {
    expect(valuesEqual('12.5', '12.50')).toBe(true);
    expect(valuesEqual('12.500', '12.5')).toBe(true);
    expect(valuesEqual('-3', '-3.0')).toBe(true);
    expect(valuesEqual('0.5', '0.50')).toBe(true);
    expect(valuesEqual('-0', '0.0')).toBe(true);
    expect(valuesEqual('100', '100.0')).toBe(true);
    // Exact, not via a double: these two differ only beyond 2^53.
    expect(valuesEqual('12345678901234567890.1', '12345678901234567890.10')).toBe(true);
    expect(valuesEqual('12345678901234567890.1', '12345678901234567890.2')).toBe(false);
  });

  it('keeps texts that are codes rather than numbers distinct', () => {
    expect(valuesEqual('00123', '123')).toBe(false);
    expect(valuesEqual('1e3', '1000')).toBe(false);
    expect(valuesEqual(' 12', '12')).toBe(false);
    expect(valuesEqual('12.', '12')).toBe(false);
    expect(valuesEqual('.5', '0.5')).toBe(false);
    expect(valuesEqual('+5', '5')).toBe(false);
    expect(valuesEqual('100', '10')).toBe(false);
  });

  it('compares a number with its text form', () => {
    expect(valuesEqual('1', 1)).toBe(true);
    expect(valuesEqual(12.5, '12.500')).toBe(true);
    expect(valuesEqual(2, '1')).toBe(false);
  });

  it('reads boolean words as the boolean on the other side', () => {
    for (const word of ['t', 'true', 'TRUE', 'True', '1']) expect(valuesEqual(word, true), word).toBe(true);
    for (const word of ['f', 'false', 'FALSE', '0']) expect(valuesEqual(false, word), word).toBe(true);
    expect(valuesEqual('t', false)).toBe(false);
    expect(valuesEqual('0', true)).toBe(false);
    expect(valuesEqual('yes', true)).toBe(false);
    expect(valuesEqual(1, true)).toBe(true);
    expect(valuesEqual(true, true)).toBe(true);
    expect(valuesEqual(true, false)).toBe(false);
  });

  it('leaves text against text alone for boolean words', () => {
    expect(valuesEqual('t', 'true')).toBe(false);
    expect(valuesEqual('TRUE', 'true')).toBe(false);
  });

  it('reads version-like texts as decimals: the price of tolerating NUMERIC text', () => {
    expect(valuesEqual('1.10', '1.1')).toBe(true);
  });
});

describe('documentValuesEqual', () => {
  it('counts a change of type between text, number and boolean as a difference', () => {
    expect(documentValuesEqual('1', true)).toBe(false);
    expect(documentValuesEqual('1', 1)).toBe(false);
    expect(documentValuesEqual(1, true)).toBe(false);
    expect(documentValuesEqual('true', true)).toBe(false);
    expect(documentValuesEqual('{"a":1}', { a: 1 })).toBe(false);
  });

  it('compares texts exactly', () => {
    expect(documentValuesEqual('12.5', '12.50')).toBe(false);
    expect(documentValuesEqual('Cairo', 'Cairo')).toBe(true);
  });

  it('treats the same value of the same type as equal, whatever the driver type', () => {
    expect(documentValuesEqual(1, 1)).toBe(true);
    expect(documentValuesEqual(true, true)).toBe(true);
    expect(documentValuesEqual(undefined, null)).toBe(true);
    expect(documentValuesEqual(7, Long.fromNumber(7))).toBe(true);
    expect(documentValuesEqual(Decimal128.fromString('12.50'), '12.50')).toBe(true);
    expect(documentValuesEqual({ b: [1, 2], a: 'x' }, { a: 'x', b: [1, 2] })).toBe(true);
    expect(documentValuesEqual({ a: 1 }, { a: '1' })).toBe(false);
  });

  it('accepts a date read back as the ISO text Cosmos DB stores, but not text written over a date', () => {
    const at = new Date('2025-03-01T10:00:00Z');
    expect(documentValuesEqual(at, new Date(at))).toBe(true);
    expect(documentValuesEqual(at, '2025-03-01T10:00:00.000Z')).toBe(true);
    expect(documentValuesEqual(at, '2025-03-01T10:00:00Z')).toBe(false);
    expect(documentValuesEqual(at, at.getTime())).toBe(false);
    expect(documentValuesEqual('2025-03-01T10:00:00.000Z', at)).toBe(false);
  });
});

describe('keyString', () => {
  it('matches keys across drivers', () => {
    const id = new ObjectId('64b7f0c2a1b2c3d4e5f60718');
    expect(keyString([1])).toBe(keyString(['1']));
    expect(keyString([id])).toBe(keyString(['64b7f0c2a1b2c3d4e5f60718']));
  });

  it('keeps the exact text of a key, unlike valuesEqual', () => {
    expect(keyString(['12.5'])).not.toBe(keyString(['12.50']));
    expect(keyString([true])).not.toBe(keyString(['t']));
  });
});

describe('parseDateText', () => {
  it('reads a date-time without an offset as UTC, and keeps an explicit offset', () => {
    expect(parseDateText('2025-01-31T08:00')).toBe(Date.UTC(2025, 0, 31, 8));
    expect(parseDateText(' 2025-01-31T08:00:30.5 ')).toBe(Date.UTC(2025, 0, 31, 8, 0, 30, 500));
    expect(parseDateText('2025-01-31T08:00:00+02:00')).toBe(Date.UTC(2025, 0, 31, 6));
    expect(parseDateText('2025-01-31')).toBe(Date.UTC(2025, 0, 31));
  });

  it('accepts a space between date and time, as SQL databases write it', () => {
    expect(parseDateText('2025-03-01 10:00:00')).toBe(Date.UTC(2025, 2, 1, 10));
    expect(parseDateText('2025-03-01 10:00:00.123456')).toBe(Date.UTC(2025, 2, 1, 10, 0, 0, 123));
    expect(parseDateText('2025-03-01 10:00:00+02:00')).toBe(Date.UTC(2025, 2, 1, 8));
  });

  it('gives NaN for empty or non-date text', () => {
    expect(parseDateText('')).toBeNaN();
    expect(parseDateText('   ')).toBeNaN();
    expect(parseDateText('soon')).toBeNaN();
  });
});
