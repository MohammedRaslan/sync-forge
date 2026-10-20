/**
 * Pure helpers for HTTP API sources: request URLs, page planning, response headers, finding and reading
 * the items in a body, and the Query tab text. The HTTP client and connector do the I/O.
 * Nothing here ever puts the connection's secret into text: auth is shown as `***`.
 */
import { ValidationError } from '../../common/errors';
import { getPath, isSafeFieldPath } from '../../common/paths';
import { isPlainObject } from '../../common/values';
import { HeaderPair, HttpAuth, HttpConfig, HttpEndpoint } from '../../connections/connection.model';
import { FilterOp, Row, SourceFilter } from '../connector.types';

/** A query parameter as stored on a connection or endpoint. */
export type QueryParam = HttpConfig['query'][number];

/** What a URL shows in place of a secret. */
const MASK = '***';

/** How deep {@link findArrayPaths} looks for arrays: up to four keys, e.g. `a.b.c.d`. */
const ARRAY_SEARCH_DEPTH = 4;

/** Keys of an array's first item shown by {@link findArrayPaths}; enough to recognise the data. */
const MAX_KEYS_SHOWN = 50;

/** Rate-limit header values are shown, not parsed; a longer value is cut to this many characters. */
const MAX_HEADER_VALUE_SHOWN = 100;

/**
 * The URL of `path` under `baseUrl`, with `params` in its query string.
 * The base path is kept: base `https://api.x/v2` + path `/users` gives `https://api.x/v2/users`.
 * A query string written in `path` comes first; then each param is set in order, so a later param
 * replaces an earlier one of the same name. Callers pass connection params, then endpoint params,
 * then page params, so the most specific wins.
 */
export function endpointUrl(baseUrl: string, path: string, params: readonly QueryParam[]): string {
  const base = new URL(baseUrl);
  const basePath = base.pathname.replace(/\/+$/, '');
  const url = new URL(`${base.origin}${basePath}${path}`);
  for (const { name, value } of params) url.searchParams.set(name, value);
  return url.toString();
}

/** True when both URLs have the same scheme, host and port; false when either is not a URL. */
export function sameOrigin(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}

/** What an HTTP header value can carry (RFC 9110): visible ASCII, space, tab and Latin-1; no control characters. */
const HEADER_VALUE_CHARS = /^[\t\x20-\x7e\x80-\xff]*$/;

/** Whether fetch can send `value` in a header as it is: one line, no control characters, nothing beyond Latin-1. */
export function isSendableHeaderValue(value: string): boolean {
  return HEADER_VALUE_CHARS.test(value);
}

/** Every whole number beyond 2^53 - 1 is written with at least 16 digits. */
const LONG_DIGIT_RUN = /\d{16}/;
const LONG_INTEGER_LITERAL = /^-?\d{16,}$/;
/** Characters a JSON number is written with, after its first. */
const NUMBER_CHARS = new Set(['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '.', 'e', 'E', '+', '-']);
const MAX_SAFE_INTEGER = BigInt(Number.MAX_SAFE_INTEGER);

/**
 * The first whole-number literal in valid JSON `text` that a JavaScript number cannot keep exactly
 * (|n| > 2^53 - 1: JSON.parse silently rounds 9007199254740993 to ...992, so two IDs would become one), as
 * written. Decimals and exponents are left alone: they are approximate by nature. Strings are skipped.
 * The scan runs only when the text holds 16 digits in a row, so most bodies cost one quick regex test.
 * A plain loop rather than one regex over the text: a regex over a long string overflows V8's stack.
 */
export function unsafeIntegerIn(text: string): string | undefined {
  if (!LONG_DIGIT_RUN.test(text)) return undefined;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === '"') {
      index = closingQuote(text, index);
      continue;
    }
    // Outside strings, valid JSON has a digit or minus sign only where a number starts.
    if (char !== '-' && (char < '0' || char > '9')) continue;
    let end = index + 1;
    while (end < text.length && NUMBER_CHARS.has(text[end])) end += 1;
    const token = text.slice(index, end);
    if (LONG_INTEGER_LITERAL.test(token) && BigInt(token.replace(/^-/, '')) > MAX_SAFE_INTEGER) return token;
    index = end - 1;
  }
  return undefined;
}

