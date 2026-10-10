import { describe, expect, it } from 'vitest';
import { collapsePaths, getPath, isSafeFieldPath, unflatten } from '../src/common/paths';

describe('paths', () => {
  it('reads flat keys before nested paths', () => {
    expect(getPath({ 'a.b': 1, a: { b: 2 } }, 'a.b')).toBe(1);
    expect(getPath({ a: { b: 2 } }, 'a.b')).toBe(2);
    expect(getPath({ a: 'text' }, 'a.b')).toBeUndefined();
  });

  it('unflattens dotted keys', () => {
    expect(unflatten({ 'a.b': 1, 'a.c': 2, d: 3 })).toEqual({ a: { b: 1, c: 2 }, d: 3 });
  });

  it('rejects paths that could pollute prototypes or inject operators', () => {
    expect(isSafeFieldPath('__proto__.x')).toBe(false);
    expect(isSafeFieldPath('$where')).toBe(false);
    expect(isSafeFieldPath('a..b')).toBe(false);
    expect(() => unflatten({ '__proto__.polluted': true })).toThrow();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('collapses paths covered by an ancestor', () => {
    expect(collapsePaths(['address.city', 'address', 'name'])).toEqual(['address', 'name']);
  });
});
