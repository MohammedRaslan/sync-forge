import { StoredWatermark } from '../sync/watermark';

export type Row = Record<string, unknown>;

export interface CollectionInfo {
  /** Postgres: "schema.table". MongoDB and Cosmos DB: the collection or container name. CSV: the file name. */
  name: string;
  kind: 'table' | 'view' | 'collection' | 'container' | 'file';
}

export interface FieldInfo {
  path: string;
  type: string;
  nullable: boolean;
  primaryKey: boolean;
  /** Share of sampled documents containing the field (document stores only, 0..1). */
  presence?: number;
}

export type FilterOp = 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte';

/** A condition every row read must meet, e.g. created_at > 2025-01-01. `value` is already typed (Date, number...). */
export interface SourceFilter {
  field: string;
  op: FilterOp;
  value: unknown;
}

/** Which rows of a source count: a collection or query, narrowed by filters. */
export interface SourceScope {
  /** A SELECT statement to read instead of the collection. Only PostgreSQL supports it; SyncService rejects it for others. */
  query?: string;
  /** All must match. Applied by the database, so only matching rows are read. */
  filters?: SourceFilter[];
}

export interface ReadRequest extends SourceScope {
  /** The collection to read. For a query source, the query's name (used in messages only). */
  collection: string;
  batchSize: number;
  /** Fields to fetch; connectors may return more. Undefined means every field. */
  fields?: string[];
  /** When set, rows come back ordered by this field, starting at `from` (inclusive). */
  watermark?: { field: string; from?: StoredWatermark };
  limit?: number;
  signal?: AbortSignal;
}

export interface SchemaReader {
  listCollections(): Promise<CollectionInfo[]>;
  describeCollection(collection: string): Promise<FieldInfo[]>;
}

export interface DataReader {
  readBatches(request: ReadRequest): AsyncIterable<Row[]>;
  /** Rows in the collection (or query result) that match the scope's filters. */
  count(collection: string, scope?: SourceScope): Promise<number>;
}

/** Fetches rows matching key values. Used to verify writes and to look up related rows. */
export interface KeyReader {
  findByKeys(collection: string, keyFields: string[], keys: Row[]): Promise<Row[]>;
}

export interface DataWriter extends KeyReader {
  /**
   * Inserts or updates rows matched on `keyFields`. Must be idempotent:
   * writing the same rows twice leaves the target unchanged.
   */
  upsert(collection: string, rows: Row[], keyFields: string[]): Promise<void>;
}

/** Everything the engine needs from a database. One implementation per database engine. */
export interface Connector extends SchemaReader, DataReader, DataWriter {
  ping(): Promise<void>;
  close(): Promise<void>;
  /** Columns a query returns, for databases that support query sources. */
  describeQuery?(query: string): Promise<FieldInfo[]>;
  /** The statement `readBatches` would run for this request, for people to read. Runs nothing. */
  explainRead(request: ReadRequest): string;
  /** The statement `findByKeys` would run for these keys, for people to read. Runs nothing. */
  explainFindByKeys(collection: string, keyFields: string[], keys: Row[]): string;
  /** The statements `upsert` would run for these rows, for people to read. Runs nothing. */
  explainUpsert(collection: string, rows: Row[], keyFields: string[]): string;
}
