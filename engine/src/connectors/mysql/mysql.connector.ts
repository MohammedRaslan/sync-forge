import { FieldPacket, Pool, PoolConnection, RowDataPacket, TypeCast, Types, createPool } from 'mysql2';
import { Pool as PromisePool, PoolConnection as PromisePoolConnection } from 'mysql2/promise';
import { chunk } from '../../common/collections';
import { NotFoundError, ValidationError } from '../../common/errors';
import { keyString, normalizeValue } from '../../common/values';
import { MysqlConfig } from '../../connections/connection.model';
import { CollectionInfo, Connector, FieldInfo, ReadRequest, Row, SourceScope } from '../connector.types';
import { fromStoredWatermark } from '../../sync/watermark';
import {
  MAX_PLACEHOLDERS,
  MysqlQueryRef,
  MysqlStatement,
  MysqlTableRef,
  buildCount,
  buildExistingKeys,
  buildInsert,
  buildKeyLookup,
  buildSelect,
  buildUpdate,
  inlineStatement,
  parseMysqlTableName,
} from './mysql-sql';

const START_READ_ONLY = 'START TRANSACTION READ ONLY';

/** TINYINT(1) is MySQL's boolean: read it as true/false so it compares equal to booleans from other databases. */
const readBooleans: TypeCast = (field, next) => {
  if (field.type === 'TINY' && field.length === 1) {
    const text = field.string();
    return text === null ? null : text === '1';
  }
  return next();
};

/** Values bound as parameters: objects and arrays become JSON text (for JSON columns), bigints strings. */
export function toMysqlParam(value: unknown): unknown {
  const normalized = normalizeValue(value);
  if (normalized === null || normalized instanceof Date || typeof normalized !== 'object') return normalized;
  return JSON.stringify(normalized);
}

/**
 * MySQL 5.7+ and 8.x. Dates are read and written in UTC (`timezone: 'Z'`), BIGINT and DECIMAL come back
 * as strings so no digits are lost, and TINYINT(1) as booleans.
 *
 * Writes match rows on the job's key fields only. `ON DUPLICATE KEY UPDATE` is deliberately not used: it
 * matches on any unique index, so a row clashing on another unique column (say email) would silently update
 * a different row. Instead each batch, in one transaction, finds which keys exist, inserts the rest and
 * updates those; a clash on another unique index then fails the row, as in PostgreSQL.
 */
export class MysqlConnector implements Connector {
  private readonly pool: Pool;
  private readonly db: PromisePool;

  constructor(config: MysqlConfig) {
    this.pool = createPool({
      host: config.host,
      port: config.port,
      database: config.database,
      user: config.user,
      password: config.password || undefined,
      ssl: config.ssl === 'disable' ? undefined : { rejectUnauthorized: config.ssl === 'verify-full' },
      connectionLimit: 4,
      connectTimeout: 10_000,
      timezone: 'Z',
      supportBigNumbers: true,
      bigNumberStrings: true,
      typeCast: readBooleans,
    });
    this.db = this.pool.promise();
  }

  async ping(): Promise<void> {
    await this.db.query('SELECT 1');
  }

  async close(): Promise<void> {
    await this.db.end();
  }

  async listCollections(): Promise<CollectionInfo[]> {
    const [rows] = await this.db.query<RowDataPacket[]>(
      `SELECT table_name AS name, table_type AS type
         FROM information_schema.tables
        WHERE table_schema = DATABASE()
        ORDER BY table_name`,
    );
    return rows.map((row) => ({ name: String(row.name), kind: row.type === 'VIEW' ? 'view' : 'table' }));
  }

  async describeCollection(collection: string): Promise<FieldInfo[]> {
    const { database, table } = parseMysqlTableName(collection);
    const [rows] = await this.db.execute<RowDataPacket[]>(
      `SELECT column_name AS name, data_type AS dataType, column_type AS columnType,
              is_nullable AS nullable, column_key AS columnKey
         FROM information_schema.columns
        WHERE table_schema = COALESCE(?, DATABASE()) AND table_name = ?
        ORDER BY ordinal_position`,
      [database ?? null, table],
    );
    if (rows.length === 0) throw new NotFoundError(`Table "${collection}" was not found or has no columns`);
    return rows.map((row) => ({
      path: String(row.name),
      type: String(row.columnType).toLowerCase() === 'tinyint(1)' ? 'boolean' : String(row.dataType),
      nullable: row.nullable === 'YES',
      primaryKey: row.columnKey === 'PRI',
    }));
  }

