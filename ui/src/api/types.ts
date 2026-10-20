/** Shapes returned by the engine API. Kept in sync by hand with engine/src (see docs/ARCHITECTURE.md). */

export type ConnectionKind = 'postgres' | 'mysql' | 'mongo' | 'cosmos' | 'csv' | 'http';

export interface Connection {
  id: string;
  name: string;
  kind: ConnectionKind;
  summary: string;
  settings: Record<string, unknown>;
  hasSecret: boolean;
  createdAt: string;
  updatedAt: string;
}

export type ConnectionConfig =
  | { kind: 'postgres'; host: string; port: number; database: string; user: string; password: string; ssl: 'disable' | 'require' | 'verify-full' }
  | { kind: 'mysql'; host: string; port: number; database: string; user: string; password: string; ssl: 'disable' | 'require' | 'verify-full' }
  | { kind: 'mongo'; uri: string; database: string }
  | { kind: 'cosmos'; endpoint: string; key: string; database: string; allowSelfSignedCert: boolean }
  | { kind: 'csv'; delimiter: 'auto' | ',' | ';' | '\t' }
  | HttpConfig;

/** A name and a value: a request header, a query parameter, or a response header shown back. */
export interface HeaderPair {
  name: string;
  value: string;
}

/** How requests to an HTTP API authenticate. Every type except `none` sends the connection's one `secret`. */
export type HttpAuth =
  | { type: 'none' }
  | { type: 'bearer' }
  | { type: 'basic'; username: string }
  | { type: 'apiKeyHeader'; header: string }
  | { type: 'apiKeyQuery'; param: string };

/** How an endpoint reaches its next page. */
export type HttpPagination =
  | { type: 'none' }
  | { type: 'page'; pageParam: string; firstPage: number; size?: { param: string; value: number } }
  | { type: 'offset'; offsetParam: string; limitParam: string; limit: number }
  | { type: 'cursor'; cursorPath: string; cursorParam: string }
  | { type: 'nextUrl'; nextUrlPath: string }
  | { type: 'linkHeader'; header: string };

/** One GET endpoint of an API; jobs and lookups use its name as their collection. */
export interface HttpEndpoint {
  name: string;
  path: string;
  query: HeaderPair[];
  /** `$` for a body that is the array itself, otherwise a dotted path such as data.items. */
  dataPath: string;
  pagination: HttpPagination;
}

/** A REST API read with GET. Headers and query parameters are settings, not secrets. */
export interface HttpConfig {
  kind: 'http';
  baseUrl: string;
  auth: HttpAuth;
  secret: string;
  headers: HeaderPair[];
  query: HeaderPair[];
  minIntervalSeconds: number;
  endpoints: HttpEndpoint[];
}

/** What a trial request to one HTTP endpoint found. */
export interface HttpProbeResult {
  status: number;
  latencyMs: number;
  bytes: number;
  contentType: string | null;
  rateLimit: HeaderPair[];
  arrays: Array<{ path: string; items: number; keys: string[] }>;
  nextPage: string | null;
}

export interface ConnectionInput {
  name: string;
  config: ConnectionConfig;
}

/** A file uploaded to a CSV connection. */
export interface CsvFileInfo {
  name: string;
  size: number;
  /** ISO timestamp of the last upload. */
  modifiedAt: string;
}

/** The files of a CSV connection and the largest upload accepted now, in bytes. */
export interface CsvFileList {
  maxBytes: number;
  files: CsvFileInfo[];
}

export type ConnectionTestResult =
  | {
      ok: true;
      latencyMs: number;
      /** HTTP APIs: rate-limit headers of the test response. */
      rateLimit?: HeaderPair[];
    }
  | { ok: false; message: string };

export interface CollectionInfo {
  name: string;
  kind: 'table' | 'view' | 'collection' | 'container' | 'file' | 'endpoint';
}

export interface FieldInfo {
  path: string;
  type: string;
  nullable: boolean;
  primaryKey: boolean;
  presence?: number;
}

export interface TransformInfo {
  name: string;
  label: string;
  description: string;
  sourceField: 'required' | 'optional' | 'none';
  argument: { label: string; placeholder: string } | null;
}

export interface FieldMapping {
  from?: string;
  to: string;
  transform: string;
  argument?: string;
}

export type FilterOp = 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte';
export type FilterValueType = 'string' | 'number' | 'date' | 'boolean';

/** A condition on source rows, e.g. created_at > 2025-01-01. The value is text; `type` says how to read it. */
export interface SourceFilter {
  field: string;
  op: FilterOp;
  type: FilterValueType;
  value: string;
}

