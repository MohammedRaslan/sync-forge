import { describe, expect, it } from 'vitest';
import { parseNaiveDate, toPgParam } from '../src/connectors/postgres/postgres.connector';

// The unit tests run in Europe/Athens (vitest.config.ts), so reading these as local time would fail here.
describe('parseNaiveDate', () => {
  it('reads a timestamp without time zone as UTC', () => {
    expect(parseNaiveDate('2025-03-01 10:00:00')).toEqual(new Date('2025-03-01T10:00:00.000Z'));
    expect(parseNaiveDate('2025-03-01 10:00:00.123456')).toEqual(new Date('2025-03-01T10:00:00.123Z'));
  });

  it('reads a date as UTC midnight', () => {
    expect(parseNaiveDate('2025-03-01')).toEqual(new Date('2025-03-01T00:00:00.000Z'));
  });

  it('keeps pg parsing for infinity', () => {
    expect(parseNaiveDate('infinity')).toBe(Infinity);
    expect(parseNaiveDate('-infinity')).toBe(-Infinity);
  });
});

describe('toPgParam', () => {
  it('binds dates as UTC ISO text, so naive columns store the UTC wall time', () => {
    expect(toPgParam(new Date('2025-03-01T10:00:00.000Z'))).toBe('2025-03-01T10:00:00.000Z');
  });

  it('binds objects as JSON text and leaves scalars alone', () => {
    expect(toPgParam({ a: 1 })).toBe('{"a":1}');
    expect(toPgParam(42)).toBe(42);
    expect(toPgParam(null)).toBeNull();
  });
});
