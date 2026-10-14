import { Pool, PoolClient, types } from 'pg';
import Cursor from 'pg-cursor';
import { CollectionInfo, Connector, FieldInfo, ReadRequest, Row, SourceFilter, SourceScope } from '../connector.types';
import { PostgresConfig } from '../../connections/connection.model';
import { NotFoundError, ValidationError } from '../../common/errors';
import { chunk } from '../../common/collections';
import { normalizeValue, parseDateText } from '../../common/values';
import { fromStoredWatermark } from '../../sync/watermark';
import {
  MAX_BIND_PARAMETERS,
  QueryRef,
  SqlQuery,
  TableRef,
  buildCount,
  buildKeyLookup,
  buildSelect,
  buildUpsert,
  inlineSql,
  parseTableName,
} from './postgres-sql';

/**
 * Values bound as parameters: objects and arrays become JSON text so they land cleanly in json/jsonb columns.
 * Dates become UTC ISO text: pg would otherwise send them in the engine's local time zone, and a
 * `timestamp`/`date` column, which drops the offset, would store a different wall time on every machine.
 */
export function toPgParam(value: unknown): unknown {
  const normalized = normalizeValue(value);
  if (normalized instanceof Date) return normalized.toISOString();
  if (normalized === null || typeof normalized !== 'object') return normalized;
  return JSON.stringify(normalized);
}

const DATE_OID = 1082;
const TIMESTAMP_OID = 1114;

/**
 * A `date` or `timestamp` (without time zone) value as a Date, reading it as UTC like `parseDateText`.
 * pg reads them in the engine's local time, so the same row would compare differently on every machine.
 * Values that are not plain dates (infinity, BC) keep pg's own parsing.
 */
export function parseNaiveDate(text: string): unknown {
  const time = parseDateText(text);
  return Number.isNaN(time) ? types.getTypeParser(TIMESTAMP_OID)(text) : new Date(time);
}

/** pg's parsers, except naive dates and timestamps; given per pool so other pg users in the process are untouched. */
const UTC_TYPES = {
  getTypeParser: (oid: number, format?: 'text' | 'binary') =>
    (format ?? 'text') === 'text' && (oid === DATE_OID || oid === TIMESTAMP_OID) ? parseNaiveDate : types.getTypeParser(oid, format),
};

const BEGIN_READ_ONLY = 'BEGIN TRANSACTION READ ONLY';

function sourceOf(collection: string, query: string | undefined): TableRef | QueryRef {
  return query === undefined ? parseTableName(collection) : { query };
}

function toPgFilter(filter: SourceFilter): SourceFilter {
  return { ...filter, value: toPgParam(filter.value) };
}

/** The SELECT behind a key lookup; shared by findByKeys and explainFindByKeys. */
function keyLookupFor(collection: string, keyFields: string[], keys: Row[]): SqlQuery {
  return buildKeyLookup(parseTableName(collection), keyFields, keys.map((key) => keyFields.map((field) => toPgParam(key[field]))));
}

/** INSERT … ON CONFLICT statements for a batch, split to stay under the bind parameter limit; shared by upsert and explainUpsert. */
function upsertStatementsFor(collection: string, rows: Row[], keyFields: string[]): SqlQuery[] {
  const table = parseTableName(collection);
  const columns = Object.keys(rows[0]);
  const rowsPerStatement = Math.max(1, Math.floor(MAX_BIND_PARAMETERS / columns.length));
  return chunk(rows, rowsPerStatement).map((part) =>
    buildUpsert(table, columns, keyFields, part.map((row) => columns.map((column) => toPgParam(row[column])))),
  );
}

/** A statement as people read it: values written in, so it can be copied and run. */
function describeSql(query: SqlQuery): string {
  return `${inlineSql(query)};`;
}

/** The SELECT behind a read; shared by readBatches and explainRead so they never disagree. */
function selectFor(request: ReadRequest): SqlQuery {
  const { watermark } = request;
  if (watermark?.field.includes('.')) {
    throw new ValidationError('Postgres watermarks must be a column name, not a nested path');
  }
  return buildSelect(sourceOf(request.collection, request.query), {
    // Nested paths (e.g. a jsonb sub-field) are resolved in memory, so fetch their top-level column.
    columns: request.fields?.map((field) => field.split('.')[0]),
    watermark: watermark && {
      column: watermark.field,
      from: watermark.from ? toPgParam(fromStoredWatermark(watermark.from)) : undefined,
    },
    filters: request.filters?.map(toPgFilter),
  });
}

export class PostgresConnector implements Connector {
  private readonly pool: Pool;

  constructor(config: PostgresConfig) {
    this.pool = new Pool({
      host: config.host,
      port: config.port,
      database: config.database,
      user: config.user,
      password: config.password || undefined,
      ssl: config.ssl === 'disable' ? undefined : { rejectUnauthorized: config.ssl === 'verify-full' },
      max: 4,
      connectionTimeoutMillis: 10_000,
      application_name: 'syncforge',
      types: UTC_TYPES,
    });
  }

