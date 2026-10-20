import { createHash } from 'node:crypto';
import { NotFoundError, ValidationError } from '../../common/errors';
import { matchesFilters } from '../../common/filters';
import { getPath } from '../../common/paths';
import { keyString } from '../../common/values';
import { ConnectorConfig, HTTP_FULL_MODE_ONLY, HeaderPair, HttpEndpoint, HttpProbeResult } from '../../connections/connection.model';
import { CollectionInfo, Connector, FieldInfo, ReadRequest, Row, SourceScope } from '../connector.types';
import { inferSchema } from '../schema-inference';
import { HttpClient, sizeText } from './http-client';
import { PageRequest, describeHttpKeyLookup, describeHttpRead, findArrayPaths, firstPage, itemsAt, maskedUrl, nextPage, rateLimitHeaders, sameOrigin } from './http-format';
import { Clock, RequestSpacer } from './request-spacer';

/** Pages fetched from one endpoint before Syncforge assumes its pagination never ends. */
const MAX_PAGES = 10_000;
/** Items sampled to describe an endpoint's fields. */
const DESCRIBE_SAMPLE = 200;

const READ_ONLY = 'HTTP API connections can only be read: Syncforge sends GET requests only';

/** What an HTTP connector is opened with: the saved settings plus the response size limit. */
export type HttpConnectorConfig = Extract<ConnectorConfig, { kind: 'http' }>;

export interface HttpConnectorOptions {
  /** Spaces requests to this API; shared by every connector of the same origin, so lookups share the budget. */
  spacer: RequestSpacer;
  clock?: Clock;
  /** Pages per endpoint before a read fails; {@link MAX_PAGES} by default. */
  maxPages?: number;
}

/** One fetched page: its items and its size on the wire. */
interface FetchedItems {
  items: Row[];
  bytes: number;
}

/** A key index of one endpoint: every item under the key string of its key fields. */
type KeyIndex = Map<string, Row[]>;

/**
 * Reads an HTTP API with GET: each endpoint is a collection, read page by page. Filters run in memory.
 * Read-only: upserts are refused.
 */
export class HttpConnector implements Connector {
  private readonly client: HttpClient;
  private readonly maxPages: number;
  /** Built on the first key lookup per endpoint and key fields; the connector lives for one pipeline, so it never goes stale mid-run. */
  private readonly indexes = new Map<string, Promise<KeyIndex>>();

  constructor(
    private readonly config: HttpConnectorConfig,
    options: HttpConnectorOptions,
  ) {
    this.client = new HttpClient(config, options.spacer, options.clock);
    this.maxPages = options.maxPages ?? MAX_PAGES;
  }

  /** One request to the first page of the first endpoint, without retries: the API answers with JSON. */
  async ping(): Promise<void> {
    await this.pingForRateLimit();
  }

  /** {@link ping}, returning the rate-limit headers of its response, which a connection test shows. */
  async pingForRateLimit(): Promise<HeaderPair[]> {
    const endpoint = this.config.endpoints[0];
    const response = await this.client.get(endpoint.name, firstPage(this.config, endpoint).url, { maxRetries: 0 });
    return rateLimitHeaders(response.headers);
  }

  async close(): Promise<void> {
    this.indexes.clear();
  }

  async listCollections(): Promise<CollectionInfo[]> {
    return this.config.endpoints.map((endpoint) => ({ name: endpoint.name, kind: 'endpoint' as const }));
  }

  /** Fields of the first items of the first page. */
  async describeCollection(collection: string): Promise<FieldInfo[]> {
    const endpoint = this.endpoint(collection);
    for await (const { items } of this.pages(endpoint)) return inferSchema(items.slice(0, DESCRIBE_SAMPLE), []);
    return [];
  }

  async *readBatches(request: ReadRequest): AsyncIterable<Row[]> {
    if (request.watermark) throw new ValidationError(HTTP_FULL_MODE_ONLY);
    const endpoint = this.endpoint(request.collection);
    const filters = request.filters ?? [];
    const limit = request.limit ?? Number.POSITIVE_INFINITY;
    if (limit <= 0) return;
    let batch: Row[] = [];
    let taken = 0;
    // Batches fill across pages; leaving the loop at the limit stops the pages before the next request.
    for await (const { items } of this.pages(endpoint, request.signal)) {
      for (const item of items) {
        if (!matchesFilters(item, filters)) continue;
        batch.push(item);
        taken += 1;
        const done = taken >= limit;
        if (done || batch.length >= request.batchSize) {
          yield batch;
          batch = [];
        }
        if (done) return;
      }
    }
    if (batch.length > 0) yield batch;
  }

