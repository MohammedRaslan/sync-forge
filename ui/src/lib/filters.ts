import type { FilterOp, FilterValueType, SourceFilter } from '../api/types';

export const FILTER_OP_LABEL: Record<FilterOp, string> = { eq: '=', ne: '≠', gt: '>', gte: '≥', lt: '<', lte: '≤' };

export const FILTER_VALUE_PLACEHOLDER: Record<FilterValueType, string> = {
  string: 'text',
  number: '100',
  date: '2025-01-31 or 2025-01-31T08:00:00Z',
  boolean: 'true or false',
};

/** A sensible value type for a field, from the type the schema browser reports (Postgres, MongoDB or Cosmos DB names). */
export function filterTypeFor(fieldType: string | undefined): FilterValueType {
  const type = (fieldType ?? '').toLowerCase();
  if (/timestamp|date|time/.test(type)) return 'date';
  if (/^bool/.test(type)) return 'boolean';
  if (/int|numeric|decimal|real|double|float|number|serial|money/.test(type)) return 'number';
  return 'string';
}

/** "created_at > 2025-01-31", for summaries. */
export function describeFilter(filter: SourceFilter): string {
  const value = filter.type === 'string' ? `"${filter.value}"` : filter.value;
  return `${filter.field} ${FILTER_OP_LABEL[filter.op]} ${value}`;
}
