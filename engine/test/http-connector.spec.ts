import { IncomingHttpHeaders, IncomingMessage, Server, ServerResponse, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { NotFoundError, UpstreamError, ValidationError } from '../src/common/errors';
import { HTTP_FULL_MODE_ONLY, httpConfigSchema } from '../src/connections/connection.model';
import { ReadRequest, Row } from '../src/connectors/connector.types';
import { MAX_RETRIES, MAX_RETRY_WAIT_MS } from '../src/connectors/http/http-client';
import { HttpConnector, HttpConnectorConfig } from '../src/connectors/http/http.connector';
import { RequestSpacer, Sleep } from '../src/connectors/http/request-spacer';
import { KeyedRowsReader } from '../src/sync/keyed-rows-reader';

/** Made-up credentials and response text: no error message may ever contain them. */
const TOKEN = 'tok-s3cret-123'; // secret-scan: allow
const CANARY = 'canary-customer-data-77';

/** On a whole second, so an HTTP date (second precision) is an exact wait. */
const START = Date.UTC(2026, 0, 1, 12, 0, 0);

interface SeenRequest {
  path: string;
  headers: IncomingHttpHeaders;
}

type Handler = (url: URL, response: ServerResponse, request: IncomingMessage) => void;

interface Stub {
  base: string;
  requests: SeenRequest[];
}

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
});

/** A stub API on 127.0.0.1 and a free port that records every request. */
async function stub(handler: Handler): Promise<Stub> {
  const requests: SeenRequest[] = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://stub');
    requests.push({ path: `${url.pathname}${url.search}`, headers: request.headers });
    handler(url, response, request);
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, requests };
}

function json(response: ServerResponse, body: unknown, status = 200, headers: Record<string, string> = {}): void {
  response.writeHead(status, { 'content-type': 'application/json', ...headers });
  response.end(JSON.stringify(body));
}

/** A 200 response with `text` as its JSON body, exactly as written. */
function rawJson(response: ServerResponse, text: string): void {
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(text);
}

/** Items with ids `from`, `from + 1`, ... */
function items(count: number, from = 1): Row[] {
  return Array.from({ length: count }, (_, index) => ({ id: from + index, name: `item ${from + index}` }));
}

/** A connector on a fake clock: every spacer sleep moves the clock and is recorded instead of waited. */
function connect(base: string, endpoint: Record<string, unknown> = {}, overrides: Record<string, unknown> = {}, maxPages?: number) {
  let now = START;
  const sleeps: number[] = [];
  const sleep: Sleep = async (ms, signal) => {
    signal?.throwIfAborted();
    sleeps.push(ms);
    now += ms;
  };
  const clock = () => now;
  const config: HttpConnectorConfig = {
    ...httpConfigSchema.parse({ kind: 'http', baseUrl: `${base}/v2`, endpoints: [{ name: 'users', path: '/users', ...endpoint }], ...overrides }),
    maxResponseBytes: 1024 * 1024,
    ...(typeof overrides.maxResponseBytes === 'number' ? { maxResponseBytes: overrides.maxResponseBytes } : {}),
  };
  const connector = new HttpConnector(config, { spacer: new RequestSpacer(clock, sleep), clock, maxPages });
  return { connector, sleeps };
}

async function readAll(connector: HttpConnector, request: Partial<ReadRequest> = {}): Promise<Row[][]> {
  const batches: Row[][] = [];
  for await (const batch of connector.readBatches({ collection: 'users', batchSize: 100, ...request })) batches.push(batch);
  return batches;
}

/** The error a promise rejects with. */
async function failure(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error('expected a rejection');
}

/** A port nothing listens on: taken and released at once. */
async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

/** Serves `all` in pages of the requested size, but never more than `cap` per page. */
function pagedServer(all: Row[], cap = Number.POSITIVE_INFINITY): Handler {
  return (url, response) => {
    const size = Math.min(Number(url.searchParams.get('per_page') ?? url.searchParams.get('limit') ?? 10), cap);
    const start = url.searchParams.has('offset') ? Number(url.searchParams.get('offset')) : (Number(url.searchParams.get('page') ?? 1) - 1) * size;
    json(response, { data: all.slice(start, start + size) });
  };
}