/** Where the string opened at `open` ends: the next quote not escaped by an odd number of backslashes. */
function closingQuote(text: string, open: number): number {
  for (let quote = text.indexOf('"', open + 1); quote !== -1; quote = text.indexOf('"', quote + 1)) {
    let backslashes = 0;
    while (text[quote - 1 - backslashes] === '\\') backslashes += 1;
    if (backslashes % 2 === 0) return quote;
  }
  return text.length;
}

/** One page to fetch, with what the planner needs to plan the page after it. */
export type PageRequest =
  | { type: 'none'; url: string }
  | { type: 'page'; url: string; page: number }
  | { type: 'offset'; url: string; offset: number }
  /** `cursor` is the value sent for this page; null for the first page, which sends none. */
  | { type: 'cursor'; url: string; cursor: string | null }
  | { type: 'nextUrl'; url: string }
  | { type: 'linkHeader'; url: string };

/** Response headers as `fetch` exposes them. */
export interface ResponseHeaders {
  get(name: string): string | null;
}

/** What the planner reads from a fetched page. */
export interface FetchedPage {
  body: unknown;
  /** Items found at the endpoint's data path. */
  items: number;
  headers: ResponseHeaders;
}

/** The connection settings a page URL is built from. */
export type HttpUrlSettings = Pick<HttpConfig, 'baseUrl' | 'query'>;

/** The first page of an endpoint: its URL with the first page number, offset 0, or no cursor. */
export function firstPage(settings: HttpUrlSettings, endpoint: HttpEndpoint): PageRequest {
  const pagination = endpoint.pagination;
  switch (pagination.type) {
    case 'page':
      return { type: 'page', url: pageUrl(settings, endpoint, pageNumberParams(pagination, pagination.firstPage)), page: pagination.firstPage };
    case 'offset':
      return { type: 'offset', url: pageUrl(settings, endpoint, offsetParams(pagination, 0)), offset: 0 };
    case 'cursor':
      return { type: 'cursor', url: pageUrl(settings, endpoint, []), cursor: null };
    default:
      return { type: pagination.type, url: pageUrl(settings, endpoint, []) };
  }
}

/**
 * The page after `current`, or undefined when `fetched` was the last one. Page and offset mode stop at an
 * empty page, the only end they can see; cursor, next-URL and Link modes stop when the response names no next
 * page, and follow one that it names even after an empty page (some APIs return those mid-way, e.g. after
 * filtering a page on the server).
 * A page shorter than the size asked for does not stop page or offset mode: a server that caps its page
 * size without saying so would otherwise end the sync early, silently.
 * Next URLs are resolved against the current URL but not checked: refusing another origin, a repeated
 * page or cursor and too many pages is the connector's job.
 */
export function nextPage(settings: HttpUrlSettings, endpoint: HttpEndpoint, current: PageRequest, fetched: FetchedPage): PageRequest | undefined {
  const pagination = endpoint.pagination;
  switch (pagination.type) {
    case 'none':
      return undefined;
    case 'page': {
      if (current.type !== 'page' || fetched.items === 0) return undefined;
      const page = current.page + 1;
      return { type: 'page', url: pageUrl(settings, endpoint, pageNumberParams(pagination, page)), page };
    }
    case 'offset': {
      if (current.type !== 'offset' || fetched.items === 0) return undefined;
      // Moves by what came back, so a server that returns more than asked skips nothing.
      const offset = current.offset + fetched.items;
      return { type: 'offset', url: pageUrl(settings, endpoint, offsetParams(pagination, offset)), offset };
    }
    case 'cursor': {
      const cursor = cursorAt(fetched.body, pagination.cursorPath);
      if (cursor === undefined) return undefined;
      return { type: 'cursor', url: pageUrl(settings, endpoint, [{ name: pagination.cursorParam, value: cursor }]), cursor };
    }
    case 'nextUrl': {
      const next = nextUrlAt(fetched.body, pagination.nextUrlPath);
      return next === undefined ? undefined : { type: 'nextUrl', url: resolveUrl(next, current.url, `Next-page URL field "${pagination.nextUrlPath}"`) };
    }
    case 'linkHeader': {
      const next = parseLinkNext(fetched.headers.get(pagination.header));
      return next === undefined ? undefined : { type: 'linkHeader', url: resolveUrl(next, current.url, `The ${pagination.header} header's next link`) };
    }
  }
}