  /** Fetches every page: APIs have no common way to report a total. */
  async count(collection: string, scope: SourceScope = {}): Promise<number> {
    if (scope.query !== undefined) throw new ValidationError('HTTP API connections read endpoints, not SQL queries');
    const endpoint = this.endpoint(collection);
    const filters = scope.filters ?? [];
    let total = 0;
    // Not cancellable: `Connector.count` takes no signal. Only reconcile counts, outside the run loop.
    for await (const { items } of this.pages(endpoint)) {
      total += items.filter((item) => matchesFilters(item, filters)).length;
    }
    return total;
  }

  explainRead(request: ReadRequest): string {
    return describeHttpRead({ config: this.config, endpoint: this.endpoint(request.collection), filters: request.filters, limit: request.limit });
  }

  /** Keys compare by `keyString`, so 42 finds "42". Every page of the endpoint is indexed once per connector. */
  async findByKeys(collection: string, keyFields: string[], keys: Row[]): Promise<Row[]> {
    if (keys.length === 0) return [];
    const index = await this.indexFor(this.endpoint(collection), keyFields);
    const wanted = new Set(keys.map((key) => keyString(keyFields.map((field) => key[field]))));
    return [...wanted].flatMap((key) => index.get(key) ?? []);
  }

  explainFindByKeys(collection: string, keyFields: string[], keys: Row[]): string {
    return describeHttpKeyLookup(this.config, this.endpoint(collection), keyFields, keys);
  }

  async upsert(): Promise<void> {
    throw new ValidationError(READ_ONLY);
  }

  explainUpsert(): string {
    throw new ValidationError(READ_ONLY);
  }

  /**
   * One request to an endpoint's first page, without retries, to help set it up: the status and rate-limit
   * headers whatever the status, and for a 2xx JSON body the arrays found in it and where the next page is.
   */
  async probe(collection: string, signal?: AbortSignal): Promise<HttpProbeResult> {
    const endpoint = this.endpoint(collection);
    const request = firstPage(this.config, endpoint);
    const response = await this.client.probe(endpoint.name, request.url, signal);
    const ok = response.status >= 200 && response.status < 300;
    return {
      status: response.status,
      latencyMs: response.latencyMs,
      bytes: response.bytes,
      contentType: response.contentType,
      rateLimit: rateLimitHeaders(response.headers),
      arrays: ok ? findArrayPaths(response.body) : [],
      nextPage: ok ? this.nextPagePreview(endpoint, request, response.body, response.headers) : null,
    };
  }

  /**
   * Every page of an endpoint, in order, until `nextPage` says it was the last; a short page does not stop it.
   * Refuses a next page on another origin, a page asked for twice (a loop), a page or offset that brings the
   * same items as the one before (an API repeating its last page), and more than `maxPages` pages, rather than
   * ending the read early or looping without saying so.
   */
  private async *pages(endpoint: HttpEndpoint, signal?: AbortSignal): AsyncGenerator<FetchedItems> {
    const fetched = new Set<string>();
    let previousDigest: string | undefined;
    let request: PageRequest | undefined = firstPage(this.config, endpoint);
    while (request) {
      if (fetched.size >= this.maxPages) {
        throw new ValidationError(`Endpoint "${endpoint.name}": still more pages after ${this.maxPages}; check its pagination settings`);
      }
      fetched.add(request.url);
      const response = await this.client.get(endpoint.name, request.url, { signal });
      const items = this.withEndpointName(endpoint, () => itemsAt(response.body, endpoint.dataPath));
      // Page and offset URLs never repeat, so only the items can show an API answering past its end with its last page.
      if ((request.type === 'page' || request.type === 'offset') && items.length > 0) {
        const digest = itemsDigest(items);
        if (digest === previousDigest) this.refuseRepeatedPage(endpoint, request);
        previousDigest = digest;
      }
      yield { items, bytes: response.bytes };
      const current: PageRequest = request;
      request = this.withEndpointName(endpoint, () => nextPage(this.config, endpoint, current, { body: response.body, items: items.length, headers: response.headers }));
      if (request) this.assertFollowable(endpoint, request, fetched);
    }
  }

