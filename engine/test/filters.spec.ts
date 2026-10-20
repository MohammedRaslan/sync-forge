import { describe, expect, it } from 'vitest';
import { matchesFilters } from '../src/common/filters';
import { SourceFilter } from '../src/connectors/connector.types';

const filter = (field: string, op: SourceFilter['op'], value: unknown): SourceFilter => ({ field, op, value });

describe('matchesFilters on CSV cells (text)', () => {
  it('matches every row when there are no filters', () => {
    expect(matchesFilters({ a: null }, [])).toBe(true);
  });

  it('compares text ordinally', () => {
    const row = { status: 'paid' };
    expect(matchesFilters(row, [filter('status', 'eq', 'paid')])).toBe(true);
    expect(matchesFilters(row, [filter('status', 'eq', 'Paid')])).toBe(false);
    expect(matchesFilters(row, [filter('status', 'gt', 'open')])).toBe(true);
    expect(matchesFilters(row, [filter('status', 'lte', 'open')])).toBe(false);
  });

  it('reads cells as numbers for a number filter', () => {
    const row = { amount: '10.50' };
    expect(matchesFilters(row, [filter('amount', 'eq', 10.5)])).toBe(true);
    expect(matchesFilters(row, [filter('amount', 'gt', 9)])).toBe(true);
    // Text order would put "10.50" before "9".
    expect(matchesFilters(row, [filter('amount', 'lt', 9)])).toBe(false);
    expect(matchesFilters(row, [filter('amount', 'gte', 10.5), filter('amount', 'lte', 10.5)])).toBe(true);
  });

  it('does not match a cell that is not a number against a number filter', () => {
    for (const op of ['eq', 'ne', 'gt', 'lt'] as const) {
      expect(matchesFilters({ amount: 'n/a' }, [filter('amount', op, 5)]), op).toBe(false);
    }
    expect(matchesFilters({ amount: '' }, [filter('amount', 'eq', 0)])).toBe(false);
  });

  it('reads cells as dates for a date filter, without an offset meaning UTC', () => {
    const since = new Date('2025-01-01T00:00:00Z');
    expect(matchesFilters({ at: '2025-03-01' }, [filter('at', 'gt', since)])).toBe(true);
    expect(matchesFilters({ at: '2024-12-31T23:59:59' }, [filter('at', 'lt', since)])).toBe(true);
    expect(matchesFilters({ at: '2025-01-01T00:00:00' }, [filter('at', 'eq', since)])).toBe(true);
    expect(matchesFilters({ at: 'soon' }, [filter('at', 'ne', since)])).toBe(false);
  });

  it('reads true/false/1/0 for a boolean filter', () => {
    expect(matchesFilters({ active: 'true' }, [filter('active', 'eq', true)])).toBe(true);
    expect(matchesFilters({ active: '1' }, [filter('active', 'eq', true)])).toBe(true);
    expect(matchesFilters({ active: '0' }, [filter('active', 'ne', true)])).toBe(true);
    expect(matchesFilters({ active: 'yes' }, [filter('active', 'eq', true)])).toBe(false);
  });

  it('treats cells named like object properties as unreadable for a boolean filter', () => {
    for (const cell of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
      expect(matchesFilters({ active: cell }, [filter('active', 'ne', true)]), cell).toBe(false);
      expect(matchesFilters({ active: cell }, [filter('active', 'eq', false)]), cell).toBe(false);
    }
  });

  it('matches an empty cell only for "not equal"', () => {
    for (const op of ['eq', 'gt', 'gte', 'lt', 'lte'] as const) {
      expect(matchesFilters({ status: null }, [filter('status', op, 'paid')]), op).toBe(false);
    }
    expect(matchesFilters({ status: null }, [filter('status', 'ne', 'paid')])).toBe(true);
    expect(matchesFilters({}, [filter('status', 'ne', 5)])).toBe(true);
  });

  it('needs every filter to match', () => {
    const row = { amount: '20', status: 'open' };
    expect(matchesFilters(row, [filter('amount', 'gt', 10), filter('status', 'eq', 'paid')])).toBe(false);
  });
});

describe('matchesFilters on JSON values', () => {
  it('compares JSON numbers with a number filter numerically', () => {
    expect(matchesFilters({ amount: 10.5 }, [filter('amount', 'eq', 10.5)])).toBe(true);
    expect(matchesFilters({ amount: 10 }, [filter('amount', 'gt', 9)])).toBe(true);
    expect(matchesFilters({ amount: 0 }, [filter('amount', 'eq', 0)])).toBe(true);
  });

  it('compares JSON numbers with a text filter as their text', () => {
    expect(matchesFilters({ id: 42 }, [filter('id', 'eq', '42')])).toBe(true);
  });

  it('compares JSON booleans with a boolean filter', () => {
    expect(matchesFilters({ active: true }, [filter('active', 'eq', true)])).toBe(true);
    expect(matchesFilters({ active: false }, [filter('active', 'ne', true)])).toBe(true);
    expect(matchesFilters({ active: false }, [filter('active', 'eq', true)])).toBe(false);
  });

  it('does not match a JSON boolean against a number filter', () => {
    expect(matchesFilters({ active: true }, [filter('active', 'eq', 1)])).toBe(false);
  });

  it('reads a nested field by its dotted path', () => {
    const row = { customer: { address: { city: 'Athens' } } };
    expect(matchesFilters(row, [filter('customer.address.city', 'eq', 'Athens')])).toBe(true);
    expect(matchesFilters(row, [filter('customer.address.zip', 'ne', '100')])).toBe(true);
  });

  it('prefers a flat key literally named with a dot over the nested path', () => {
    const row = { 'a.b': 'flat', a: { b: 'nested' } };
    expect(matchesFilters(row, [filter('a.b', 'eq', 'flat')])).toBe(true);
  });

  it('never matches an object or an array, not even for "not equal"', () => {
    for (const value of [{ x: 1 }, [1, 2], []]) {
      for (const op of ['eq', 'ne', 'gt', 'lt'] as const) {
        expect(matchesFilters({ tags: value }, [filter('tags', op, '1')]), `${op} ${JSON.stringify(value)}`).toBe(false);
      }
    }
  });
});