type PagePagination = Extract<HttpEndpoint['pagination'], { type: 'page' }>;
type OffsetPagination = Extract<HttpEndpoint['pagination'], { type: 'offset' }>;

function pageUrl(settings: HttpUrlSettings, endpoint: HttpEndpoint, pageParams: readonly QueryParam[]): string {
  return endpointUrl(settings.baseUrl, endpoint.path, [...settings.query, ...endpoint.query, ...pageParams]);
}

function pageNumberParams(pagination: PagePagination, page: number): QueryParam[] {
  const params = [{ name: pagination.pageParam, value: String(page) }];
  if (pagination.size) params.push({ name: pagination.size.param, value: String(pagination.size.value) });
  return params;
}

function offsetParams(pagination: OffsetPagination, offset: number): QueryParam[] {
  return [
    { name: pagination.offsetParam, value: String(offset) },
    { name: pagination.limitParam, value: String(pagination.limit) },
  ];
}

/** The next cursor as text, or undefined when the field is missing, null or empty. */
function cursorAt(body: unknown, path: string): string | undefined {
  const value = getPath(body, path);
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  throw new ValidationError(`Cursor field "${path}" holds ${describeType(value)}, not text or a number`);
}

/** The next URL text, or undefined when the field is missing, null or empty. */
function nextUrlAt(body: unknown, path: string): string | undefined {
  const value = getPath(body, path);
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value === 'string') return value;
  throw new ValidationError(`Next-page URL field "${path}" holds ${describeType(value)}, not a URL`);
}

/** `next` resolved against `current`; the value is left out of the error, as it may hold a key. */
function resolveUrl(next: string, current: string, what: string): string {
  try {
    return new URL(next, current).toString();
  } catch {
    throw new ValidationError(`${what} is not a URL`);
  }
}

/**
 * The `rel="next"` target of a Link header (RFC 8288), or undefined when there is none.
 * Handles several links, quoted and unquoted rel values, and rel lists such as `rel="next last"`.
 * The target is returned as written; it may be relative.
 */
export function parseLinkNext(header: string | null | undefined): string | undefined {
  if (!header) return undefined;
  // Each link is `<target>` followed by its parameters, up to the next `<`.
  for (const [, target, params] of header.matchAll(/<([^>]*)>([^<]*)/g)) {
    const rel = /(?:^|;)\s*rel\s*=\s*(?:"([^"]*)"|([^\s;,]+))/i.exec(params);
    const relations = (rel?.[1] ?? rel?.[2] ?? '').toLowerCase().split(/\s+/);
    if (relations.includes('next')) return target.trim();
  }
  return undefined;
}

/** Every HTTP date format (RFC 9110: IMF-fixdate, RFC 850, asctime) starts with the day name. */
const HTTP_DATE_START = /^(?:mon|tue|wed|thu|fri|sat|sun)/i;

/**
 * How long a Retry-After header asks to wait, in milliseconds: from delay seconds or an HTTP date
 * (a date already past gives 0). Undefined when the header is missing or unreadable.
 */
export function retryAfterMs(value: string | null | undefined, now: number): number | undefined {
  const text = value?.trim();
  if (!text) return undefined;
  if (/^\d+$/.test(text)) return Number(text) * 1000;
  // Date.parse alone would read text such as "-5" as a year.
  if (!HTTP_DATE_START.test(text)) return undefined;
  const at = Date.parse(text);
  return Number.isNaN(at) ? undefined : Math.max(0, at - now);
}

/** Matches X-RateLimit-*, RateLimit and RateLimit-*, and Retry-After. */
const RATE_LIMIT_HEADER = /^(?:x-ratelimit-.+|ratelimit(?:-.+)?|retry-after)$/i;

/** The rate-limit headers of a response, in the order given, each value cut to 100 characters. */
export function rateLimitHeaders(headers: Iterable<readonly [string, string]>): HeaderPair[] {
  const found: HeaderPair[] = [];
  for (const [name, value] of headers) {
    if (RATE_LIMIT_HEADER.test(name)) found.push({ name, value: value.slice(0, MAX_HEADER_VALUE_SHOWN) });
  }
  return found;
}