  /** Refuses a next page that would leave the API's origin or repeat a page already fetched. */
  private assertFollowable(endpoint: HttpEndpoint, next: PageRequest, fetched: ReadonlySet<string>): void {
    const prefix = `Endpoint "${endpoint.name}"`;
    if (!sameOrigin(next.url, this.config.baseUrl)) {
      // Only the origin is named: the rest of the address may carry a token.
      throw new ValidationError(
        `${prefix}: the next page is on another origin (${new URL(next.url).origin}). Only pages within ${new URL(this.config.baseUrl).origin} are fetched, so credentials never leave it`,
      );
    }
    if (!fetched.has(next.url)) return;
    if (next.type === 'cursor') throw new ValidationError(`${prefix}: the API returned the same cursor twice, so paging would never end`);
    throw new ValidationError(`${prefix}: the API pointed back to a page already fetched (${maskedUrl(next.url, this.config.auth)}), so paging would never end`);
  }

  private refuseRepeatedPage(endpoint: HttpEndpoint, request: PageRequest): never {
    throw new ValidationError(
      `Endpoint "${endpoint.name}": GET ${maskedUrl(request.url, this.config.auth)} returned the same items as the page before it, so paging would never end. The API may repeat its last page instead of returning an empty one; use cursor, next-URL or Link paging if it offers them`,
    );
  }

  /** The next page URL a probe shows; none while the data path does not find the items yet. */
  private nextPagePreview(endpoint: HttpEndpoint, request: PageRequest, body: unknown, headers: Headers): string | null {
    let items: number;
    try {
      items = itemsAt(body, endpoint.dataPath).length;
    } catch (error) {
      // Expected while setting up: the probe lists the arrays found, to pick the data path from.
      if (error instanceof ValidationError) return null;
      throw error;
    }
    const next = this.withEndpointName(endpoint, () => nextPage(this.config, endpoint, request, { body, items, headers }));
    return next ? maskedUrl(next.url, this.config.auth) : null;
  }

  private indexFor(endpoint: HttpEndpoint, keyFields: readonly string[]): Promise<KeyIndex> {
    const cacheKey = JSON.stringify([endpoint.name, keyFields]);
    let index = this.indexes.get(cacheKey);
    if (!index) {
      index = this.buildIndex(endpoint, keyFields);
      // A failed build is not kept, so a later call fetches again instead of repeating the failure.
      index.catch(() => this.indexes.delete(cacheKey));
      this.indexes.set(cacheKey, index);
    }
    return index;
  }

  /**
   * Holds every page in memory, so all pages together must fit in one response's size limit. Serves lookups and
   * re-runs of failed rows alike, so its refusal names neither.
   */
  private async buildIndex(endpoint: HttpEndpoint, keyFields: readonly string[]): Promise<KeyIndex> {
    const index: KeyIndex = new Map();
    let bytes = 0;
    // Not cancellable: `findByKeys` takes no signal. A run notices a cancel at its next check after the lookup.
    for await (const page of this.pages(endpoint)) {
      bytes += page.bytes;
      if (bytes > this.config.maxResponseBytes) {
        throw new ValidationError(
          `Reading endpoint "${endpoint.name}" by key holds every page in memory, and its pages add up to more than ${sizeText(this.config.maxResponseBytes)} (the HTTP response size limit in Settings). Narrow the endpoint with query params, or raise the limit in Settings`,
        );
      }
      for (const item of page.items) {
        const key = keyString(keyFields.map((field) => getPath(item, field)));
        const rows = index.get(key);
        if (rows) rows.push(item);
        else index.set(key, [item]);
      }
    }
    return index;
  }

  private endpoint(name: string): HttpEndpoint {
    const endpoint = this.config.endpoints.find((candidate) => candidate.name === name);
    if (endpoint) return endpoint;
    const names = this.config.endpoints.map((candidate) => `"${candidate.name}"`).join(', ');
    throw new NotFoundError(`This API has no endpoint named "${name}"; its endpoints are ${names}`);
  }

  /** Runs `work`, putting the endpoint's name in front of a refusal from the page helpers. */
  private withEndpointName<T>(endpoint: HttpEndpoint, work: () => T): T {
    try {
      return work();
    } catch (error) {
      if (error instanceof ValidationError) throw new ValidationError(`Endpoint "${endpoint.name}": ${error.message}`);
      throw error;
    }
  }
}

/** A fingerprint of a page's items, to notice the same page twice in a row without keeping the page. */
function itemsDigest(items: readonly Row[]): string {
  return createHash('sha256').update(JSON.stringify(items)).digest('hex');
}
