import { z } from 'zod';
import { isSafeFieldPath } from '../common/paths';
import { isSendableHeaderValue, sameOrigin } from '../connectors/http/http-format';

const requiredText = z.string().trim().min(1, 'Required');

export const postgresConfigSchema = z.object({
  kind: z.literal('postgres'),
  host: requiredText,
  port: z.coerce.number().int().min(1).max(65535).default(5432),
  database: requiredText,
  user: requiredText,
  password: z.string().default(''),
  ssl: z.enum(['disable', 'require', 'verify-full']).default('disable'),
});

export const mysqlConfigSchema = z.object({
  kind: z.literal('mysql'),
  host: requiredText,
  port: z.coerce.number().int().min(1).max(65535).default(3306),
  database: requiredText,
  user: requiredText,
  password: z.string().default(''),
  ssl: z.enum(['disable', 'require', 'verify-full']).default('disable'),
});

export const mongoConfigSchema = z.object({
  kind: z.literal('mongo'),
  uri: z
    .string()
    .trim()
    .default('')
    .refine((uri) => uri === '' || /^mongodb(\+srv)?:\/\//.test(uri), 'Must start with mongodb:// or mongodb+srv://'),
  database: requiredText,
});

export const cosmosConfigSchema = z.object({
  kind: z.literal('cosmos'),
  endpoint: z.string().trim().url('Must be a URL such as https://localhost:8081'),
  key: z.string().trim().default(''),
  database: requiredText,
  allowSelfSignedCert: z.boolean().default(false),
});

/** CSV files uploaded to Syncforge. The folder is not a setting: whoever opens the connector supplies it. */
export const csvConfigSchema = z.object({
  kind: z.literal('csv'),
  delimiter: z.enum(['auto', ',', ';', '\t']).default('auto'),
});

/** Headers refused in `headers` and as an API key header: credentials belong in `auth`, and the client sets Host. */
const FORBIDDEN_HEADERS = new Set(['authorization', 'proxy-authorization', 'cookie', 'host']);
/** An HTTP header name (RFC 9110 token). */
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,100}$/;
/** A query parameter name: no spaces or characters that would split or end the query string. */
const QUERY_PARAM_NAME = /^[^\s&=#?]{1,100}$/;
/** Endpoint names are what jobs and lookups store as their collection, so they stay short and plain. */
const ENDPOINT_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,59}$/;
/** A path relative to the base URL: one leading slash (two would name another host), no fragment, no spaces. */
const ENDPOINT_PATH = /^\/(?!\/)[^#\s]*$/;
/** Plenty for real APIs; keeps each request and each form short. */
const MAX_PAIRS = 20;
const MAX_ENDPOINTS = 50;
const MAX_PAGE_SIZE = 10_000;
/** Largest HTTP response a connector reads when no setting says otherwise (`httpMaxResponseMb`). */
export const HTTP_MAX_RESPONSE_DEFAULT_BYTES = 50 * 1024 * 1024;

const headerName = z.string().trim().regex(HEADER_NAME, 'Use a header name such as X-Tenant (letters, digits and - only)');
const queryParamName = z.string().trim().regex(QUERY_PARAM_NAME, 'Use a parameter name without spaces, &, =, # or ?');
const safePath = z.string().trim().refine(isSafeFieldPath, 'Use a field name or dotted path such as meta.next (no "$")');
const LINE_BREAK = /[\r\n]/;
/** Messages never quote the value: it may be a credential typed in the wrong place. */
const headerValue = z
  .string()
  .max(1000)
  // A line break would start another header.
  .refine((value) => !LINE_BREAK.test(value), 'Must be on one line')
  .refine((value) => LINE_BREAK.test(value) || isSendableHeaderValue(value), 'Use only characters an HTTP header can carry: no control characters, nothing beyond Latin-1');

const headerPairSchema = z.object({
  name: headerName.refine((name) => !FORBIDDEN_HEADERS.has(name.toLowerCase()), 'Set credentials under Authentication; Host is set for you'),
  value: headerValue,
});

/** A number from a form, sent as JSON: blank or null is refused, where `z.coerce` would read it as 0. */
function formNumber(missing: string) {
  return z.number({ invalid_type_error: missing, required_error: missing });
}

const queryPairSchema = z.object({ name: queryParamName, value: z.string().max(1000) });

/** How requests authenticate. Every type except `none` reads the connection's one `secret`. */
export const httpAuthSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('none') }),
  z.object({ type: z.literal('bearer') }),
  z.object({ type: z.literal('basic'), username: requiredText }),
  z.object({
    type: z.literal('apiKeyHeader'),
    header: headerName.refine((name) => !FORBIDDEN_HEADERS.has(name.toLowerCase()), 'Choose bearer or basic for Authorization; Cookie and Host are not allowed'),
  }),
  z.object({ type: z.literal('apiKeyQuery'), param: queryParamName }),
]);