  async *readBatches(request: ReadRequest): AsyncIterable<Row[]> {
    const sql = selectFor(request);
    const connection = await this.coreConnection();
    const readOnly = request.query !== undefined;
    let drained = false;
    try {
      if (readOnly) await connection.promise().query(START_READ_ONLY);
      // A streamed query keeps memory bounded by the batch size instead of loading the table.
      const stream = connection.query(sql).stream();
      let batch: Row[] = [];
      for await (const row of stream as AsyncIterable<Row>) {
        if (request.signal?.aborted) return;
        batch.push(row);
        if (batch.length >= request.batchSize) {
          yield batch;
          batch = [];
        }
      }
      if (batch.length > 0) yield batch;
      drained = true;
    } finally {
      await this.finish(connection, { drained, readOnly });
    }
  }

  async count(collection: string, scope: SourceScope = {}): Promise<number> {
    const sql = buildCount(sourceOf(collection, scope.query), scope.filters?.map(toMysqlFilter));
    const run = async (connection: PromisePoolConnection | PromisePool) => (await connection.query<RowDataPacket[]>(sql))[0];
    const rows = scope.query === undefined ? await run(this.db) : await this.readOnly(run);
    return Number(rows[0].total);
  }

  explainRead(request: ReadRequest): string {
    const text = `${selectFor(request)};`;
    return request.query === undefined ? text : `${text}\n-- runs in a READ ONLY transaction`;
  }

  async describeQuery(query: string): Promise<FieldInfo[]> {
    const fields = await this.readOnly(async (connection) => {
      const [, columns] = await connection.query(buildSelect({ query }, { limit: 0 }));
      return columns as FieldPacket[];
    });
    return fields.map((field) => ({ path: field.name, type: typeName(field), nullable: true, primaryKey: false }));
  }

  async upsert(collection: string, rows: Row[], keyFields: string[]): Promise<void> {
    if (rows.length === 0) return;
    const connection = await this.db.getConnection();
    try {
      // One transaction per batch: a batch is written completely or not at all.
      await connection.beginTransaction();
      for (const statement of await this.writeStatements(connection, collection, rows, keyFields)) {
        await connection.execute(statement.sql, statement.values as never);
      }
      await connection.commit();
    } catch (error) {
      await connection.rollback().catch(() => undefined); // the original error matters, not a failed rollback
      throw error;
    } finally {
      connection.release();
    }
  }

  async findByKeys(collection: string, keyFields: string[], keys: Row[]): Promise<Row[]> {
    if (keys.length === 0) return [];
    const found: Row[] = [];
    for (const statement of keyLookupsFor(collection, keyFields, keys)) {
      const [rows] = await this.db.execute<RowDataPacket[]>(statement.sql, statement.values as never);
      found.push(...rows);
    }
    return found;
  }

  explainFindByKeys(collection: string, keyFields: string[], keys: Row[]): string {
    return keyLookupsFor(collection, keyFields, keys).map((statement) => `${inlineStatement(statement)};`).join('\n');
  }

  explainUpsert(collection: string, rows: Row[], keyFields: string[]): string {
    if (rows.length === 0) return '-- nothing to write';
    const table = parseMysqlTableName(collection);
    const keys = rows.map((row) => keyFields.map((field) => toMysqlParam(row[field])));
    const updates = rows.map((row) => buildUpdate(table, paramsOf(row), keyFields)).filter((update) => update !== undefined);
    return [
      'START TRANSACTION;',
      `${inlineStatement(buildExistingKeys(table, keyFields, keys))};`,
      '-- rows whose key is not in the table yet:',
      ...insertsFor(table, rows).map((statement) => `${inlineStatement(statement)};`),
      '-- rows whose key is already there, one statement each:',
      ...updates.map((statement) => `${inlineStatement(statement)};`),
      'COMMIT;',
    ].join('\n');
  }

  /** A connection from the callback API, which (unlike the promise wrapper) can stream query results. */
  private coreConnection(): Promise<PoolConnection> {
    return new Promise((resolve, reject) => this.pool.getConnection((error, connection) => (error ? reject(error) : resolve(connection))));
  }