describe('HttpConnector pagination', () => {
  it('reads the items at the data path with one request when there is no pagination', async () => {
    const api = await stub((_, response) => json(response, { data: { users: items(3) } }));
    const { connector } = connect(api.base, { dataPath: 'data.users' });
    expect((await readAll(connector)).flat().map((row) => row.id)).toEqual([1, 2, 3]);
    expect(api.requests.map((request) => request.path)).toEqual(['/v2/users']);
  });

  it('fills batches across page boundaries in page mode and stops at the empty page', async () => {
    const api = await stub(pagedServer(items(7)));
    const { connector } = connect(api.base, { dataPath: 'data', pagination: { type: 'page', size: { param: 'per_page', value: 3 } } });
    const batches = await readAll(connector, { batchSize: 2 });
    expect(batches.map((batch) => batch.map((row) => row.id))).toEqual([[1, 2], [3, 4], [5, 6], [7]]);
    expect(api.requests.map((request) => request.path)).toEqual([
      '/v2/users?page=1&per_page=3',
      '/v2/users?page=2&per_page=3',
      '/v2/users?page=3&per_page=3',
      '/v2/users?page=4&per_page=3',
    ]);
  });

  it('reads every row from a server that caps the page size below the one asked for (page mode)', async () => {
    const api = await stub(pagedServer(items(5), 2));
    const { connector } = connect(api.base, { dataPath: 'data', pagination: { type: 'page', size: { param: 'per_page', value: 10 } } });
    expect((await readAll(connector)).flat().map((row) => row.id)).toEqual([1, 2, 3, 4, 5]);
  });

  it('reads every row from a server that caps the page size below the one asked for (offset mode)', async () => {
    const api = await stub(pagedServer(items(5), 2));
    const { connector } = connect(api.base, { dataPath: 'data', pagination: { type: 'offset', limit: 10 } });
    expect((await readAll(connector)).flat().map((row) => row.id)).toEqual([1, 2, 3, 4, 5]);
    expect(api.requests.map((request) => request.path)).toEqual([
      '/v2/users?offset=0&limit=10',
      '/v2/users?offset=2&limit=10',
      '/v2/users?offset=4&limit=10',
      '/v2/users?offset=5&limit=10',
    ]);
  });

  it('keeps asking without a page size until an empty page', async () => {
    const api = await stub((url, response) => json(response, Number(url.searchParams.get('page')) < 3 ? items(1, Number(url.searchParams.get('page'))) : []));
    const { connector } = connect(api.base, { pagination: { type: 'page' } });
    expect((await readAll(connector)).flat().map((row) => row.id)).toEqual([1, 2]);
    expect(api.requests).toHaveLength(3);
  });

  it('follows the cursor in the body until it is missing', async () => {
    const pages: Record<string, unknown> = {
      '': { data: items(2, 1), meta: { next: 'c1' } },
      c1: { data: items(2, 3), meta: { next: 'c2' } },
      c2: { data: items(1, 5), meta: { next: null } },
    };
    const api = await stub((url, response) => json(response, pages[url.searchParams.get('after') ?? '']));
    const { connector } = connect(api.base, { dataPath: 'data', pagination: { type: 'cursor', cursorPath: 'meta.next', cursorParam: 'after' } });
    expect((await readAll(connector)).flat().map((row) => row.id)).toEqual([1, 2, 3, 4, 5]);
    expect(api.requests.map((request) => request.path)).toEqual(['/v2/users', '/v2/users?after=c1', '/v2/users?after=c2']);
  });

  it('reads on past an empty page that still names a next cursor', async () => {
    const pages: Record<string, unknown> = {
      '': { data: items(2, 1), next: 'c1' },
      c1: { data: [], next: 'c2' },
      c2: { data: items(1, 3), next: null },
    };
    const api = await stub((url, response) => json(response, pages[url.searchParams.get('after') ?? '']));
    const { connector } = connect(api.base, { dataPath: 'data', pagination: { type: 'cursor', cursorPath: 'next', cursorParam: 'after' } });
    expect((await readAll(connector)).flat().map((row) => row.id)).toEqual([1, 2, 3]);
    expect(api.requests).toHaveLength(3);
  });

  it('fails when page mode gets the same items twice in a row, without passing the repeat on', async () => {
    // Answers every page past the end with its last page, as some APIs do, with a field that changes per response.
    const all = items(5);
    const api = await stub((url, response) => {
      const start = Math.min(Number(url.searchParams.get('page')) - 1, 2) * 2;
      json(response, { data: all.slice(start, start + 2), served: url.search });
    });
    const { connector } = connect(api.base, { dataPath: 'data', pagination: { type: 'page', size: { param: 'per_page', value: 2 } } });
    const read: unknown[] = [];
    const error = await failure(
      (async () => {
        for await (const batch of connector.readBatches({ collection: 'users', batchSize: 1 })) read.push(...batch.map((row) => row.id));
      })(),
    );
    expect(error).toBeInstanceOf(ValidationError);
    expect(error.message).toBe(
      `Endpoint "users": GET ${api.base}/v2/users?page=4&per_page=2 returned the same items as the page before it, so paging would never end. The API may repeat its last page instead of returning an empty one; use cursor, next-URL or Link paging if it offers them`,
    );
    expect(read).toEqual([1, 2, 3, 4, 5]);
    expect(api.requests).toHaveLength(4);
  });

  it('fails when offset mode gets the same items twice in a row', async () => {
    // Ignores an offset past the end and returns the last items again.
    const all = items(5);
    const api = await stub((url, response) => {
      const start = Math.min(Number(url.searchParams.get('offset')), 3);
      json(response, { data: all.slice(start, start + 2) });
    });
    const { connector } = connect(api.base, { dataPath: 'data', pagination: { type: 'offset', limit: 2 } });
    await expect(readAll(connector)).rejects.toThrow(`Endpoint "users": GET ${api.base}/v2/users?offset=6&limit=2 returned the same items as the page before it`);
  });

  it('follows relative and absolute next URLs on the same origin', async () => {
    const api = await stub((url, response) => {
      if (url.searchParams.get('p') === '2') json(response, { data: items(1, 3), links: { next: `${api.base}/v2/users?p=3` } });
      else if (url.searchParams.get('p') === '3') json(response, { data: items(1, 4), links: {} });
      else json(response, { data: items(2), links: { next: 'users?p=2' } });
    });
    const { connector } = connect(api.base, { dataPath: 'data', pagination: { type: 'nextUrl', nextUrlPath: 'links.next' } });
    expect((await readAll(connector)).flat().map((row) => row.id)).toEqual([1, 2, 3, 4]);
    expect(api.requests.map((request) => request.path)).toEqual(['/v2/users', '/v2/users?p=2', '/v2/users?p=3']);
  });

  it('follows the rel="next" link of the Link header', async () => {
    const api = await stub((url, response) => {
      const page = Number(url.searchParams.get('page') ?? 1);
      const link = page < 3 ? `</v2/users?page=${page + 1}>; rel="next", </v2/users?page=3>; rel="last"` : '</v2/users?page=1>; rel="first"';
      json(response, items(1, page), 200, { link });
    });
    const { connector } = connect(api.base, { pagination: { type: 'linkHeader' } });
    expect((await readAll(connector)).flat().map((row) => row.id)).toEqual([1, 2, 3]);
    expect(api.requests).toHaveLength(3);
  });

  it('refuses a next URL on another origin without requesting it', async () => {
    const other = await stub((_, response) => json(response, { data: [] }));
    const api = await stub((_, response) => json(response, { data: items(1), next: `${other.base}/v2/users?page=2` }));
    const { connector } = connect(api.base, { dataPath: 'data', pagination: { type: 'nextUrl', nextUrlPath: 'next' } }, { auth: { type: 'bearer' }, secret: TOKEN });
    const error = await failure(readAll(connector));
    expect(error).toBeInstanceOf(ValidationError);
    expect(error.message).toBe(
      `Endpoint "users": the next page is on another origin (${other.base}). Only pages within ${api.base} are fetched, so credentials never leave it`,
    );
    expect(other.requests).toHaveLength(0);
  });

  it('refuses a next URL on the same host with another scheme or port, without requesting it', async () => {
    const otherPort = await freePort();
    let next = '';
    const api = await stub((_, response) => json(response, { data: items(1), next }));
    for (const target of [`${api.base.replace('http:', 'https:')}/v2/users?page=2`, `http://127.0.0.1:${otherPort}/v2/users?page=2`]) {
      next = target;
      const { connector } = connect(api.base, { dataPath: 'data', pagination: { type: 'nextUrl', nextUrlPath: 'next' } }, { auth: { type: 'bearer' }, secret: TOKEN });
      const before = api.requests.length;
      const error = await failure(readAll(connector));
      expect(error).toBeInstanceOf(ValidationError);
      expect(error.message).toContain(`the next page is on another origin (${new URL(target).origin})`);
      expect(api.requests).toHaveLength(before + 1);
    }
  });

  it('refuses a cursor the API already returned', async () => {
    const api = await stub((_, response) => json(response, { data: items(1), next: 'same' }));
    const { connector } = connect(api.base, { dataPath: 'data', pagination: { type: 'cursor', cursorPath: 'next', cursorParam: 'after' } });
    await expect(readAll(connector)).rejects.toThrow('Endpoint "users": the API returned the same cursor twice, so paging would never end');
    expect(api.requests).toHaveLength(2);
  });

  it('fails instead of stopping quietly when the pages never end', async () => {
    const api = await stub((url, response) => json(response, items(1, Number(url.searchParams.get('page')))));
    const { connector } = connect(api.base, { pagination: { type: 'page' } }, {}, 2);
    await expect(readAll(connector)).rejects.toThrow('Endpoint "users": still more pages after 2; check its pagination settings');
    expect(api.requests).toHaveLength(2);
  });

  it('stops fetching once the limit is reached', async () => {
    const api = await stub((_, response) => json(response, items(3)));
    const { connector } = connect(api.base, { pagination: { type: 'page' } });
    expect(await readAll(connector, { limit: 2 })).toEqual([items(2)]);
    expect(api.requests).toHaveLength(1);
  });

  it('applies filters in memory, in reads and counts', async () => {
    const api = await stub(pagedServer(items(5)));
    const { connector } = connect(api.base, { dataPath: 'data', pagination: { type: 'page', size: { param: 'per_page', value: 2 } } });
    const filters = [{ field: 'id', op: 'gte' as const, value: 3 }];
    expect((await readAll(connector, { filters })).flat().map((row) => row.id)).toEqual([3, 4, 5]);
    expect(await connector.count('users', { filters })).toBe(3);
  });

  it('refuses a watermark, writes and an unknown endpoint', async () => {
    const api = await stub((_, response) => json(response, []));
    const { connector } = connect(api.base);
    await expect(readAll(connector, { watermark: { field: 'id' } })).rejects.toThrow(HTTP_FULL_MODE_ONLY);
    await expect(connector.upsert()).rejects.toThrow('HTTP API connections can only be read');
    expect(() => connector.explainUpsert()).toThrow('HTTP API connections can only be read');
    const error = await failure(connector.count('orders'));
    expect(error).toBeInstanceOf(NotFoundError);
    expect(error.message).toBe('This API has no endpoint named "orders"; its endpoints are "users"');
    expect(api.requests).toHaveLength(0);
  });
});