/** An array in a response body that could hold an endpoint's items. */
export interface ArrayPath {
  /** The data path: `$` for a body that is the array itself, otherwise a dotted path. */
  path: string;
  items: number;
  /** The keys of the first item (none for an empty array). */
  keys: string[];
}

/**
 * The arrays in a body that could be its items: arrays of plain objects, and empty arrays.
 * Looks through objects up to {@link ARRAY_SEARCH_DEPTH} keys deep, in document order, but never inside
 * an array. Skips keys that a data path cannot name (with a dot, `$`, or such as `__proto__`).
 */
export function findArrayPaths(body: unknown): ArrayPath[] {
  if (Array.isArray(body)) return isItemList(body) ? [arrayPath('$', body)] : [];
  const found: ArrayPath[] = [];
  collectArrayPaths(body, [], found);
  return found;
}

function collectArrayPaths(node: unknown, parents: readonly string[], found: ArrayPath[]): void {
  if (!isPlainObject(node) || parents.length >= ARRAY_SEARCH_DEPTH) return;
  for (const [key, value] of Object.entries(node)) {
    if (key.includes('.') || !isSafeFieldPath(key)) continue;
    const segments = [...parents, key];
    if (Array.isArray(value)) {
      if (isItemList(value)) found.push(arrayPath(segments.join('.'), value));
    } else {
      collectArrayPaths(value, segments, found);
    }
  }
}

function isItemList(values: readonly unknown[]): boolean {
  return values.every(isPlainObject);
}

function arrayPath(path: string, items: readonly unknown[]): ArrayPath {
  const first = items[0];
  return { path, items: items.length, keys: isPlainObject(first) ? Object.keys(first).slice(0, MAX_KEYS_SHOWN) : [] };
}

/**
 * The items at `dataPath` (`$` for the body itself). Refuses a path that is missing or holds no array,
 * and an array with an item that is not an object, since each item becomes one row.
 */
export function itemsAt(body: unknown, dataPath: string): Row[] {
  const value = dataPath === '$' ? body : getPath(body, dataPath);
  if (value === undefined) throw new ValidationError(`Data path "${dataPath}" is not in the response`);
  if (!Array.isArray(value)) throw new ValidationError(`Data path "${dataPath}" holds ${describeType(value)}, not a list of items`);
  const index = value.findIndex((item) => !isPlainObject(item));
  if (index >= 0) {
    throw new ValidationError(`Data path "${dataPath}": item ${index + 1} is ${describeType(value[index])}, not an object; each item must be an object to become a row`);
  }
  return value as Row[];
}

/** "a list", "an object", "text"... for messages. Never the value itself, which may be customer data. */
function describeType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'a list';
  if (typeof value === 'object') return 'an object';
  if (typeof value === 'string') return 'text';
  if (typeof value === 'number') return 'a number';
  if (typeof value === 'boolean') return 'true/false';
  return typeof value;
}

/** `url` with the API key query parameter's value shown as `***`, for errors, logs and the Query tab. */
export function maskedUrl(url: string, auth: HttpAuth): string {
  if (auth.type !== 'apiKeyQuery') return url;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    // Unreadable, so the key cannot be found in it: show nothing of it.
    return '(not a valid URL)';
  }
  if (!parsed.searchParams.has(auth.param)) return url;
  parsed.searchParams.set(auth.param, MASK);
  return parsed.toString();
}

/** What an HTTP read does, for the Query tab. */
export interface HttpReadDescription {
  config: Pick<HttpConfig, 'baseUrl' | 'query' | 'auth' | 'headers' | 'minIntervalSeconds'>;
  endpoint: HttpEndpoint;
  filters?: readonly SourceFilter[];
  limit?: number;
}

/**
 * An HTTP read as text: the first request (with auth masked), how it pages, where the items are,
 * and the filters and limit applied in memory.
 */