/** How an endpoint reaches its next page. */
export const httpPaginationSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('none') }),
  z.object({
    type: z.literal('page'),
    pageParam: queryParamName.default('page'),
    firstPage: formNumber('Enter the number of the first page').int('Use a whole number').min(0).default(1),
    size: z.object({ param: queryParamName, value: formNumber('Enter a page size').int('Use a whole number').min(1).max(MAX_PAGE_SIZE) }).optional(),
  }),
  z.object({
    type: z.literal('offset'),
    offsetParam: queryParamName.default('offset'),
    limitParam: queryParamName.default('limit'),
    limit: formNumber('Enter a page size').int('Use a whole number').min(1).max(MAX_PAGE_SIZE).default(100),
  }),
  z.object({ type: z.literal('cursor'), cursorPath: safePath, cursorParam: queryParamName }),
  z.object({ type: z.literal('nextUrl'), nextUrlPath: safePath }),
  z.object({ type: z.literal('linkHeader'), header: headerName.default('Link') }),
]);

/** One GET endpoint of an API. Its name plays the part of a table: jobs and lookups refer to it. */
export const httpEndpointSchema = z.object({
  name: z.string().trim().regex(ENDPOINT_NAME, 'Start with a letter or digit; use letters, digits, _ . - (up to 60)'),
  path: z.string().trim().regex(ENDPOINT_PATH, 'Use a path such as /users that starts with one / (no #, no spaces)'),
  query: z.array(queryPairSchema).max(MAX_PAIRS).default([]),
  /** Where the items are in a response: `$` for a body that is the array itself. */
  dataPath: z
    .string()
    .trim()
    .default('$')
    .refine((path) => path === '$' || isSafeFieldPath(path), 'Use $ for the whole body, or a dotted path such as data.items'),
  pagination: httpPaginationSchema.default({ type: 'none' }),
});

/**
 * Credentials in the URL would be stored and shown as settings; a fragment is never sent; query parameters
 * belong in the connection's list, so they are merged with endpoint and page parameters in one place.
 */
function baseUrlProblem(text: string): string | undefined {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return 'Must be a URL such as https://api.example.com/v2';
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return 'Must start with http:// or https://';
  if (url.username || url.password) return 'Put credentials under Authentication, not in the URL';
  if (text.includes('#')) return 'Remove the #fragment: it is never sent to the server';
  if (text.includes('?')) return "Remove the ?query: put query parameters in the connection's Query params list";
  return undefined;
}

/**
 * A REST API read with GET: one base URL, shared auth, headers and parameters, and its endpoints.
 * Headers and parameters are settings, not secrets: only `secret` is encrypted apart and never returned.
 */