describe('HttpConnector requests', () => {
  it('sends Accept, the user headers and each kind of auth', async () => {
    const api = await stub((_, response) => json(response, []));
    const cases: Array<[Record<string, unknown>, (request: SeenRequest) => void]> = [
      [{ type: 'none' }, (request) => expect(request.headers.authorization).toBeUndefined()],
      [{ type: 'bearer' }, (request) => expect(request.headers.authorization).toBe(`Bearer ${TOKEN}`)],
      [{ type: 'basic', username: 'sync' }, (request) => expect(request.headers.authorization).toBe(`Basic ${Buffer.from(`sync:${TOKEN}`).toString('base64')}`)],
      [{ type: 'apiKeyHeader', header: 'X-API-Key' }, (request) => expect(request.headers['x-api-key']).toBe(TOKEN)],
      [{ type: 'apiKeyQuery', param: 'api_key' }, (request) => expect(request.path).toBe(`/v2/users?api_key=${TOKEN}`)],
    ];
    for (const [auth, check] of cases) {
      const { connector } = connect(
        api.base,
        { query: [{ name: 'api_key', value: 'from-endpoint' }] },
        { auth, secret: auth.type === 'none' ? '' : TOKEN, headers: [{ name: 'X-Tenant', value: 'acme' }] },
      );
      await readAll(connector);
      const request = api.requests.at(-1) as SeenRequest;
      expect(request.headers.accept).toBe('application/json');
      expect(request.headers['x-tenant']).toBe('acme');
      check(request);
    }
  });

  it('keeps the minimum interval between requests', async () => {
    const api = await stub(pagedServer(items(4)));
    const { connector, sleeps } = connect(api.base, { dataPath: 'data', pagination: { type: 'page', size: { param: 'per_page', value: 2 } } }, { minIntervalSeconds: 2 });
    await readAll(connector);
    expect(api.requests).toHaveLength(3);
    expect(sleeps).toEqual([2000, 2000]);
  });

  it('stops waiting for its turn as soon as the run is cancelled', async () => {
    const api = await stub((url, response) => json(response, items(1, Number(url.searchParams.get('page')))));
    const config: HttpConnectorConfig = {
      ...httpConfigSchema.parse({ kind: 'http', baseUrl: api.base, minIntervalSeconds: 60, endpoints: [{ name: 'users', path: '/users', pagination: { type: 'page' } }] }),
      maxResponseBytes: 1024,
    };
    const connector = new HttpConnector(config, { spacer: new RequestSpacer() });
    const controller = new AbortController();
    const batches = connector.readBatches({ collection: 'users', batchSize: 1, signal: controller.signal })[Symbol.asyncIterator]();
    expect((await batches.next()).value).toEqual(items(1));
    const started = Date.now();
    setTimeout(() => controller.abort(), 20);
    const error = await failure(batches.next());
    expect(error.name).toBe('AbortError');
    expect(Date.now() - started).toBeLessThan(1000);
    expect(api.requests).toHaveLength(1);
  });

  it('retries a 429 after its Retry-After seconds', async () => {
    let calls = 0;
    const api = await stub((_, response) => (++calls === 1 ? json(response, {}, 429, { 'retry-after': '2' }) : json(response, items(1))));
    const { connector, sleeps } = connect(api.base);
    expect(await readAll(connector)).toEqual([items(1)]);
    expect(sleeps).toEqual([2000]);
    expect(api.requests).toHaveLength(2);
  });

  it('retries a 429 until its Retry-After date', async () => {
    let calls = 0;
    const api = await stub((_, response) =>
      ++calls === 1 ? json(response, {}, 429, { 'retry-after': new Date(START + 3000).toUTCString() }) : json(response, items(1)),
    );
    const { connector, sleeps } = connect(api.base);
    expect(await readAll(connector)).toEqual([items(1)]);
    expect(sleeps).toEqual([3000]);
  });

  it('retries a 503 with growing waits and gives up after three retries', async () => {
    const api = await stub((_, response) => json(response, {}, 503));
    const { connector, sleeps } = connect(api.base);
    const error = await failure(readAll(connector));
    expect(error).toBeInstanceOf(UpstreamError);
    expect(error.message).toBe(`Endpoint "users": HTTP 503 Service Unavailable from GET ${api.base}/v2/users after ${MAX_RETRIES} retries`);
    expect(sleeps).toEqual([1000, 2000, 4000]);
    expect(api.requests).toHaveLength(MAX_RETRIES + 1);
  });

  it('does not retry other server errors', async () => {
    const api = await stub((_, response) => json(response, {}, 500));
    const { connector } = connect(api.base);
    await expect(readAll(connector)).rejects.toThrow(`Endpoint "users": HTTP 500 Internal Server Error from GET ${api.base}/v2/users`);
    expect(api.requests).toHaveLength(1);
  });

  it('refuses a Retry-After longer than it waits, naming the wait', async () => {
    const api = await stub((_, response) => json(response, {}, 429, { 'retry-after': '600' }));
    const { connector, sleeps } = connect(api.base);
    await expect(readAll(connector)).rejects.toThrow(
      `Endpoint "users": HTTP 429 Too Many Requests from GET ${api.base}/v2/users: the API asks to wait 600 s, longer than the ${MAX_RETRY_WAIT_MS / 1000} s Syncforge waits`,
    );
    expect(sleeps).toEqual([]);
    expect(api.requests).toHaveLength(1);
  });

  it('refuses a response whose Content-Length is over the limit', async () => {
    const api = await stub((_, response) => json(response, items(200)));
    const { connector } = connect(api.base, {}, { maxResponseBytes: 1000 });
    await expect(readAll(connector)).rejects.toThrow(`Endpoint "users": the response from GET ${api.base}/v2/users is larger than 1000 bytes, the response size limit`);
  });

  it('stops downloading a chunked body the moment it is over the limit', async () => {
    let closed = false;
    let written = 0;
    const api = await stub((_, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.write('[');
      const timer = setInterval(() => {
        response.write(`${JSON.stringify({ pad: 'x'.repeat(500) })},`);
        written += 1;
      }, 2);
      response.on('close', () => {
        closed = true;
        clearInterval(timer);
      });
    });
    const { connector } = connect(api.base, {}, { maxResponseBytes: 4096 });
    await expect(readAll(connector)).rejects.toThrow('is larger than');
    for (let waited = 0; !closed && waited < 1000; waited += 10) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(closed).toBe(true);
    expect(written).toBeLessThan(100);
  });

  it('follows a same-origin redirect, keeping auth', async () => {
    const api = await stub((url, response) => {
      if (url.pathname === '/v2/users') {
        response.writeHead(302, { location: '/v3/users' });
        response.end();
      } else json(response, items(2));
    });
    const { connector } = connect(api.base, {}, { auth: { type: 'bearer' }, secret: TOKEN });
    expect((await readAll(connector)).flat()).toEqual(items(2));
    expect(api.requests.map((request) => [request.path, request.headers.authorization])).toEqual([
      ['/v2/users', `Bearer ${TOKEN}`],
      ['/v3/users', `Bearer ${TOKEN}`],
    ]);
  });

  it('refuses a redirect to another origin, so the credentials never reach it', async () => {
    const other = await stub((_, response) => json(response, items(1)));
    const api = await stub((_, response) => {
      response.writeHead(307, { location: `${other.base}/v2/users?token=${TOKEN}` });
      response.end();
    });
    const { connector } = connect(api.base, {}, { auth: { type: 'bearer' }, secret: TOKEN });
    const error = await failure(readAll(connector));
    expect(error.message).toContain(`Endpoint "users": GET ${api.base}/v2/users redirected to another origin (${other.base})`);
    expect(error.message).not.toContain(TOKEN);
    expect(other.requests).toHaveLength(0);
  });

  it('refuses a redirect on the same host to another scheme or port', async () => {
    const otherPort = await freePort();
    let location = '';
    const api = await stub((_, response) => {
      response.writeHead(302, { location });
      response.end();
    });
    for (const target of [`${api.base.replace('http:', 'https:')}/v3/users`, `http://127.0.0.1:${otherPort}/v3/users`]) {
      location = target;
      const { connector } = connect(api.base, {}, { auth: { type: 'bearer' }, secret: TOKEN });
      const before = api.requests.length;
      const error = await failure(readAll(connector));
      expect(error).toBeInstanceOf(ValidationError);
      expect(error.message).toContain(`redirected to another origin (${new URL(target).origin})`);
      expect(api.requests).toHaveLength(before + 1);
    }
  });

  it('stops reading a body as soon as the run is cancelled', async () => {
    let closed = false;
    const api = await stub((_, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      // Half a body, then nothing: the read waits until it is cancelled.
      response.write('[{"id":1},');
      response.on('close', () => {
        closed = true;
      });
    });
    const { connector } = connect(api.base);
    const controller = new AbortController();
    const started = Date.now();
    setTimeout(() => controller.abort(), 50);
    const error = await failure(readAll(connector, { signal: controller.signal }));
    expect(error.name).toBe('AbortError');
    expect(Date.now() - started).toBeLessThan(1000);
    for (let waited = 0; !closed && waited < 1000; waited += 10) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(closed).toBe(true);
  });

  it('refuses a whole number too large to keep exactly instead of rounding it, without quoting it', async () => {
    const bodies = ['[{"id":9007199254740993,"name":"a"},{"id":9007199254740992,"name":"b"}]', '{"data":[{"id":-9007199254740993}]}', '[{"id":9007199254740992}]'];
    const shown = ['9007199254740993', '-9007199254740993', '9007199254740992'];
    for (const [index, body] of bodies.entries()) {
      const api = await stub((_, response) => rawJson(response, body));
      const { connector } = connect(api.base, { dataPath: index === 1 ? 'data' : '$' });
      const error = await failure(readAll(connector));
      expect(error).toBeInstanceOf(UpstreamError);
      expect(error.message).toBe(
        `Endpoint "users": the response from GET ${api.base}/v2/users holds a whole number larger than JavaScript can keep exactly (above 9007199254740991). Ask the API to send such IDs as strings`,
      );
      expect(error.message).not.toContain(shown[index]);
    }
  });

  it('reads large IDs in strings, the largest exact whole number, decimals and exponents', async () => {
    const body = '[{"id":"9007199254740993","note":"say \\"12345678901234567\\"","max":9007199254740991,"min":-9007199254740991,"f":12345678901234567.5,"e":1e300,"big":1.5E20}]';
    const api = await stub((_, response) => rawJson(response, body));
    const { connector } = connect(api.base);
    expect((await readAll(connector)).flat()).toEqual([
      { id: '9007199254740993', note: 'say "12345678901234567"', max: 9007199254740991, min: -9007199254740991, f: 12345678901234567.5, e: 1e300, big: 1.5e20 },
    ]);
  });

  it('refuses a token that cannot be sent in a header before any request, without quoting it', async () => {
    const api = await stub((_, response) => json(response, []));
    const { connector } = connect(api.base, {}, { auth: { type: 'bearer' }, secret: `${TOKEN}\u0000` });
    const error = await failure(readAll(connector));
    expect(error).toBeInstanceOf(ValidationError);
    expect(error.message).toBe('Endpoint "users": the token contains characters that cannot be sent in an HTTP header. Paste it again in the connection settings');
    expect(error.message).not.toContain(TOKEN);
    expect(error.cause).toBeUndefined();
    expect(api.requests).toHaveLength(0);
  });

  it('refuses a header value that cannot be sent, naming the header but not the value', async () => {
    const api = await stub((_, response) => json(response, []));
    // As a hand-edited exported script could hold it: the settings schema would refuse this value.
    const config: HttpConnectorConfig = {
      ...httpConfigSchema.parse({ kind: 'http', baseUrl: api.base, endpoints: [{ name: 'users', path: '/users' }] }),
      headers: [{ name: 'X-Tenant', value: `${CANARY}\u0100` }],
      maxResponseBytes: 1024,
    };
    const connector = new HttpConnector(config, { spacer: new RequestSpacer() });
    const error = await failure(readAll(connector));
    expect(error).toBeInstanceOf(ValidationError);
    expect(error.message).toBe('Endpoint "users": the value of header "X-Tenant" contains characters that cannot be sent in an HTTP header');
    expect(error.cause).toBeUndefined();
    expect(api.requests).toHaveLength(0);
  });

  it('keeps no cookies between requests', async () => {
    const api = await stub((url, response) => json(response, url.searchParams.get('page') === '1' ? items(1) : [], 200, { 'set-cookie': 'session=abc; Path=/' }));
    const { connector } = connect(api.base, { pagination: { type: 'page' } });
    await readAll(connector);
    expect(api.requests).toHaveLength(2);
    expect(api.requests[1].headers.cookie).toBeUndefined();
  });

  it('refuses a body that is not JSON, naming its content type', async () => {
    const api = await stub((_, response) => {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(`<html>${CANARY}</html>`);
    });
    const { connector } = connect(api.base);
    const error = await failure(readAll(connector));
    expect(error.message).toBe(`Endpoint "users": the response from GET ${api.base}/v2/users is not JSON (content-type text/html; charset=utf-8)`);
  });

  it('names the refused host and how to reach the machine from Docker', async () => {
    const port = await freePort();
    const { connector } = connect(`http://localhost:${port}`);
    const error = await failure(readAll(connector));
    expect(error).toBeInstanceOf(UpstreamError);
    expect(error.message).toContain(`Endpoint "users": GET http://localhost:${port}/v2/users failed: connection refused by localhost:${port}`);
    expect(error.message).toContain('use host.docker.internal instead of localhost');
  });

  it('never puts the secret or the response body in an error', async () => {
    const api = await stub((_, response) => json(response, { error: CANARY }, 401));
    const auths: Array<Record<string, unknown>> = [
      { type: 'bearer' },
      { type: 'basic', username: 'sync' },
      { type: 'apiKeyHeader', header: 'X-API-Key' },
      { type: 'apiKeyQuery', param: 'api_key' },
    ];
    for (const auth of auths) {
      const { connector } = connect(api.base, {}, { auth, secret: TOKEN });
      const error = await failure(readAll(connector));
      const query = auth.type === 'apiKeyQuery' ? '?api_key=***' : '';
      expect(error.message).toBe(`Endpoint "users": HTTP 401 Unauthorized from GET ${api.base}/v2/users${query}; check the authentication settings`);
      expect(error.message).not.toContain(TOKEN);
      expect(error.message).not.toContain(Buffer.from(`sync:${TOKEN}`).toString('base64'));
      expect(error.message).not.toContain(CANARY);
    }
  });
});

