import { describe, expect, it } from 'vitest';
import { TransformRegistry } from '../src/transforms/transform.registry';
import { normalizeValue } from '../src/common/values';

const registry = new TransformRegistry();
const apply = (name: Parameters<TransformRegistry['compile']>[0], value: unknown, argument?: string, row = {}) =>
  registry.compile(name, argument)(value, row);

describe('transforms', () => {
  it('converts types', () => {
    expect(apply('number', '42')).toBe(42);
    expect(apply('number', '')).toBeNull();
    expect(apply('boolean', 'Yes')).toBe(true);
    expect(apply('string', new Date('2024-01-01T00:00:00Z'))).toBe('2024-01-01T00:00:00.000Z');
    expect((apply('date', '2024-01-01') as Date).toISOString()).toBe('2024-01-01T00:00:00.000Z');
    // Epoch milliseconds as a number, as text (PostgreSQL bigint) and as a bigint.
    expect((apply('date', 1700000000000) as Date).toISOString()).toBe('2023-11-14T22:13:20.000Z');
    expect((apply('date', '1700000000000') as Date).toISOString()).toBe('2023-11-14T22:13:20.000Z');
    expect((apply('date', 1700000000000n) as Date).toISOString()).toBe('2023-11-14T22:13:20.000Z');
    expect((apply('date', '2024') as Date).toISOString()).toBe('2024-01-01T00:00:00.000Z');
  });

  it('reads a date-time text without an offset as UTC, whatever the machine zone', () => {
    // The unit-test config runs in Europe/Athens; local parsing would be off by two hours.
    expect((apply('date', '2025-03-01 10:00:00') as Date).toISOString()).toBe('2025-03-01T10:00:00.000Z');
    expect((apply('date', '2025-03-01T10:00:00') as Date).toISOString()).toBe('2025-03-01T10:00:00.000Z');
    expect((apply('date', '2025-03-01T10:00:00+02:00') as Date).toISOString()).toBe('2025-03-01T08:00:00.000Z');
    expect((apply('date', '2025-03-01') as Date).toISOString()).toBe('2025-03-01T00:00:00.000Z');
  });

  it('passes nulls through', () => {
    expect(apply('uppercase', null)).toBeNull();
    expect(apply('number', undefined)).toBeNull();
  });

  it('fails loudly on bad input', () => {
    expect(() => apply('number', 'abc')).toThrow('not a number');
    expect(() => apply('boolean', 'maybe')).toThrow('not a boolean');
    // Compact dates and epoch seconds as text are not read as milliseconds.
    expect(() => apply('date', '20240131')).toThrow('not a valid date');
    expect(() => apply('date', '1700000000')).toThrow('not a valid date');
    expect(() => apply('date', true)).toThrow('not a valid date');
  });

  it('parses constant and default arguments as JSON when possible', () => {
    expect(apply('constant', 'ignored', '1')).toBe(1);
    expect(apply('constant', 'ignored', 'legacy')).toBe('legacy');
    expect(apply('default', null, 'true')).toBe(true);
    expect(apply('default', 'kept', 'true')).toBe('kept');
  });

  it('evaluates expressions against the value and the row', () => {
    expect(apply('expression', 'x', "row.first + ' ' + row.last", { first: 'Ada', last: 'Lovelace' })).toBe('Ada Lovelace');
    const date = apply('expression', 0, 'new Date(value)');
    expect(date).toBeInstanceOf(Date);
  });

  it('brings dates nested in an expression result back as real Dates', () => {
    const result = normalizeValue(apply('expression', 0, '({ at: new Date(0), list: [new Date(0)] })')) as { at: unknown; list: unknown[] };
    expect(result.at).toEqual(new Date(0));
    expect(result.list[0]).toEqual(new Date(0));
  });

  it('passes objects from the row through an expression unchanged', () => {
    class Id {
      constructor(readonly hex: string) {}
    }
    const id = new Id('abc');
    expect((apply('expression', id, '({ id: value })') as { id: unknown }).id).toBe(id);
  });

  it('rejects invalid or runaway expressions', () => {
    expect(() => registry.compile('expression', 'row.(')).toThrow('Invalid expression');
    expect(() => registry.compile('constant', '')).toThrow('needs a value');
    expect(() => apply('expression', 0, '(() => { while (true) {} })()')).toThrow(/timed out/);
  });
});
