import { IncomingMessage, Server, ServerResponse, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { MongoClient } from 'mongodb';
import { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ConnectionView, ConnectorConfig, MongoConfig, PostgresConfig, connectorConfigSchema } from '../../src/connections/connection.model';
import { ConnectionsService } from '../../src/connections/connections.service';
import { ConnectorFactory } from '../../src/connectors/connector.factory';
import { Job } from '../../src/jobs/job.model';
import { SyncRunner } from '../../src/sync/sync-runner';
import { SyncService } from '../../src/sync/sync.service';
import { TransformRegistry } from '../../src/transforms/transform.registry';
import { Started, startMongo, startPostgres } from './containers';
import { runsHarness } from './runs-harness';

/**
 * An HTTP API as a source and as a lookup, written into real Postgres and MongoDB. The API is an in-process stub
 * on 127.0.0.1 that demands a bearer token on every request. JSON keeps its types: numbers, booleans, nested
 * objects and arrays arrive as such. Synthetic data only.
 */

const TOKEN = 'it-bearer-token-42'; // secret-scan: allow
/** Items per page the stub serves, whatever size is asked for: a short page must not end a read. */
const SERVER_PAGE_CAP = 2;

const ORDERS = [
  { id: 1, total: 12.5, paid: true, customer: { id: 10 }, shipping: { city: 'Athens' }, tags: ['new'], placedAt: '2025-03-01T10:00:00Z', note: 'first' },
  { id: 2, total: 7.25, paid: false, customer: { id: 20 }, shipping: { city: 'Lyon' }, tags: [], placedAt: '2025-03-02T11:30:00Z', note: 'second' },
  { id: 3, total: 100, paid: true, customer: { id: 10 }, shipping: { city: 'Porto' }, tags: ['vip', 'gift'], placedAt: '2025-03-03T00:00:00Z', note: null },
  { id: 4, total: 0.99, paid: false, customer: { id: 20 }, shipping: { city: 'Turin' }, tags: ['new'], placedAt: '2025-03-04T23:59:59Z', note: 'fourth' },
  { id: 5, total: 42, paid: true, customer: { id: 10 }, shipping: { city: 'Ghent' }, tags: [], placedAt: '2025-03-05T08:00:00Z', note: 'fifth' },
];
const CUSTOMERS = [
  { id: 10, name: 'Ada Example', tier: 'gold' },
  { id: 20, name: 'Bo Example', tier: 'silver' },
];

interface SeenRequest {
  path: string;
  authorization: string | undefined;
  at: number;
}

let server: Server;
let base: string;
const seen: SeenRequest[] = [];
let throttledOnce = false;

let postgres: Started<PostgresConfig>;
let mongo: Started<MongoConfig>;
let configs: Record<string, ConnectorConfig>;
let pg: Pool;
let mongoClient: MongoClient;
let sync: SyncService;

function json(response: ServerResponse, body: unknown, status = 200, headers: Record<string, string> = {}): void {
  response.writeHead(status, { 'content-type': 'application/json', ...headers });
  response.end(JSON.stringify(body));
}

/** The stub API: `/v1/orders` by cursor, `/v1/orders-paged` by page number, `/v1/customers` throttled once. */
function handle(request: IncomingMessage, response: ServerResponse): void {
  const url = new URL(request.url ?? '/', 'http://stub');
  seen.push({ path: `${url.pathname}${url.search}`, authorization: request.headers.authorization, at: Date.now() });
  if (request.headers.authorization !== `Bearer ${TOKEN}`) return json(response, { error: 'unauthorized' }, 401);

  if (url.pathname === '/v1/orders') {
    const start = Number(url.searchParams.get('cursor') ?? '0');
    const end = start + SERVER_PAGE_CAP;
    return json(response, { data: ORDERS.slice(start, end), meta: { next: end < ORDERS.length ? String(end) : null } });
  }
  if (url.pathname === '/v1/orders-paged') {
    const page = Number(url.searchParams.get('page'));
    // Caps per_page like many real APIs do, so every page is shorter than asked for.
    const size = Math.min(Number(url.searchParams.get('per_page')), SERVER_PAGE_CAP);
    return json(response, { data: ORDERS.slice((page - 1) * size, page * size) });
  }
  if (url.pathname === '/v1/customers') {
    if (!throttledOnce) {
      throttledOnce = true;
      return json(response, { error: 'slow down' }, 429, { 'retry-after': '1' });
    }
    return json(response, { customers: CUSTOMERS });
  }
  json(response, { error: 'not found' }, 404);
}

function httpConfig(minIntervalSeconds = 0): ConnectorConfig {
  return connectorConfigSchema.parse({
    kind: 'http',
    baseUrl: `${base}/v1`,
    auth: { type: 'bearer' },
    secret: TOKEN,
    minIntervalSeconds,
    endpoints: [
      { name: 'orders', path: '/orders', dataPath: 'data', pagination: { type: 'cursor', cursorPath: 'meta.next', cursorParam: 'cursor' } },
      { name: 'orders-paged', path: '/orders-paged', dataPath: 'data', pagination: { type: 'page', size: { param: 'per_page', value: 50 } } },
      { name: 'customers', path: '/customers', dataPath: 'customers' },
    ],
  });
}

function connectionsStub(): ConnectionsService {
  const factory = new ConnectorFactory();
  const stub = {
    async open(id: string) {
      const config = configs[id];
      const view: ConnectionView = { id, name: id, kind: config.kind, summary: id, settings: {}, hasSecret: true, createdAt: '', updatedAt: '' };
      return { connector: factory.create(config), view };
    },
  };
  return stub as unknown as ConnectionsService;
}

async function run(job: Job) {
  return sync.withPipeline(job, ({ source, target, mapper, enricher }) =>
    new SyncRunner().run({
      job,
      source,
      target,
      mapper,
      enricher,
      from: null,
      signal: new AbortController().signal,
      hooks: { log: () => undefined, onBatchWritten: async () => undefined, onRowFailed: () => undefined },
    }),
  );
}

function makeJob(job: Pick<Job, 'source' | 'target' | 'mappings'> & Partial<Job>): Job {
  return { id: 'job', name: 'job', createdAt: '', updatedAt: '', batchSize: 2, errorPolicy: 'fail', mode: 'full', ...job };
}

function map(from: string, to = from): Job['mappings'][number] {
  return { from, to, transform: 'none' };
}

beforeAll(async () => {
  server = createServer(handle);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  [postgres, mongo] = await Promise.all([startPostgres(), startMongo()]);
  configs = { api: httpConfig(), spaced: httpConfig(0.25), pg: postgres.config, mongo: { ...mongo.config, database: 'httptarget' } };
  const { host, port, database, user, password } = postgres.config;
  pg = new Pool({ host, port, database, user, password, max: 2 });
  mongoClient = await MongoClient.connect(mongo.config.uri);
  sync = new SyncService(connectionsStub(), new TransformRegistry());
});

afterAll(async () => {
  await Promise.allSettled([pg?.end(), mongoClient?.close()]);
  await Promise.allSettled([postgres?.stop(), mongo?.stop()]);
  server?.closeAllConnections();
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
});

beforeEach(() => {
  seen.length = 0;
});

afterEach(() => {
  // No request of any test went out without the token.
  expect(seen.length).toBeGreaterThan(0);
  expect(seen.filter((request) => request.authorization !== `Bearer ${TOKEN}`)).toEqual([]);
});

describe('HTTP API to PostgreSQL with typed columns', () => {
  const job = makeJob({
    source: { connectionId: 'api', collection: 'orders' },
    target: { connectionId: 'pg', collection: 'public.orders', keyFields: ['id'] },
    mappings: [map('id'), map('total'), map('paid'), map('customer.id', 'customer_id'), map('shipping.city', 'city'), map('placedAt', 'placed_at'), map('shipping')],
  });

  beforeAll(async () => {
    await pg.query('CREATE TABLE public.orders (id int PRIMARY KEY, total numeric, paid boolean, customer_id int, city text, placed_at timestamptz, shipping jsonb)');
  });

  it('follows the cursor through every page and writes JSON numbers, booleans and nested paths into typed columns', async () => {
    const { stats } = await run(job);
    expect(stats).toMatchObject({ read: 5, written: 5, skipped: 0 });
    expect(seen.map((request) => request.path)).toEqual(['/v1/orders', '/v1/orders?cursor=2', '/v1/orders?cursor=4']);

    const { rows } = await pg.query('SELECT * FROM public.orders ORDER BY id LIMIT 3');
    expect(rows).toEqual([
      { id: 1, total: '12.5', paid: true, customer_id: 10, city: 'Athens', placed_at: new Date('2025-03-01T10:00:00Z'), shipping: { city: 'Athens' } },
      { id: 2, total: '7.25', paid: false, customer_id: 20, city: 'Lyon', placed_at: new Date('2025-03-02T11:30:00Z'), shipping: { city: 'Lyon' } },
      { id: 3, total: '100', paid: true, customer_id: 10, city: 'Porto', placed_at: new Date('2025-03-03T00:00:00Z'), shipping: { city: 'Porto' } },
    ]);
  });

  it('reconciles clean', async () => {
    const report = await sync.reconcile(job);
    expect(report).toMatchObject({ sourceCount: 5, targetCount: 5, sampled: 5, matched: 5, missingCount: 0, mismatchedRows: 0 });
  });

  it('is idempotent', async () => {
    const { stats } = await run(job);
    expect(stats).toMatchObject({ read: 5, written: 5, skipped: 0 });
    const { rows } = await pg.query('SELECT count(*)::int AS n FROM public.orders');
    expect(rows[0].n).toBe(5);
  });
});

describe('HTTP API with page numbers and a server that caps the page size', () => {
  const job = makeJob({
    source: { connectionId: 'api', collection: 'orders-paged' },
    target: { connectionId: 'pg', collection: 'public.paged_orders', keyFields: ['id'] },
    mappings: [map('id'), map('total')],
  });

  beforeAll(async () => {
    await pg.query('CREATE TABLE public.paged_orders (id int PRIMARY KEY, total numeric)');
  });

  it('keeps going past pages shorter than asked for and stops only at the empty page', async () => {
    const { stats } = await run(job);
    expect(stats).toMatchObject({ read: 5, written: 5, skipped: 0 });
    expect(seen.map((request) => request.path)).toEqual([1, 2, 3, 4].map((page) => `/v1/orders-paged?page=${page}&per_page=50`));
  });
});

describe('HTTP API to MongoDB', () => {
  const job = makeJob({
    source: { connectionId: 'api', collection: 'orders' },
    target: { connectionId: 'mongo', collection: 'orders', keyFields: ['orderId'] },
    mappings: [map('id', 'orderId'), map('total'), map('paid'), map('customer'), map('shipping.city', 'city'), map('tags'), map('note')],
  });

  it('keeps JSON types without transforms: numbers, booleans, objects, arrays and null', async () => {
    const { stats } = await run(job);
    expect(stats).toMatchObject({ read: 5, written: 5, skipped: 0 });

    const orders = mongoClient.db('httptarget').collection('orders');
    expect(await orders.findOne({ orderId: 3 }, { projection: { _id: 0 } })).toEqual({
      orderId: 3,
      total: 100,
      paid: true,
      customer: { id: 10 },
      city: 'Porto',
      tags: ['vip', 'gift'],
      note: null,
    });
    expect(
      await orders.countDocuments({ orderId: { $type: 'number' }, total: { $type: 'number' }, paid: { $type: 'bool' }, customer: { $type: 'object' }, tags: { $type: 'array' } }),
    ).toBe(5);
  });

  it('reconciles clean', async () => {
    const report = await sync.reconcile(job);
    expect(report).toMatchObject({ sourceCount: 5, targetCount: 5, matched: 5, missingCount: 0, mismatchedRows: 0 });
  });
});

describe('HTTP API endpoint as a lookup', () => {
  const job = makeJob({
    source: { connectionId: 'api', collection: 'orders' },
    lookups: [{ as: 'buyer', connectionId: 'api', collection: 'customers', on: [{ source: 'customer.id', lookup: 'id' }], required: true }],
    target: { connectionId: 'pg', collection: 'public.enriched_orders', keyFields: ['id'] },
    mappings: [map('id'), map('buyer.name', 'buyer_name'), map('buyer.tier', 'tier')],
  });

  beforeAll(async () => {
    await pg.query('CREATE TABLE public.enriched_orders (id int PRIMARY KEY, buyer_name text NOT NULL, tier text)');
  });

  it('enriches each order from another endpoint of the same API, fetched once, waiting out a 429 Retry-After', async () => {
    const { stats } = await run(job);
    expect(stats).toMatchObject({ read: 5, written: 5, skipped: 0 });
    // The first customers request was throttled, then retried once; the index then serves every batch.
    expect(seen.filter((request) => request.path === '/v1/customers')).toHaveLength(2);
    const [throttled, retried] = seen.filter((request) => request.path === '/v1/customers');
    expect(retried.at - throttled.at).toBeGreaterThanOrEqual(950);

    const { rows } = await pg.query('SELECT id, buyer_name, tier FROM public.enriched_orders ORDER BY id LIMIT 2');
    expect(rows).toEqual([
      { id: 1, buyer_name: 'Ada Example', tier: 'gold' },
      { id: 2, buyer_name: 'Bo Example', tier: 'silver' },
    ]);
  });

  it('reconciles with the lookup applied', async () => {
    const report = await sync.reconcile(job);
    expect(report).toMatchObject({ sourceCount: 5, targetCount: 5, matched: 5, missingCount: 0, mismatchedRows: 0, unmappable: 0 });
  });
});

describe('HTTP API source: re-running failed rows', () => {
  const job = makeJob({
    errorPolicy: 'skip',
    source: { connectionId: 'api', collection: 'orders' },
    target: { connectionId: 'pg', collection: 'public.strict_orders', keyFields: ['id'] },
    mappings: [map('id'), map('note')],
  });

  beforeAll(async () => {
    // Order 3 has a null note, which this table refuses.
    await pg.query('CREATE TABLE public.strict_orders (id int PRIMARY KEY, note text NOT NULL)');
  });

  it('fetches the failed row from the API by its key and writes it once the job is fixed', async () => {
    const { current, runToEnd } = runsHarness(sync, job);
    const first = await runToEnd();
    expect(first.stats).toMatchObject({ read: 5, written: 4, skipped: 1 });
    expect(first.failures?.map((failure) => failure.sourceKey)).toEqual([{ id: 3 }]);

    current.job = { ...job, mappings: [job.mappings[0], { from: 'note', to: 'note', transform: 'default', argument: '-' }] };
    const retry = await runToEnd({ retryOf: first.id });

    expect(retry).toMatchObject({ status: 'succeeded', stats: { read: 1, written: 1, skipped: 0 }, failures: [] });
    const { rows } = await pg.query('SELECT note FROM public.strict_orders WHERE id = 3');
    expect(rows).toEqual([{ note: '-' }]);
  });
});

describe('HTTP API with seconds between requests', () => {
  const job = makeJob({
    source: { connectionId: 'spaced', collection: 'orders' },
    target: { connectionId: 'pg', collection: 'public.spaced_orders', keyFields: ['id'] },
    mappings: [map('id')],
  });

  beforeAll(async () => {
    await pg.query('CREATE TABLE public.spaced_orders (id int PRIMARY KEY)');
  });

  it('keeps each request at least the set interval after the previous one', async () => {
    const { stats } = await run(job);
    expect(stats).toMatchObject({ read: 5, written: 5 });
    expect(seen).toHaveLength(3);
    const gaps = seen.slice(1).map((request, index) => request.at - seen[index].at);
    // A few milliseconds of slack for timer granularity; the spacer starts each turn 250 ms after the last.
    for (const gap of gaps) expect(gap).toBeGreaterThanOrEqual(240);
  });
});
