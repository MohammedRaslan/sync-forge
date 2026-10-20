/**
 * Source filters applied in memory, for connectors whose source cannot run them (CSV files, HTTP APIs).
 * Values are compared as text read as the filter value's type, so a CSV cell "10.5" and a JSON number 10.5
 * meet a number filter the same way.
 */
import type { FilterOp, Row, SourceFilter } from '../connectors/connector.types';
import { getPath } from './paths';
import { parseDateText } from './values';

/**
 * True when a row meets every filter. A field is read with {@link getPath} (a flat key wins, then a dotted
 * path). Each scalar value is read as the filter value's type; a value that cannot be read that way does not
 * match, and neither does an object or array. "Not equal" also matches missing (null) values, like the
 * database connectors.
 */
export function matchesFilters(row: Row, filters: readonly SourceFilter[]): boolean {
  return filters.every((filter) => matchesFilter(getPath(row, filter.field), filter));
}

function matchesFilter(value: unknown, filter: SourceFilter): boolean {
  if (value === null || value === undefined) return filter.op === 'ne';
  // A nested document or list has no single value to compare. CSV cells and JSON values hold no Dates.
  if (typeof value === 'object') return false;
  const order = compareText(String(value), filter.value);
  return order !== undefined && OP_MATCHES[filter.op](order);
}

const OP_MATCHES: Record<FilterOp, (order: number) => boolean> = {
  eq: (order) => order === 0,
  ne: (order) => order !== 0,
  gt: (order) => order > 0,
  gte: (order) => order >= 0,
  lt: (order) => order < 0,
  lte: (order) => order <= 0,
};

/** Negative, zero or positive as the text sorts before, with or after the value; undefined when it cannot be read as the value's type. */
function compareText(text: string, value: unknown): number | undefined {
  if (typeof value === 'number') {
    const number = text.trim() === '' ? Number.NaN : Number(text);
    return Number.isFinite(number) ? Math.sign(number - value) : undefined;
  }
  if (value instanceof Date) {
    // Read like a date filter value: without an offset, a date-time means UTC.
    const time = parseDateText(text);
    return Number.isNaN(time) ? undefined : Math.sign(time - value.getTime());
  }
  if (typeof value === 'boolean') {
    const flag = BOOLEAN_TEXT.get(text.trim().toLowerCase());
    return flag === undefined ? undefined : Number(flag) - Number(value);
  }
  const expected = String(value);
  return text === expected ? 0 : text < expected ? -1 : 1;
}

/** A Map, not an object literal, so text such as "constructor" finds no inherited property. */
const BOOLEAN_TEXT: ReadonlyMap<string, boolean> = new Map([
  ['true', true],
  ['false', false],
  ['1', true],
  ['0', false],
]);
