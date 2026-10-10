import { getPath } from '../common/paths';
import { normalizeValue, valuesEqual } from '../common/values';
import { Row } from '../connectors/connector.types';

/** Target fields whose expected value differs from what the target holds (representation-tolerant). */
export function differingFields(expected: Row, actual: Row, fields: readonly string[]): string[] {
  return fields.filter((field) => !valuesEqual(expected[field], getPath(actual, field)));
}

/** A row's key values as people read them, e.g. "42" or "t1 / a". */
export function displayKey(row: Row, keyFields: readonly string[]): string {
  return keyFields.map((field) => String(normalizeValue(getPath(row, field)))).join(' / ');
}
