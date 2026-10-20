import { getPath } from '../common/paths';
import { documentValuesEqual, normalizeValue, valuesEqual } from '../common/values';
import { ConnectionKind } from '../connections/connection.model';
import { Row } from '../connectors/connector.types';

/** Whether a value read back from the target equals the value a run writes there. */
export type ValueComparison = (expected: unknown, actual: unknown) => boolean;

/**
 * SQL databases convert bound text to the column type, so a different spelling is not a change there.
 * MongoDB and Cosmos DB store each value with its own type, so a change of type is. CSV files hold only text.
 * HTTP APIs return JSON, typed like documents.
 */
const COMPARISON_BY_KIND: Readonly<Record<ConnectionKind, ValueComparison>> = {
  postgres: valuesEqual,
  mysql: valuesEqual,
  csv: valuesEqual,
  mongo: documentValuesEqual,
  cosmos: documentValuesEqual,
  http: documentValuesEqual,
};

/** How dry runs and reconciliation decide that a field on a target of this kind would change. */
export function comparisonFor(kind: ConnectionKind): ValueComparison {
  return COMPARISON_BY_KIND[kind];
}

/** Target fields whose expected value differs from what the target holds, as `equal` decides. */
export function differingFields(expected: Row, actual: Row, fields: readonly string[], equal: ValueComparison): string[] {
  return fields.filter((field) => !equal(expected[field], getPath(actual, field)));
}

/** A row's key values as people read them, e.g. "42" or "t1 / a". */
export function displayKey(row: Row, keyFields: readonly string[]): string {
  return keyFields.map((field) => String(normalizeValue(getPath(row, field)))).join(' / ');
}