  async ping(): Promise<void> {
    await this.pool.query('SELECT 1');
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async listCollections(): Promise<CollectionInfo[]> {
    const { rows } = await this.pool.query<{ table_schema: string; table_name: string; table_type: string }>(
      `SELECT table_schema, table_name, table_type
         FROM information_schema.tables
        WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
        ORDER BY table_schema, table_name`,
    );
    return rows.map((row) => ({
      name: `${row.table_schema}.${row.table_name}`,
      kind: row.table_type === 'VIEW' ? 'view' : 'table',
    }));
  }

  async describeCollection(collection: string): Promise<FieldInfo[]> {
    const { schema, table } = parseTableName(collection);
    const { rows } = await this.pool.query<{
      column_name: string;
      data_type: string;
      udt_name: string;
      is_nullable: 'YES' | 'NO';
      is_primary_key: boolean;
    }>(
      `SELECT c.column_name, c.data_type, c.udt_name, c.is_nullable,
              EXISTS (
                SELECT 1
                  FROM information_schema.table_constraints tc
                  JOIN information_schema.key_column_usage k
                    ON k.constraint_name = tc.constraint_name
                   AND k.table_schema = tc.table_schema
                   AND k.table_name = tc.table_name
                 WHERE tc.constraint_type = 'PRIMARY KEY'
                   AND tc.table_schema = c.table_schema
                   AND tc.table_name = c.table_name
                   AND k.column_name = c.column_name
              ) AS is_primary_key
         FROM information_schema.columns c
        WHERE c.table_schema = $1 AND c.table_name = $2
        ORDER BY c.ordinal_position`,
      [schema, table],
    );
    if (rows.length === 0) throw new NotFoundError(`Table "${collection}" was not found or has no columns`);

    return rows.map((row) => ({
      path: row.column_name,
      type: row.data_type === 'USER-DEFINED' || row.data_type === 'ARRAY' ? row.udt_name : row.data_type,
      nullable: row.is_nullable === 'YES',
      primaryKey: row.is_primary_key,
    }));
  }

  async *readBatches(request: ReadRequest): AsyncIterable<Row[]> {
    const query = selectFor(request);
    const client = await this.pool.connect();
    const readOnly = request.query !== undefined;
    try {
      if (readOnly) await client.query(BEGIN_READ_ONLY);
      // A server-side cursor streams the table in batches instead of loading it into memory.
      const cursor = client.query(new Cursor<Row>(query.text, query.values));
      try {
        let read = 0;
        while (!request.signal?.aborted) {
          const size = request.limit === undefined ? request.batchSize : Math.min(request.batchSize, request.limit - read);
          if (size <= 0) return;
          const rows = await cursor.read(size);
          if (rows.length === 0) return;
          read += rows.length;
          yield rows;
        }
      } finally {
        await cursor.close();
        if (readOnly) await client.query('ROLLBACK').catch(() => undefined);
      }
    } finally {
      client.release();
    }
  }

  async count(collection: string, scope: SourceScope = {}): Promise<number> {
    const statement = buildCount(sourceOf(collection, scope.query), scope.filters?.map(toPgFilter));
    const { rows } =
      scope.query === undefined
        ? await this.pool.query<{ total: string }>(statement.text, statement.values)
        : await this.readOnly((client) => client.query<{ total: string }>(statement.text, statement.values));
    return Number(rows[0].total);
  }

  explainRead(request: ReadRequest): string {
    const text = describeSql(selectFor(request));
    return request.query === undefined ? text : `${text}\n-- runs in a READ ONLY transaction`;
  }

  explainFindByKeys(collection: string, keyFields: string[], keys: Row[]): string {
    return describeSql(keyLookupFor(collection, keyFields, keys));
  }

  explainUpsert(collection: string, rows: Row[], keyFields: string[]): string {
    if (rows.length === 0) return '-- nothing to write';
    return ['BEGIN;', ...upsertStatementsFor(collection, rows, keyFields).map(describeSql), 'COMMIT;'].join('\n');
  }

  async describeQuery(query: string): Promise<FieldInfo[]> {
    const { fields } = await this.readOnly((client) =>
      client.query(buildSelect({ query }, {}).text + ' LIMIT 0'),
    );
    const { rows: types } = await this.pool.query<{ oid: number; typname: string }>(
      'SELECT oid::int AS oid, typname FROM pg_type WHERE oid = ANY($1::oid[])',
      [[...new Set(fields.map((field) => field.dataTypeID))]],
    );
    const typeNames = new Map(types.map((type) => [type.oid, type.typname]));
    return fields.map((field) => ({
      path: field.name,
      type: typeNames.get(field.dataTypeID) ?? 'unknown',
      nullable: true,
      primaryKey: false,
    }));
  }

  /**
   * Query sources are user-written SQL. A read-only transaction makes sure a mistake
   * (or a data-modifying CTE) cannot change the source database.
   */
  private async readOnly<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query(BEGIN_READ_ONLY);
      return await work(client);
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  }

  async upsert(collection: string, rows: Row[], keyFields: string[]): Promise<void> {
    if (rows.length === 0) return;
    // One transaction per batch: a batch is written completely or not at all.
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      for (const query of upsertStatementsFor(collection, rows, keyFields)) await client.query(query.text, query.values);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async findByKeys(collection: string, keyFields: string[], keys: Row[]): Promise<Row[]> {
    if (keys.length === 0) return [];
    const rowsPerStatement = Math.max(1, Math.floor(MAX_BIND_PARAMETERS / keyFields.length));
    const found: Row[] = [];
    for (const part of chunk(keys, rowsPerStatement)) {
      const query = keyLookupFor(collection, keyFields, part);
      const { rows } = await this.pool.query<Row>(query.text, query.values);
      found.push(...rows);
    }
    return found;
  }
}