export function describeHttpRead(read: HttpReadDescription): string {
  const lines = [...describeRequest(read.config, read.endpoint), describePagination(read.endpoint), `Items: ${itemsLabel(read.endpoint.dataPath)}`];
  const filters = read.filters ?? [];
  if (filters.length > 0) lines.push(`Keeping items where ${filters.map(describeFilter).join(' and ')}`);
  if (read.limit !== undefined) lines.push(`First ${read.limit} ${read.limit === 1 ? 'item' : 'items'}, then no more requests`);
  return lines.join('\n');
}

/** A key lookup in an HTTP endpoint as text: every page is fetched and indexed once per run, then each key is matched. */
export function describeHttpKeyLookup(config: HttpReadDescription['config'], endpoint: HttpEndpoint, keyFields: readonly string[], keys: readonly Row[]): string {
  const shown = keys.map((key) => {
    const values = keyFields.map((field) => formatValue(key[field]));
    return values.length === 1 ? values[0] : `(${values.join(', ')})`;
  });
  const count = `${keys.length} ${keys.length === 1 ? 'key' : 'keys'}`;
  return [
    ...describeRequest(config, endpoint),
    describePagination(endpoint),
    `Items: ${itemsLabel(endpoint.dataPath)}`,
    `Fetch every page and index the items by ${keyFields.join(', ')} (once per run), then match ${count}${shown.length > 0 ? `: ${shown.join(', ')}` : ''}`,
  ].join('\n');
}

/** The first request line and its headers, auth masked. */
function describeRequest(config: HttpReadDescription['config'], endpoint: HttpEndpoint): string[] {
  const first = firstPage(config, endpoint);
  const url = config.auth.type === 'apiKeyQuery' ? withParam(first.url, config.auth.param, MASK) : first.url;
  const lines = [`GET ${url}`, 'Accept: application/json'];
  const authHeader = authHeaderLine(config.auth);
  if (authHeader) lines.push(authHeader);
  for (const header of config.headers) lines.push(`${header.name}: ${header.value}`);
  if (config.minIntervalSeconds > 0) lines.push(`At most one request every ${config.minIntervalSeconds} s to this API`);
  return lines;
}

function withParam(url: string, name: string, value: string): string {
  const parsed = new URL(url);
  parsed.searchParams.set(name, value);
  return parsed.toString();
}

function authHeaderLine(auth: HttpAuth): string | undefined {
  switch (auth.type) {
    case 'bearer':
      return `Authorization: Bearer ${MASK}`;
    case 'basic':
      return `Authorization: Basic ${auth.username}:${MASK}`;
    case 'apiKeyHeader':
      return `${auth.header}: ${MASK}`;
    default:
      return undefined;
  }
}

function describePagination(endpoint: HttpEndpoint): string {
  const pagination = endpoint.pagination;
  const empty = 'stops at an empty page';
  switch (pagination.type) {
    case 'none':
      return 'Pages: one request';
    case 'page': {
      const size = pagination.size ? `, ${pagination.size.param}=${pagination.size.value}` : '';
      return `Pages: ${pagination.pageParam}=${pagination.firstPage}, ${pagination.firstPage + 1}, ...${size}; ${empty}`;
    }
    case 'offset':
      return `Pages: ${pagination.offsetParam}=0, then by items received, ${pagination.limitParam}=${pagination.limit}; ${empty}`;
    case 'cursor':
      return `Pages: ${pagination.cursorParam}=<cursor> from response field ${pagination.cursorPath}; stops when the field is empty`;
    case 'nextUrl':
      return `Pages: next URL from response field ${pagination.nextUrlPath} (same origin only); stops when the field is empty`;
    case 'linkHeader':
      return `Pages: rel="next" link of the ${pagination.header} header (same origin only); stops when there is no next link`;
  }
}

function itemsLabel(dataPath: string): string {
  return dataPath === '$' ? 'the whole body ($)' : dataPath;
}

const OP_SYMBOLS: Record<FilterOp, string> = { eq: '=', ne: '!=', gt: '>', gte: '>=', lt: '<', lte: '<=' };

function describeFilter(filter: SourceFilter): string {
  const condition = `${filter.field} ${OP_SYMBOLS[filter.op]} ${formatValue(filter.value)}`;
  return filter.op === 'ne' ? `(${filter.field} is empty or ${condition})` : condition;
}

function formatValue(value: unknown): string {
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (typeof value === 'string') return JSON.stringify(value);
  return String(value);
}
