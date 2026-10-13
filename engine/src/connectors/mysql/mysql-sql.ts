import { SqlValue, escape, format } from 'mysql2';
import { FilterOp, SourceFilter } from '../connector.types';

/**
 * Pure SQL builders for the MySQL connector. Identifiers are always quoted.
 *
 * Writes and key lookups return `?` placeholders with values, run as server-side prepared statements.
 * Reads return finished SQL with values escaped by the driver into the parts Syncforge adds: a read may
 * wrap a user-written query, and placeholder substitution would also hit a `?` inside that query's text.
 */

/** `database.table`, or just `table` for the connection's database. */
export interface MysqlTableRef {
  database?: string;
  table: string;
}

/** A user-written SELECT read as if it were a table. */
export interface MysqlQueryRef {
  query: string;
}

export interface MysqlStatement {
  sql: string;
  values: unknown[];
}

/** Prepared statements accept at most 65,535 placeholders. */
export const MAX_PLACEHOLDERS = 60_000;

export function parseMysqlTableName(name: string): MysqlTableRef {
  const dot = name.indexOf('.');
  const ref = dot === -1 ? { table: name } : { database: name.slice(0, dot), table: name.slice(dot + 1) };
  if (!ref.table || ref.database === '') throw new Error(`Invalid table name "${name}", expected "table" or "database.table"`);
  return ref;
}

export function quoteIdent(identifier: string): string {
  if (identifier.length === 0 || identifier.includes('\0')) throw new Error(`Invalid identifier "${identifier}"`);
  return `\`${identifier.replace(/`/g, '``')}\``;
}

export function qualifiedName({ database, table }: MysqlTableRef): string {
  return database ? `${quoteIdent(database)}.${quoteIdent(table)}` : quoteIdent(table);
}

/** A value as a MySQL literal: dates in UTC (the connector reads and writes UTC), objects as JSON text. */
export function mysqlLiteral(value: unknown): string {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  if (typeof value === 'object' && !(value instanceof Date)) return escape(JSON.stringify(value));
  return escape(value as SqlValue, false, 'Z');
}

/** A prepared statement with its values written in, for people to read and run. Display only. */
export function inlineStatement({ sql, values }: MysqlStatement): string {
  const printable = values.map((value) =>
    typeof value === 'object' && value !== null && !(value instanceof Date) ? JSON.stringify(value) : value,
  );
  return format(sql, printable as SqlValue[], false, 'Z');
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
 * Wraps a query source as a subquery. A `--` or `#` comment on the last line would swallow
 * the closing parenthesis, so the parenthesis moves to its own line in that case.
 */
function wrapQuery(query: string): string {
  const text = normalizeQuery(query);
  const lastLine = text.slice(text.lastIndexOf('\n') + 1);
  return /--|#/.test(lastLine) ? `(${text}\n)` : `(${text})`;
}

function fromClause(source: MysqlTableRef | MysqlQueryRef): string {
  return 'query' in source ? `${wrapQuery(source.query)} AS \`q\`` : qualifiedName(source);
}

/** "Not equal" also matches empty values (`<=>` is MySQL's null-safe equality), like MongoDB's $ne. */
function condition(column: string, op: FilterOp, value: unknown): string {
  const operators: Record<Exclude<FilterOp, 'ne'>, string> = { eq: '=', gt: '>', gte: '>=', lt: '<', lte: '<=' };
  return op === 'ne' ? `NOT (${column} <=> ${mysqlLiteral(value)})` : `${column} ${operators[op]} ${mysqlLiteral(value)}`;
}

function whereClause(conditions: readonly string[]): string {
  return conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : '';
}

function filterConditions(filters: readonly SourceFilter[]): string[] {
  return filters.map((filter) => condition(quoteIdent(filter.field), filter.op, filter.value));
}

export function buildSelect(
  source: MysqlTableRef | MysqlQueryRef,
  options: {
    columns?: string[];
    watermark?: { column: string; from?: unknown };
    filters?: readonly SourceFilter[];
    limit?: number;
  },
): string {
  const { columns, watermark } = options;
  const selected = columns ? [...new Set([...columns, ...(watermark ? [watermark.column] : [])])] : undefined;
  const projection = selected ? selected.map(quoteIdent).join(', ') : '*';
  const conditions = filterConditions(options.filters ?? []);
  if (watermark?.from !== undefined) conditions.push(condition(quoteIdent(watermark.column), 'gte', watermark.from));

  let sql = `SELECT ${projection} FROM ${fromClause(source)}${whereClause(conditions)}`;
  // MySQL sorts NULL first; "IS NULL" first puts them last, like Postgres' NULLS LAST.
  if (watermark) sql += ` ORDER BY ${quoteIdent(watermark.column)} IS NULL, ${quoteIdent(watermark.column)} ASC`;
  if (options.limit !== undefined) sql += ` LIMIT ${Math.max(0, Math.floor(options.limit))}`;
  return sql;
}

export function buildCount(source: MysqlTableRef | MysqlQueryRef, filters: readonly SourceFilter[] = []): string {
  return `SELECT COUNT(*) AS total FROM ${fromClause(source)}${whereClause(filterConditions(filters))}`;
}

/** `(a, b) IN ((?, ?), …)`, or `a IN (?, …)` for a single key column. */
function keyCondition(keyColumns: readonly string[], keyCount: number): string {
  if (keyColumns.length === 1) return `${quoteIdent(keyColumns[0])} IN (${Array(keyCount).fill('?').join(', ')})`;
  const tuple = `(${keyColumns.map(() => '?').join(', ')})`;
  return `(${keyColumns.map(quoteIdent).join(', ')}) IN (${Array(keyCount).fill(tuple).join(', ')})`;
}

export function buildKeyLookup(table: MysqlTableRef, keyColumns: string[], keys: unknown[][]): MysqlStatement {
  return { sql: `SELECT * FROM ${qualifiedName(table)} WHERE ${keyCondition(keyColumns, keys.length)}`, values: keys.flat() };
}

/** The keys among `keys` that already exist, locked until the batch's transaction ends. */
export function buildExistingKeys(table: MysqlTableRef, keyColumns: string[], keys: unknown[][]): MysqlStatement {
  const projection = keyColumns.map(quoteIdent).join(', ');
  return {
    sql: `SELECT ${projection} FROM ${qualifiedName(table)} WHERE ${keyCondition(keyColumns, keys.length)} FOR UPDATE`,
    values: keys.flat(),
  };
}

export function buildInsert(table: MysqlTableRef, columns: string[], rows: unknown[][]): MysqlStatement {
  const tuple = `(${columns.map(() => '?').join(', ')})`;
  return {
    sql: `INSERT INTO ${qualifiedName(table)} (${columns.map(quoteIdent).join(', ')}) VALUES ${Array(rows.length).fill(tuple).join(', ')}`,
    values: rows.flat(),
  };
}

/** UPDATE of one row matched on its key columns; undefined when every column is a key (nothing to update). */
export function buildUpdate(table: MysqlTableRef, row: Record<string, unknown>, keyColumns: string[]): MysqlStatement | undefined {
  const changed = Object.keys(row).filter((column) => !keyColumns.includes(column));
  if (changed.length === 0) return undefined;
  return {
    sql:
      `UPDATE ${qualifiedName(table)} SET ${changed.map((column) => `${quoteIdent(column)} = ?`).join(', ')} ` +
      `WHERE ${keyColumns.map((column) => `${quoteIdent(column)} = ?`).join(' AND ')}`,
    values: [...changed.map((column) => row[column]), ...keyColumns.map((column) => row[column])],
  };
}
