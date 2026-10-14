import { describe, expect, it } from 'vitest';
import { documentValuesEqual, valuesEqual } from '../src/common/values';
import { comparisonFor, differingFields } from '../src/sync/row-diff';

describe('comparisonFor', () => {
  it('tolerates representations on SQL targets, which convert bound text to the column type', () => {
    expect(comparisonFor('postgres')).toBe(valuesEqual);
    expect(comparisonFor('mysql')).toBe(valuesEqual);
  });

  it('compares types strictly on document targets, which store each value with its own type', () => {
    expect(comparisonFor('mongo')).toBe(documentValuesEqual);
    expect(comparisonFor('cosmos')).toBe(documentValuesEqual);
  });
});

describe('differingFields', () => {
  const expected = { id: 1, price: '12.50', active: '1' };
  const actual = { id: '1', price: '12.5', active: true };

  it('lists only real differences for a SQL target', () => {
    expect(differingFields(expected, actual, ['id', 'price', 'active'], comparisonFor('postgres'))).toEqual([]);
  });

  it('lists every change of type or text for a document target', () => {
    expect(differingFields(expected, actual, ['id', 'price', 'active'], comparisonFor('mongo'))).toEqual(['id', 'price', 'active']);
  });
});