describe('HttpConnector lookups and schema', () => {
  it('indexes an endpoint once and matches 42 to "42"', async () => {
    const api = await stub(pagedServer([{ id: '41', name: 'a' }, { id: '42', name: 'b' }, { id: '43', name: 'c' }]));
    const { connector } = connect(api.base, { dataPath: 'data', pagination: { type: 'page', size: { param: 'per_page', value: 2 } } });
    expect(await connector.findByKeys('users', ['id'], [{ id: 42 }, { id: 99 }])).toEqual([{ id: '42', name: 'b' }]);
    const requests = api.requests.length;
    expect(await connector.findByKeys('users', ['id'], [{ id: 41 }, { id: 43 }])).toEqual([
      { id: '41', name: 'a' },
      { id: '43', name: 'c' },
    ]);
    expect(api.requests).toHaveLength(requests);
  });

  it('matches keys at nested paths', async () => {
    const api = await stub((_, response) => json(response, [{ meta: { code: 'A' }, n: 1 }, { meta: { code: 'B' }, n: 2 }]));
    const { connector } = connect(api.base);
    expect(await connector.findByKeys('users', ['meta.code'], [{ 'meta.code': 'B' }])).toEqual([{ meta: { code: 'B' }, n: 2 }]);
  });

  it('refuses a lookup whose pages add up to more than the size limit', async () => {
    const api = await stub((url, response) => {
      const page = Number(url.searchParams.get('page'));
      json(response, page <= 3 ? items(10, page * 10) : []);
    });
    const { connector } = connect(api.base, { pagination: { type: 'page' } }, { maxResponseBytes: 600 });
    await expect(connector.findByKeys('users', ['id'], [{ id: 1 }])).rejects.toThrow(
      'Reading endpoint "users" by key holds every page in memory, and its pages add up to more than 600 bytes (the HTTP response size limit in Settings). Narrow the endpoint with query params, or raise the limit in Settings',
    );
  });

  it('refuses a re-run of failed rows over the size limit without calling it a lookup', async () => {
    const api = await stub((url, response) => {
      const page = Number(url.searchParams.get('page'));
      json(response, page <= 3 ? items(10, page * 10) : []);
    });
    const { connector } = connect(api.base, { pagination: { type: 'page' } }, { maxResponseBytes: 600 });
    const retry = new KeyedRowsReader(connector, ['id'], [{ id: 1 }], () => undefined);
    const error = await failure(
      (async () => {
        for await (const batch of retry.readBatches({ collection: 'users', batchSize: 10 })) expect(batch).toBeUndefined();
      })(),
    );
    expect(error).toBeInstanceOf(ValidationError);
    expect(error.message).toMatch(/^Reading endpoint "users" by key holds every page in memory/);
  });

  it('describes the fields of the first page', async () => {
    const api = await stub((_, response) => json(response, { data: [{ id: 1, name: 'a', address: { city: 'X' } }, { id: 2, name: null }] }));
    const { connector } = connect(api.base, { dataPath: 'data' });
    expect(await connector.describeCollection('users')).toEqual([
      { path: 'address', type: 'object', nullable: true, primaryKey: false, presence: 0.5 },
      { path: 'address.city', type: 'string', nullable: true, primaryKey: false, presence: 0.5 },
      { path: 'id', type: 'number', nullable: false, primaryKey: false, presence: 1 },
      { path: 'name', type: 'string', nullable: true, primaryKey: false, presence: 1 },
    ]);
    expect(await connector.listCollections()).toEqual([{ name: 'users', kind: 'endpoint' }]);
  });
});