export const httpConfigSchema = z.object({
  kind: z.literal('http'),
  baseUrl: z
    .string()
    .trim()
    .superRefine((text, context) => {
      const problem = baseUrlProblem(text);
      if (problem) context.addIssue({ code: z.ZodIssueCode.custom, message: problem });
    }),
  auth: httpAuthSchema.default({ type: 'none' }),
  secret: z.string().default(''),
  headers: z.array(headerPairSchema).max(MAX_PAIRS).default([]),
  query: z.array(queryPairSchema).max(MAX_PAIRS).default([]),
  /** Least time between two requests to this API, shared by a job's source and its lookups. */
  minIntervalSeconds: formNumber('Enter a number of seconds').min(0).max(3600).default(0),
  endpoints: z
    .array(httpEndpointSchema)
    .min(1, 'Add at least one endpoint')
    .max(MAX_ENDPOINTS)
    .superRefine((endpoints, context) => {
      const seen = new Set<string>();
      endpoints.forEach((endpoint, index) => {
        if (seen.has(endpoint.name)) {
          context.addIssue({ code: z.ZodIssueCode.custom, path: [index, 'name'], message: `Another endpoint is already named "${endpoint.name}"` });
        }
        seen.add(endpoint.name);
      });
    }),
});

/** The connection settings a probe of one endpoint needs: everything but the endpoint list. */
export const httpProbeConfigSchema = httpConfigSchema.omit({ endpoints: true });

/** Why an HTTP API source refuses incremental mode; the connector refuses a watermark with the same words. */
export const HTTP_FULL_MODE_ONLY = 'HTTP API sources run in full mode: each run fetches every page, and upserts make re-running it safe';

export const connectionConfigSchema = z.discriminatedUnion('kind', [
  postgresConfigSchema,
  mysqlConfigSchema,
  mongoConfigSchema,
  cosmosConfigSchema,
  csvConfigSchema,
  httpConfigSchema,
]);

/**
 * What a connector is opened with: the saved settings, plus what depends on the machine rather than the
 * connection: the folder for CSV connections, the response size limit for HTTP APIs.
 */
export const connectorConfigSchema = z.discriminatedUnion('kind', [
  postgresConfigSchema,
  mysqlConfigSchema,
  mongoConfigSchema,
  cosmosConfigSchema,
  csvConfigSchema.extend({ directory: requiredText }),
  httpConfigSchema.extend({ maxResponseBytes: z.number().int().positive().default(HTTP_MAX_RESPONSE_DEFAULT_BYTES) }),
]);

export const connectionInputSchema = z.object({
  name: z.string().trim().min(1, 'Required').max(80),
  config: connectionConfigSchema,
});

export type PostgresConfig = z.infer<typeof postgresConfigSchema>;
export type MysqlConfig = z.infer<typeof mysqlConfigSchema>;
export type MongoConfig = z.infer<typeof mongoConfigSchema>;
export type CosmosConfig = z.infer<typeof cosmosConfigSchema>;
export type CsvConfig = z.infer<typeof csvConfigSchema>;
export type HttpConfig = z.infer<typeof httpConfigSchema>;
export type HttpProbeConfig = z.infer<typeof httpProbeConfigSchema>;
export type HttpAuth = z.infer<typeof httpAuthSchema>;
export type HttpEndpoint = z.infer<typeof httpEndpointSchema>;
export type ConnectionConfig = z.infer<typeof connectionConfigSchema>;
export type ConnectorConfig = z.infer<typeof connectorConfigSchema>;
/** Connector settings before defaults are filled, as an exported script writes them (e.g. no `maxResponseBytes`). */
export type ConnectorConfigInput = z.input<typeof connectorConfigSchema>;
export type ConnectionKind = ConnectionConfig['kind'];
export type ConnectionInput = z.infer<typeof connectionInputSchema>;

/**
 * The one field per kind that holds credentials, or null for a kind without any (CSV files).
 * It is never returned by the API; when editing, leaving it blank keeps the saved value.
 */
export const SECRET_FIELD = {
  postgres: 'password',
  mysql: 'password',
  mongo: 'uri',
  cosmos: 'key',
  csv: null,
  http: 'secret',
} as const satisfies Record<ConnectionKind, string | null>;

/**
 * Postgres and MySQL may legitimately use passwordless auth; MongoDB and Cosmos DB cannot work without their secret.
 * For an HTTP API it depends on the auth type: use `secretRequired`.
 */