/** Enriches each source row with one matching row from another collection, attached under `as`. */
export interface Lookup {
  as: string;
  connectionId: string;
  collection: string;
  on: Array<{ source: string; lookup: string }>;
  required: boolean;
}

export interface JobInput {
  name: string;
  description?: string;
  /** With `query` (PostgreSQL only), `collection` is the name shown for the query. */
  source: { connectionId: string; collection: string; query?: string; filters?: SourceFilter[] };
  lookups?: Lookup[];
  target: { connectionId: string; collection: string; keyFields: string[] };
  mappings: FieldMapping[];
  mode: 'full' | 'incremental';
  watermarkField?: string;
  batchSize: number;
  errorPolicy: 'fail' | 'skip';
}

export interface Job extends JobInput {
  id: string;
  createdAt: string;
  updatedAt: string;
}

export interface Watermark {
  type: 'date' | 'number' | 'string' | 'objectId';
  value: string | number;
  /** Date watermarks saved since naive timestamps are read as UTC; older ones resume 14 hours earlier once. */
  utc?: true;
}

export interface RunStats {
  read: number;
  written: number;
  skipped: number;
  batches: number;
}

export type RunStatus = 'running' | 'succeeded' | 'failed' | 'cancelled';

export interface RunSummary {
  id: string;
  jobId: string;
  jobName: string;
  mode: 'full' | 'incremental';
  /** Read, mapped and compared, but nothing written. */
  dryRun?: boolean;
  /** The run whose failed rows this run read again. Never moves the watermark; not the job's latest run in `/runs/latest`. */
  retryOf?: string;
  status: RunStatus;
  startedAt: string;
  finishedAt: string | null;
  stats: RunStats;
  watermarkFrom: Watermark | null;
  watermarkTo: Watermark | null;
  error: string | null;
}

/** A row a run gave up on (with the "skip" error policy). */
export interface RowFailure {
  /** Position in the run's read order; for `read` failures, the key's place in the keys a retry asked for. */
  row: number;
  key: string | null;
  /** `read`: a retry asked for the row by its source key and the source no longer has it. */
  stage: 'read' | 'lookup' | 'map' | 'write';
  reason: string;
  values?: Row;
  /** The source row's key values, by source field. Only failures with one can be re-run (`retryOf`). */
  sourceKey?: Record<string, string | number>;
}

export interface RunRecord extends RunSummary {
  log: Array<{ at: string; level: 'info' | 'warn' | 'error'; message: string }>;
  /** Capped list; stats.skipped has the full count. Missing on runs from older versions. */
  failures?: RowFailure[];
  /** What a dry run found. */
  plan?: DryRunReport;
}

export interface DryRunReport {
  inserts: number;
  updates: number;
  unchanged: number;
  newKeys: string[];
  /** `removed`: a Cosmos DB target would lose this field, because whole documents are replaced. */
  changes: Array<{ key: string; field: string; current: unknown; next: unknown; removed?: true }>;
}

export interface LookupStatement {
  as: string;
  connection: string;
  collection: string;
  /** Null when the preview rows had no keys to look up. */
  statement: string | null;
  keyCount: number;
}

export interface SourcePreview {
  statement: string;
  lookups: LookupStatement[];
  rows: Row[];
}

export type Row = Record<string, unknown>;

export interface PreviewResult {
  fields: string[];
  rows: Array<{ source: Row; target?: Row; error?: string }>;
  /** What a run sends to write the first preview rows; null when no row could be mapped. */
  writeStatement: string | null;
}

export interface ReconcileReport {
  checkedAt: string;
  sourceCount: number;
  targetCount: number;
  sampled: number;
  matched: number;
  missingCount: number;
  missingKeys: string[];
  mismatchedRows: number;
  mismatches: Array<{ key: string; field: string; expected: unknown; actual: unknown }>;
  unmappable: number;
}

/** Counts of a job's latest reconcile (no keys or values), from `GET /reconciles/latest`. */
export interface ReconcileSummary {
  jobId: string;
  checkedAt: string;
  sourceCount: number;
  targetCount: number;
  sampled: number;
  matched: number;
  missingCount: number;
  mismatchedRows: number;
  unmappable: number;
}

/** App-wide, machine-local settings (`GET/PUT /settings`). */
export interface Settings {
  defaultBatchSize: number;
  /** A CSV used as a lookup is held in memory, so this also bounds memory. */
  csvMaxUploadMb: number;
  /** A lookup on an HTTP endpoint holds every page in memory, so this also bounds memory. */
  httpMaxResponseMb: number;
}

export interface SettingsView {
  settings: Settings;
  defaults: Settings;
}