describe('HttpConnector probe and ping', () => {
  it('shows the arrays found and the next page of a 2xx response', async () => {
    const api = await stub((_, response) => json(response, { data: items(2), meta: { next: 'c1' } }, 200, { 'x-ratelimit-remaining': '99' }));
    const { connector } = connect(api.base, { pagination: { type: 'cursor', cursorPath: 'meta.next', cursorParam: 'after' } });
    const result = await connector.probe('users');
    expect(result).toMatchObject({
      status: 200,
      contentType: 'application/json',
      rateLimit: [{ name: 'x-ratelimit-remaining', value: '99' }],
      arrays: [{ path: 'data', items: 2, keys: ['id', 'name'] }],
      // The data path is still the default `$`, so the next page cannot be planned yet.
      nextPage: null,
    });
    expect(result.bytes).toBeGreaterThan(0);
    const { connector: configured } = connect(api.base, { dataPath: 'data', pagination: { type: 'cursor', cursorPath: 'meta.next', cursorParam: 'after' } });
    expect((await configured.probe('users')).nextPage).toBe(`${api.base}/v2/users?after=c1`);
  });

  it('returns a 429 with its rate-limit headers instead of throwing or retrying', async () => {
    const api = await stub((_, response) => json(response, { error: CANARY }, 429, { 'retry-after': '30', 'ratelimit-remaining': '0' }));
    const { connector, sleeps } = connect(api.base);
    expect(await connector.probe('users')).toMatchObject({
      status: 429,
      // fetch lists headers sorted by name.
      rateLimit: [
        { name: 'ratelimit-remaining', value: '0' },
        { name: 'retry-after', value: '30' },
      ],
      arrays: [],
      nextPage: null,
    });
    expect(sleeps).toEqual([]);
    expect(api.requests).toHaveLength(1);
  });

  it('pings with one request and no retry', async () => {
    const api = await stub((_, response) => json(response, {}, 429, { 'retry-after': '1' }));
    const { connector } = connect(api.base);
    await expect(connector.ping()).rejects.toThrow(`Endpoint "users": HTTP 429 Too Many Requests from GET ${api.base}/v2/users`);
    expect(api.requests).toHaveLength(1);
  });

  it('explains reads and key lookups with auth masked', async () => {
    const { connector } = connect('http://127.0.0.1:1', {}, { auth: { type: 'bearer' }, secret: TOKEN });
    expect(connector.explainRead({ collection: 'users', batchSize: 10, limit: 5 })).toContain('Authorization: Bearer ***');
    expect(connector.explainFindByKeys('users', ['id'], [{ id: 1 }])).toContain('index the items by id');
    expect(connector.explainRead({ collection: 'users', batchSize: 10 })).not.toContain(TOKEN);
  });
});