  /** Which keys exist decides insert or update; looked up (and locked) inside the batch's transaction. */
  private async writeStatements(connection: PromisePoolConnection, collection: string, rows: Row[], keyFields: string[]): Promise<MysqlStatement[]> {
    const table = parseMysqlTableName(collection);
    const keyOf = (row: Row) => keyString(keyFields.map((field) => row[field]));
    const existing = new Set<string>();
    for (const part of chunk(rows, Math.max(1, Math.floor(MAX_PLACEHOLDERS / keyFields.length)))) {
      const statement = buildExistingKeys(table, keyFields, part.map((row) => keyFields.map((field) => toMysqlParam(row[field]))));
      const [found] = await connection.execute<RowDataPacket[]>(statement.sql, statement.values as never);
      for (const row of found) existing.add(keyOf(row));
    }
    const fresh = rows.filter((row) => !existing.has(keyOf(row)));
    const known = rows.filter((row) => existing.has(keyOf(row)));
    const updates = known.map((row) => buildUpdate(table, paramsOf(row), keyFields)).filter((update) => update !== undefined);
    return [...insertsFor(table, fresh), ...updates];
  }

  /** Query sources are user-written SQL; a read-only transaction keeps a mistake from changing the source. */
  private async readOnly<T>(work: (connection: PromisePoolConnection) => Promise<T>): Promise<T> {
    const connection = await this.db.getConnection();
    try {
      await connection.query(START_READ_ONLY);
      return await work(connection);
    } finally {
      await connection.query('ROLLBACK').catch(() => undefined); // nothing was written; only releasing matters
      connection.release();
    }
  }

  /**
   * A streamed query that was stopped early still has rows in flight, so its connection cannot be reused:
   * destroy it. A drained one goes back to the pool.
   */
  private async finish(connection: PoolConnection, { drained, readOnly }: { drained: boolean; readOnly: boolean }): Promise<void> {
    if (!drained) {
      connection.destroy();
      return;
    }
    if (readOnly) await connection.promise().query('ROLLBACK').catch(() => undefined); // read-only: nothing to undo
    connection.release();
  }
}

function sourceOf(collection: string, query: string | undefined): MysqlTableRef | MysqlQueryRef {
  return query === undefined ? parseMysqlTableName(collection) : { query };
}

function toMysqlFilter<T extends { value: unknown }>(filter: T): T {
  return { ...filter, value: toMysqlParam(filter.value) };
}

function paramsOf(row: Row): Row {
  return Object.fromEntries(Object.entries(row).map(([column, value]) => [column, toMysqlParam(value)]));
}

/** The SELECT behind a read; shared by readBatches and explainRead so they never disagree. */
function selectFor(request: ReadRequest): string {
  const { watermark } = request;
  if (watermark?.field.includes('.')) throw new ValidationError('MySQL watermarks must be a column name, not a nested path');
  return buildSelect(sourceOf(request.collection, request.query), {
    // Nested paths (e.g. a JSON sub-field) are resolved in memory, so fetch their top-level column.
    columns: request.fields?.map((field) => field.split('.')[0]),
    watermark: watermark && { column: watermark.field, from: watermark.from ? fromStoredWatermark(watermark.from) : undefined },
    filters: request.filters?.map(toMysqlFilter),
    limit: request.limit,
  });
}

/** Key lookups split to stay under the placeholder limit; shared by findByKeys and explainFindByKeys. */
function keyLookupsFor(collection: string, keyFields: string[], keys: Row[]): MysqlStatement[] {
  const table = parseMysqlTableName(collection);
  return chunk(keys, Math.max(1, Math.floor(MAX_PLACEHOLDERS / keyFields.length))).map((part) =>
    buildKeyLookup(table, keyFields, part.map((key) => keyFields.map((field) => toMysqlParam(key[field])))),
  );
}

/** Multi-row INSERTs split to stay under the placeholder limit. */
function insertsFor(table: MysqlTableRef, rows: Row[]): MysqlStatement[] {
  if (rows.length === 0) return [];
  const columns = Object.keys(rows[0]);
  return chunk(rows, Math.max(1, Math.floor(MAX_PLACEHOLDERS / columns.length))).map((part) =>
    buildInsert(table, columns, part.map((row) => columns.map((column) => toMysqlParam(row[column])))),
  );
}

const FRIENDLY_TYPES: Record<string, string> = {
  LONGLONG: 'bigint',
  LONG: 'int',
  INT24: 'mediumint',
  SHORT: 'smallint',
  TINY: 'tinyint',
  NEWDECIMAL: 'decimal',
  VAR_STRING: 'varchar',
  STRING: 'char',
  BLOB: 'text',
};

/** A query column's type name, in the words MySQL users know (TINYINT(1) reads as boolean). */
function typeName(field: FieldPacket): string {
  const code = field.columnType ?? field.type;
  const name = code === undefined ? 'unknown' : String((Types as unknown as Record<number, string>)[code] ?? 'unknown');
  if (name === 'TINY' && field.columnLength === 1) return 'boolean';
  return FRIENDLY_TYPES[name] ?? name.toLowerCase();
}
