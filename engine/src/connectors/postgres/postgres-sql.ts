import { FilterOp, SourceFilter } from '../connector.types';

/**
 * Pure SQL builders for the Postgres connector. Identifiers are always quoted and
 * values always passed as parameters, so user-supplied table and column names can
 * never alter the statement.
 */

export interface TableRef {
  schema: string;
  table: string;
}

/** A user-written SELECT read as if it were a table. */
export interface QueryRef {
  query: string;
}

export interface SqlQuery {
  text: string;
  values: unknown[];
}

/** Postgres accepts at most 65535 bind parameters per statement. */
export const MAX_BIND_PARAMETERS = 65_000;

export function parseTableName(name: string): TableRef {
  const dot = name.indexOf('.');
  const ref = dot === -1 ? { schema: 'public', table: name } : { schema: name.slice(0, dot), table: name.slice(dot + 1) };
  if (!ref.schema || !ref.table) throw new Error(`Invalid table name "${name}", expected "schema.table"`);
  return ref;
}

export function quoteIdent(identifier: string): string {
  if (identifier.length === 0 || identifier.includes('\0')) {
    throw new Error(`Invalid identifier "${identifier}"`);
  }
  return `"${identifier.replace(/"/g, '""')}"`;
}

export function qualifiedName({ schema, table }: TableRef): string {
  return `${quoteIdent(schema)}.${quoteIdent(table)}`;
}

/**
 * Trims a query source and drops trailing semicolons so it can be wrapped as a subquery.
 * Wrapping (rather than string-appending WHERE/ORDER BY) keeps the user's SQL intact.
 */
export function normalizeQuery(query: string): string {
  const text = query.trim().replace(/;+\s*$/, '').trim();
  if (text.length === 0) throw new Error('The query is empty');
  return text;
}

/**
 * Wraps a query source as a subquery. A `--` comment on the last line would swallow the
 * closing parenthesis, so the parenthesis moves to its own line in that case.
 */
function wrapQuery(query: string): string {
  const text = normalizeQuery(query);
  const lastLine = text.slice(text.lastIndexOf('\n') + 1);
  return lastLine.includes('--') ? `(${text}\n)` : `(${text})`;
}

/** `"schema"."table"`, or `(SELECT …) AS "q"` for a query source. */
function fromClause(source: TableRef | QueryRef): string {
  return 'query' in source ? `${wrapQuery(source.query)} AS "q"` : qualifiedName(source);
}

/** "Not equal" also matches empty values, like MongoDB's $ne. */
const SQL_OPERATORS: Record<FilterOp, string> = {
  eq: '=',
  ne: 'IS DISTINCT FROM',
  gt: '>',
  gte: '>=',
  lt: '<',
  lte: '<=',
};

/** One condition per filter; values are appended to `values` and referenced by placeholder. */
function filterConditions(filters: readonly SourceFilter[], values: unknown[]): string[] {
  return filters.map((filter) => {
    values.push(filter.value);
    return `${quoteIdent(filter.field)} ${SQL_OPERATORS[filter.op]} $${values.length}`;
  });
}

function whereClause(conditions: readonly string[]): string {
  return conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : '';
}

export function buildSelect(
  source: TableRef | QueryRef,
  options: { columns?: string[]; watermark?: { column: string; from?: unknown }; filters?: readonly SourceFilter[] },
): SqlQuery {
  const { columns, watermark } = options;
  const selected = columns ? [...new Set([...columns, ...(watermark ? [watermark.column] : [])])] : undefined;
  const projection = selected ? selected.map(quoteIdent).join(', ') : '*';
  const values: unknown[] = [];
  const conditions = filterConditions(options.filters ?? [], values);
  if (watermark?.from !== undefined) {
    values.push(watermark.from);
    conditions.push(`${quoteIdent(watermark.column)} >= $${values.length}`);
  }

  let text = `SELECT ${projection} FROM ${fromClause(source)}${whereClause(conditions)}`;
  if (watermark) text += ` ORDER BY ${quoteIdent(watermark.column)} ASC NULLS LAST`;
  return { text, values };
}

export function buildCount(source: TableRef | QueryRef, filters: readonly SourceFilter[] = []): SqlQuery {
  const values: unknown[] = [];
  const where = whereClause(filterConditions(filters, values));
  return { text: `SELECT count(*)::bigint AS total FROM ${fromClause(source)}${where}`, values };
}

export function buildUpsert(table: TableRef, columns: string[], keyColumns: string[], rows: unknown[][]): SqlQuery {
  const width = columns.length;
  const placeholders = rows
    .map((_, rowIndex) => `(${columns.map((__, col) => `$${rowIndex * width + col + 1}`).join(', ')})`)
    .join(', ');
  const updates = columns
    .filter((column) => !keyColumns.includes(column))
    .map((column) => `${quoteIdent(column)} = EXCLUDED.${quoteIdent(column)}`);
  const onConflict = updates.length > 0 ? `DO UPDATE SET ${updates.join(', ')}` : 'DO NOTHING';

  return {
    text:
      `INSERT INTO ${qualifiedName(table)} (${columns.map(quoteIdent).join(', ')}) VALUES ${placeholders} ` +
      `ON CONFLICT (${keyColumns.map(quoteIdent).join(', ')}) ${onConflict}`,
    values: rows.flat(),
  };
}

export function buildKeyLookup(table: TableRef, keyColumns: string[], keys: unknown[][]): SqlQuery {
  const width = keyColumns.length;
  const tuples = keys
    .map((_, rowIndex) => `(${keyColumns.map((__, col) => `$${rowIndex * width + col + 1}`).join(', ')})`)
    .join(', ');
  return {
    text: `SELECT * FROM ${qualifiedName(table)} WHERE (${keyColumns.map(quoteIdent).join(', ')}) IN (${tuples})`,
    values: keys.flat(),
  };
}

/** A value as a SQL literal, for showing statements to people. Strings are quoted with '' escaping. */
export function sqlLiteral(value: unknown): string {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number' || typeof value === 'bigint') return String(value);
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  const text = value instanceof Date ? value.toISOString() : typeof value === 'string' ? value : JSON.stringify(value);
  return `'${text.replace(/'/g, "''")}'`;
}

/**
 * The statement with its parameters written in as literals, so people can copy and run it.
 * Display only: Syncforge itself always sends values as bound parameters.
 */
export function inlineSql({ text, values }: SqlQuery): string {
  return text.replace(/\$(\d+)/g, (placeholder, index: string) =>
    Number(index) <= values.length ? sqlLiteral(values[Number(index) - 1]) : placeholder,
  );
}