export const SECRET_REQUIRED: Record<ConnectionKind, boolean> = {
  postgres: false,
  mysql: false,
  mongo: true,
  cosmos: true,
  csv: false,
  http: false,
};

/** Whether a connection of this kind (and, for an HTTP API, this auth type) cannot work without its secret. */
export function secretRequired(kind: ConnectionKind, authType?: HttpAuth['type']): boolean {
  if (kind === 'http') return authType !== undefined && authType !== 'none';
  return SECRET_REQUIRED[kind];
}

/**
 * Whether an edit that leaves the secret blank keeps the saved one. Only when it still means the same thing and
 * goes to the same place: same kind and, for an HTTP API, the same auth type (a saved bearer token is not an API
 * key or a password) and the same origin (scheme, host and port), so a saved token never follows a new base URL.
 */
export function keepsSavedSecret(incoming: ConnectionConfig, existing: ConnectionConfig): boolean {
  const field = SECRET_FIELD[incoming.kind];
  if (field === null || existing.kind !== incoming.kind) return false;
  if ((incoming as Record<string, unknown>)[field] !== '') return false;
  if (incoming.kind === 'http' && existing.kind === 'http') {
    return incoming.auth.type !== 'none' && incoming.auth.type === existing.auth.type && sameOrigin(incoming.baseUrl, existing.baseUrl);
  }
  return true;
}

/**
 * Why an HTTP API's secret cannot be sent the way its auth type sends it, or undefined when it can.
 * Bearer tokens and header API keys go into a header as they are; basic auth and query keys are encoded first,
 * so any text works there. The message never quotes the secret.
 */
export function httpSecretProblem(auth: HttpAuth, secret: string): string | undefined {
  const what = auth.type === 'bearer' ? 'token' : auth.type === 'apiKeyHeader' ? 'API key' : undefined;
  if (what === undefined || isSendableHeaderValue(secret)) return undefined;
  return `The ${what} contains characters that cannot be sent in an HTTP header (a line break, a control character or one beyond Latin-1); paste it again`;
}

/** On disk: only the name and kind are readable; hosts, usernames and secrets are encrypted. */
export interface StoredConnection {
  id: string;
  name: string;
  kind: ConnectionKind;
  encryptedConfig: string;
  createdAt: string;
  updatedAt: string;
}

/** What the API returns: settings without the secret. */
export interface ConnectionView {
  id: string;
  name: string;
  kind: ConnectionKind;
  summary: string;
  settings: Record<string, unknown>;
  hasSecret: boolean;
  createdAt: string;
  updatedAt: string;
}

/** A file uploaded to a CSV connection. */
export interface CsvFileInfo {
  name: string;
  size: number;
  /** ISO timestamp of the last upload. */
  modifiedAt: string;
}

/** What `GET /connections/:id/files` returns: the files and the largest upload accepted now, in bytes. */
export interface CsvFileList {
  maxBytes: number;
  files: CsvFileInfo[];
}

/** A response header, or any name and value shown as a pair (e.g. rate-limit headers). */
export interface HeaderPair {
  name: string;
  value: string;
}

/** What a trial request to one HTTP endpoint found, to help set up its data path and pagination. */
export interface HttpProbeResult {
  status: number;
  latencyMs: number;
  bytes: number;
  contentType: string | null;
  /** Rate-limit headers of the response (X-RateLimit-*, RateLimit-*, Retry-After). */
  rateLimit: HeaderPair[];
  /** Arrays of objects found in the body: their data path, item count and the keys of their first item. */
  arrays: Array<{ path: string; items: number; keys: string[] }>;
  /** Where the next page would be fetched from, or null when the response names none. */
  nextPage: string | null;
}

export type ConnectionTestResult =
  | {
      ok: true;
      latencyMs: number;
      /** HTTP APIs: rate-limit headers of the test response. */
      rateLimit?: HeaderPair[];
    }
  | { ok: false; message: string };
