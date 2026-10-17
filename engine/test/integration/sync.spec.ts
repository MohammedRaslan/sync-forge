import { MongoClient } from 'mongodb';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ConnectorConfig, ConnectionView, MongoConfig, MysqlConfig, PostgresConfig } from '../../src/connections/connection.model';
import { ConnectionsService } from '../../src/connections/connections.service';
import { ConnectorFactory } from '../../src/connectors/connector.factory';
import { Job } from '../../src/jobs/job.model';
import { Row } from '../../src/connectors/connector.types';
import { RowFailure, SyncRunner } from '../../src/sync/sync-runner';
import { SyncService } from '../../src/sync/sync.service';
import { DryRunWriter } from '../../src/sync/dry-run-writer';
import { StoredWatermark } from '../../src/sync/watermark';
import { TransformRegistry } from '../../src/transforms/transform.registry';
import { Started, startMongo, startMysql, startPostgres } from './containers';
import { runsHarness } from './runs-harness';

/**
 * Whole jobs on the sandbox seed data: SyncService opens the pipeline, SyncRunner moves the rows,
 * reconciliation checks the result. Connections come from a stub instead of the encrypted store.
 */

let postgres: Started<PostgresConfig>;
let mongo: Started<MongoConfig>;
let mysql: Started<MysqlConfig>;
let configs: Record<string, ConnectorConfig>;
let legacy: Pool;
let newcore: Pool;
let mongoClient: MongoClient;
let sync: SyncService;

function connectionsStub(): ConnectionsService {
  const factory = new ConnectorFactory();
  const stub = {
    async open(id: string) {
      const config = configs[id];
      const view: ConnectionView = {
        id,
        name: id,
        kind: config.kind,
        summary: id,
        settings: {},
        hasSecret: true,
        createdAt: '',
        updatedAt: '',
      };
      return { connector: factory.create(config), view };
    },
  };
  return stub as unknown as ConnectionsService;
}

function pool(config: PostgresConfig): Pool {
  const { host, port, database, user, password } = config;
  return new Pool({ host, port, database, user, password, max: 2 });
}

async function run(job: Job, from: StoredWatermark | null = null) {
  return sync.withPipeline(job, ({ source, target, mapper, enricher }) =>
    new SyncRunner().run({
      job,
      source,
      target,
      mapper,
      enricher,
      from,
      signal: new AbortController().signal,
      hooks: { log: () => undefined, onBatchWritten: async () => undefined, onRowFailed: () => undefined },
    }),
  );
}

function makeJob(job: Omit<Job, 'id' | 'name' | 'createdAt' | 'updatedAt' | 'batchSize' | 'errorPolicy' | 'mode'> & Partial<Job>): Job {
  return { id: 'job', name: 'job', createdAt: '', updatedAt: '', batchSize: 100, errorPolicy: 'fail', mode: 'full', ...job };
}

beforeAll(async () => {
  [postgres, mongo, mysql] = await Promise.all([startPostgres({ sandbox: true }), startMongo({ sandbox: true }), startMysql({ sandbox: true })]);
  configs = {
    legacy: { ...postgres.config, database: 'legacy' },
    newcore: { ...postgres.config, database: 'newcore' },
    crm: { ...mongo.config, database: 'crm' },
    mongoTarget: { ...mongo.config, database: 'target' },
    shop: mysql.config,
  };
  legacy = pool(configs.legacy as PostgresConfig);
  newcore = pool(configs.newcore as PostgresConfig);
  mongoClient = await MongoClient.connect(mongo.config.uri);
  sync = new SyncService(connectionsStub(), new TransformRegistry());
});

afterAll(async () => {
  await Promise.allSettled([legacy?.end(), newcore?.end(), mongoClient?.close()]);
  await Promise.allSettled([postgres?.stop(), mongo?.stop(), mysql?.stop()]);
});

describe('MongoDB to PostgreSQL (README demo job)', () => {
  const job = makeJob({
    source: { connectionId: 'crm', collection: 'customers' },
    target: { connectionId: 'newcore', collection: 'public.customers', keyFields: ['id'] },
    mappings: [
      { from: 'customerRef', to: 'id', transform: 'none' },
      { from: 'email', to: 'email', transform: 'expression', argument: 'value.trim().toLowerCase()' },
      { to: 'full_name', transform: 'expression', argument: "row.name.first + ' ' + row.name.last" },
      { from: 'address.city', to: 'city', transform: 'none' },
      { from: 'active', to: 'is_active', transform: 'boolean' },
      { from: 'createdAt', to: 'signed_up', transform: 'none' },
    ],
  });

  it('copies every customer with the mapped values', async () => {
    const { stats } = await run(job);
    expect(stats).toMatchObject({ read: 40, written: 40, skipped: 0 });

    const { rows } = await newcore.query("SELECT * FROM public.customers WHERE id = 'CUS-0007'");
    expect(rows[0]).toMatchObject({
      email: 'customer7@example.com',
      full_name: 'First7 Last7',
      city: 'Berlin',
      is_active: false,
    });
    expect(rows[0].signed_up).toEqual(new Date(Date.UTC(2024, 7, 8)));
  });

  it('previews the exact write statement for the first mapped rows', async () => {
    const preview = await sync.preview(job);
    expect(preview.writeStatement).toBe(
      [
        'BEGIN;',
        'INSERT INTO "public"."customers" ("id", "email", "full_name", "city", "is_active", "signed_up") VALUES ' +
          "('CUS-0001', 'customer1@example.com', 'First1 Last1', 'Cologne', TRUE, '2024-02-02T00:00:00.000Z'), " +
          "('CUS-0002', 'customer2@example.com', 'First2 Last2', 'Berlin', TRUE, '2024-03-03T00:00:00.000Z'), " +
          "('CUS-0003', 'customer3@example.com', 'First3 Last3', 'Alexandria', TRUE, '2024-04-04T00:00:00.000Z') " +
          'ON CONFLICT ("id") DO UPDATE SET "email" = EXCLUDED."email", "full_name" = EXCLUDED."full_name", ' +
          '"city" = EXCLUDED."city", "is_active" = EXCLUDED."is_active", "signed_up" = EXCLUDED."signed_up";',
        'COMMIT;',
      ].join('\n'),
    );
  });

  it('is idempotent', async () => {
    await run(job);
    const { rows } = await newcore.query('SELECT count(*)::int AS n FROM public.customers');
    expect(rows[0].n).toBe(40);
  });

  it('reconciles clean, then detects a tampered value and a deleted row', async () => {
    const clean = await sync.reconcile(job);
    expect(clean).toMatchObject({ sourceCount: 40, targetCount: 40, sampled: 40, matched: 40, missingCount: 0, mismatchedRows: 0 });

    await newcore.query("UPDATE public.customers SET city = 'Atlantis' WHERE id = 'CUS-0003'");
    await newcore.query("DELETE FROM public.customers WHERE id = 'CUS-0004'");

    const report = await sync.reconcile(job);
    expect(report).toMatchObject({ targetCount: 39, matched: 38, missingCount: 1, missingKeys: ['CUS-0004'], mismatchedRows: 1 });
    expect(report.mismatches).toEqual([{ key: 'CUS-0003', field: 'city', expected: 'Alexandria', actual: 'Atlantis' }]);
  });

  it('dry-runs the job: reports what would change and writes nothing', async () => {
    let dryRun: DryRunWriter | undefined;
    const { stats } = await sync.withPipeline(job, ({ source, target, mapper, enricher }) =>
      new SyncRunner().run({
        job,
        source,
        target: (dryRun = new DryRunWriter(target)),
        mapper,
        enricher,
        from: null,
        signal: new AbortController().signal,
        hooks: { log: () => undefined, onBatchWritten: async () => undefined, onRowFailed: () => undefined },
      }),
    );

    expect(stats).toMatchObject({ read: 40, skipped: 0 });
    expect(dryRun!.report).toMatchObject({ inserts: 1, updates: 1, unchanged: 38, newKeys: ['CUS-0004'] });
    expect(dryRun!.report.changes).toEqual([{ key: 'CUS-0003', field: 'city', current: 'Atlantis', next: 'Alexandria' }]);
    const { rows } = await newcore.query('SELECT count(*)::int AS n FROM public.customers');
    expect(rows[0].n).toBe(39);
  });
});

describe('PostgreSQL to MongoDB, incremental', () => {
  const job = makeJob({
    mode: 'incremental',
    watermarkField: 'updated_at',
    batchSize: 250,
    source: { connectionId: 'legacy', collection: 'public.orders' },
    target: { connectionId: 'mongoTarget', collection: 'orders', keyFields: ['orderNo'] },
    mappings: [
      { from: 'order_no', to: 'orderNo', transform: 'number' },
      { from: 'total_cents', to: 'amount', transform: 'expression', argument: 'value / 100' },
      { from: 'status', to: 'status', transform: 'trim' },
      { from: 'meta.channel', to: 'channel', transform: 'none' },
      { from: 'updated_at', to: 'sourceUpdatedAt', transform: 'none' },
    ],
  });

  it('reads only changed rows on the second run', async () => {
    const first = await run(job);
    expect(first.stats.read).toBe(1200);
    expect(first.watermark).toEqual({ type: 'date', value: '2025-02-20T00:00:00.000Z', utc: true });

    await legacy.query("UPDATE public.orders SET status = 'REFUNDED', updated_at = now() WHERE order_no IN (5, 6, 7)");

    const second = await run(job, first.watermark);
    // The three changed rows, plus the boundary row re-read because the watermark is inclusive.
    expect(second.stats.read).toBe(4);

    const orders = mongoClient.db('target').collection('orders');
    expect(await orders.countDocuments()).toBe(1200);
    expect(await orders.findOne({ orderNo: 6 })).toMatchObject({ status: 'REFUNDED', channel: 'web', amount: 48.86 });
  });

  it('upgrades a watermark saved by an older engine once, even when no row is newer', async () => {
    const runFrom = async (from: StoredWatermark) => {
      const checkpoints: Array<StoredWatermark | null> = [];
      const logs: string[] = [];
      const result = await sync.withPipeline(job, ({ source, target, mapper, enricher }) =>
        new SyncRunner().run({
          job,
          source,
          target,
          mapper,
          enricher,
          from,
          signal: new AbortController().signal,
          hooks: {
            log: (_level, message) => logs.push(message),
            onBatchWritten: async (_stats, checkpoint) => void checkpoints.push(checkpoint),
            onRowFailed: () => undefined,
          },
        }),
      );
      return { ...result, checkpoints, logs };
    };
    const { rows } = await legacy.query('SELECT max(updated_at) AS latest FROM public.orders');
    const latest = (rows[0].latest as Date).getTime();
    const hour = 60 * 60 * 1000;

    const upgraded = await runFrom({ type: 'date', value: new Date(latest + 20 * hour).toISOString() });
    const movedBack: StoredWatermark = { type: 'date', value: new Date(latest + 6 * hour).toISOString(), utc: true };
    expect(upgraded.stats.read).toBe(0);
    expect(upgraded.checkpoints).toEqual([movedBack]);
    expect(upgraded.logs.some((line) => line.includes('starting 14 h earlier'))).toBe(true);

    const next = await runFrom(movedBack);
    expect(next.stats.read).toBe(0);
    expect(next.checkpoints).toEqual([]);
    expect(next.watermark).toEqual(movedBack);
  });

  it('reconciles clean across representations (bigint keys, Dates)', async () => {
    const report = await sync.reconcile(job);
    expect(report).toMatchObject({ sourceCount: 1200, targetCount: 1200, sampled: 200, matched: 200, missingCount: 0 });
  });
});

describe('PostgreSQL orders joined with MongoDB customers (lookup)', () => {
  const customerLookup = {
    as: 'customer',
    connectionId: 'crm',
    collection: 'customers',
    on: [{ source: 'customer_ref', lookup: 'customerRef' }],
    required: true,
  };
  const job = makeJob({
    batchSize: 300,
    source: { connectionId: 'legacy', collection: 'public.orders' },
    lookups: [customerLookup],
    target: { connectionId: 'mongoTarget', collection: 'orders_enriched', keyFields: ['orderNo'] },
    mappings: [
      { from: 'order_no', to: 'orderNo', transform: 'number' },
      { to: 'customerEmail', transform: 'expression', argument: 'row.customer.email.trim().toLowerCase()' },
      { from: 'customer.address.city', to: 'city', transform: 'none' },
      { from: 'customer.name.last', to: 'lastName', transform: 'none' },
    ],
  });

  it('enriches every order with fields from its customer in another database', async () => {
    const { stats } = await run(job);
    expect(stats).toMatchObject({ read: 1200, written: 1200, skipped: 0, batches: 4 });

    // Order 6 belongs to CUS-0007.
    const order = await mongoClient.db('target').collection('orders_enriched').findOne({ orderNo: 6 });
    expect(order).toMatchObject({ customerEmail: 'customer7@example.com', city: 'Berlin', lastName: 'Last7' });
  });

  it('reconciles with the lookups applied', async () => {
    const report = await sync.reconcile(job);
    expect(report).toMatchObject({ sampled: 200, matched: 200, missingCount: 0, mismatchedRows: 0, unmappable: 0 });
  });

  it('handles a missing required match according to the error policy', async () => {
    const withOrphan = makeJob({
      ...job,
      errorPolicy: 'skip',
      target: { ...job.target, collection: 'orders_orphans' },
      source: {
        connectionId: 'legacy',
        collection: 'orders_with_orphan',
        query: "SELECT order_no, customer_ref FROM public.orders WHERE order_no <= 3 UNION ALL SELECT 9999, 'CUS-9999'",
      },
    });
    const { stats } = await run(withOrphan);
    expect(stats).toMatchObject({ read: 4, written: 3, skipped: 1 });

    // Optional: the orphan maps with empty customer fields (an expression reading row.customer.email would fail instead).
    const optional = {
      ...withOrphan,
      lookups: [{ ...customerLookup, required: false }],
      mappings: withOrphan.mappings.filter((mapping) => mapping.to !== 'customerEmail'),
    };
    const preview = await sync.preview(optional);
    expect(preview.rows.at(-1)?.target).toEqual({ orderNo: 9999, city: null, lastName: null });
  });
});

describe('PostgreSQL custom SQL source', () => {
  const job = makeJob({
    mode: 'incremental',
    watermarkField: 'updated_at',
    source: {
      connectionId: 'legacy',
      collection: 'customer_order_totals',
      query: `SELECT customer_ref, count(*)::int AS order_count, sum(total_cents) AS total_cents, max(updated_at) AS updated_at
                FROM public.orders GROUP BY customer_ref`,
    },
    lookups: [
      { as: 'customer', connectionId: 'crm', collection: 'customers', on: [{ source: 'customer_ref', lookup: 'customerRef' }], required: false },
    ],
    target: { connectionId: 'mongoTarget', collection: 'customer_totals', keyFields: ['customerRef'] },
    mappings: [
      { from: 'customer_ref', to: 'customerRef', transform: 'none' },
      { from: 'order_count', to: 'orderCount', transform: 'none' },
      { from: 'total_cents', to: 'totalCents', transform: 'number' },
      { from: 'customer.address.city', to: 'city', transform: 'none' },
      { from: 'updated_at', to: 'lastOrderAt', transform: 'none' },
    ],
  });

  it('syncs an aggregate query incrementally and reconciles it', async () => {
    const first = await run(job);
    expect(first.stats).toMatchObject({ read: 40, written: 40 });
    const totals = mongoClient.db('target').collection('customer_totals');
    expect(await totals.findOne({ customerRef: 'CUS-0001' })).toMatchObject({ orderCount: 30, city: 'Cologne' });

    const second = await run(job, first.watermark);
    // Only the groups at the latest watermark value: orders 5, 6 and 7 were updated together above.
    expect(second.stats.read).toBe(3);

    const report = await sync.reconcile(job);
    expect(report).toMatchObject({ sourceCount: 40, targetCount: 40, matched: 40, missingCount: 0 });
  });

  it('is rejected for sources that are not PostgreSQL', async () => {
    const mongoQuery = makeJob({ ...job, source: { connectionId: 'crm', collection: 'customers', query: 'SELECT 1' } });
    await expect(sync.preview(mongoQuery)).rejects.toThrow('Custom SQL queries are only supported for PostgreSQL and MySQL sources');
  });
});

describe('Row failures with the skip policy (PostgreSQL target)', () => {
  const failures: RowFailure[] = [];
  const runCollecting = (job: Job) =>
    sync.withPipeline(job, ({ source, target, mapper, enricher }) =>
      new SyncRunner().run({
        job,
        source,
        target,
        mapper,
        enricher,
        from: null,
        signal: new AbortController().signal,
        hooks: { log: () => undefined, onBatchWritten: async () => undefined, onRowFailed: (failure) => failures.push(failure) },
      }),
    );

  beforeAll(async () => {
    await newcore.query('CREATE TABLE public.people (id int PRIMARY KEY, email text UNIQUE)');
    await newcore.query('CREATE TABLE public.staff (id int PRIMARY KEY, manager_id int REFERENCES public.staff (id))');
  });

  it('writes every other row of a batch and lists the row that breaks a unique constraint', async () => {
    failures.length = 0;
    const job = makeJob({
      errorPolicy: 'skip',
      batchSize: 4,
      source: {
        connectionId: 'legacy',
        collection: 'people',
        // Person 7 reuses person 3's email.
        query: "SELECT n AS id, 'p' || CASE WHEN n = 7 THEN 3 ELSE n END || '@x.io' AS email FROM generate_series(1, 10) AS n",
      },
      target: { connectionId: 'newcore', collection: 'public.people', keyFields: ['id'] },
      mappings: [
        { from: 'id', to: 'id', transform: 'none' },
        { from: 'email', to: 'email', transform: 'none' },
      ],
    });

    const { stats } = await runCollecting(job);

    expect(stats).toMatchObject({ read: 10, written: 9, skipped: 1 });
    expect(failures).toEqual([
      {
        row: 7,
        key: '7',
        stage: 'write',
        reason: expect.stringContaining('duplicate key value violates unique constraint "people_email_key"'),
        values: { id: 7, email: 'p3@x.io' },
      },
    ]);
    const { rows } = await newcore.query('SELECT count(*)::int AS n FROM public.people');
    expect(rows[0].n).toBe(9);
  });

  it('writes a row on the retry once the row it references has arrived', async () => {
    failures.length = 0;
    const job = makeJob({
      errorPolicy: 'skip',
      batchSize: 4,
      source: {
        connectionId: 'legacy',
        collection: 'staff',
        // Employee 2 reports to employee 9, who is only read in the third batch.
        query: 'SELECT n AS id, CASE WHEN n = 2 THEN 9 WHEN n > 1 THEN 1 END AS manager_id FROM generate_series(1, 10) AS n',
      },
      target: { connectionId: 'newcore', collection: 'public.staff', keyFields: ['id'] },
      mappings: [
        { from: 'id', to: 'id', transform: 'none' },
        { from: 'manager_id', to: 'manager_id', transform: 'none' },
      ],
    });

    const { stats } = await runCollecting(job);

    expect(stats).toMatchObject({ read: 10, written: 10, skipped: 0 });
    expect(failures).toEqual([]);
    const { rows } = await newcore.query('SELECT manager_id FROM public.staff WHERE id = 2');
    expect(rows[0].manager_id).toBe(9);
  });
});

describe('Re-running the failed rows of a run (PostgreSQL to PostgreSQL)', () => {
  const job = makeJob({
    mode: 'incremental',
    watermarkField: 'updated_at',
    errorPolicy: 'skip',
    batchSize: 4,
    source: { connectionId: 'legacy', collection: 'public.retry_people' },
    target: { connectionId: 'newcore', collection: 'public.retry_people', keyFields: ['id'] },
    mappings: [
      { from: 'person_id', to: 'id', transform: 'none' },
      { from: 'name', to: 'name', transform: 'none' },
    ],
  });

  beforeAll(async () => {
    // People 4, 8 and 9 have no name, which the target refuses (NOT NULL).
    await legacy.query('CREATE TABLE public.retry_people (person_id int PRIMARY KEY, name text, updated_at int NOT NULL)');
    await legacy.query(
      "INSERT INTO public.retry_people SELECT n, CASE WHEN n IN (4, 8, 9) THEN NULL ELSE 'Person ' || n END, n FROM generate_series(1, 12) AS n",
    );
    await newcore.query('CREATE TABLE public.retry_people (id int PRIMARY KEY, name text NOT NULL)');
  });

  it('reads and writes only the failed rows once the job is fixed, and leaves the watermark alone', async () => {
    const { current, savedWatermarks, runToEnd } = runsHarness(sync, job);
    const first = await runToEnd();
    expect(first.stats).toMatchObject({ read: 12, written: 9, skipped: 3 });
    expect(first.failures?.map((failure) => [failure.stage, failure.sourceKey])).toEqual([
      ['write', { person_id: 4 }],
      ['write', { person_id: 8 }],
      ['write', { person_id: 9 }],
    ]);
    const watermarksBefore = [...savedWatermarks];
    expect(watermarksBefore.at(-1)).toEqual({ type: 'number', value: 12 });

    // Person 9 is deleted at the source; the others get a fallback name.
    await legacy.query('DELETE FROM public.retry_people WHERE person_id = 9');
    current.job = { ...job, mappings: [job.mappings[0], { from: 'name', to: 'name', transform: 'default', argument: 'Unknown' }] };
    const retry = await runToEnd({ retryOf: first.id });

    expect(retry).toMatchObject({ status: 'succeeded', retryOf: first.id, watermarkFrom: null, watermarkTo: null });
    expect(retry.stats).toMatchObject({ read: 2, written: 2, skipped: 0 });
    expect(retry.failures).toEqual([
      { row: 3, key: '9', stage: 'read', reason: 'No longer in the source', sourceKey: { person_id: 9 } },
    ]);
    expect(savedWatermarks).toEqual(watermarksBefore);
    const { rows } = await newcore.query('SELECT id, name FROM public.retry_people WHERE id IN (4, 8, 9) ORDER BY id');
    expect(rows).toEqual([
      { id: 4, name: 'Unknown' },
      { id: 8, name: 'Unknown' },
    ]);
  });
});

describe('Source preview', () => {
  it('returns raw rows with the conditions applied and the statement a run executes', async () => {
    const preview = await sync.previewSource({
      source: {
        connectionId: 'legacy',
        collection: 'public.orders',
        filters: [{ field: 'order_no', op: 'lte', type: 'number', value: '3' }],
      },
      mode: 'incremental',
      watermarkField: 'updated_at',
      mappings: [{ from: 'order_no', to: 'id', transform: 'none' }],
    });
    expect(preview.rows.map((row) => Number(row.order_no))).toEqual([1, 2, 3]);
    expect(Object.keys(preview.rows[0])).toEqual(expect.arrayContaining(['order_no', 'customer_ref', 'meta']));
    expect(preview.statement).toBe(
      'SELECT "order_no", "updated_at" FROM "public"."orders" WHERE "order_no" <= 3 ORDER BY "updated_at" ASC NULLS LAST;',
    );
  });

  it('runs the lookups on the preview rows and shows the query each one sends', async () => {
    const preview = await sync.previewSource({
      source: {
        connectionId: 'legacy',
        collection: 'public.orders',
        filters: [{ field: 'order_no', op: 'lte', type: 'number', value: '2' }],
      },
      lookups: [
        { as: 'customer', connectionId: 'crm', collection: 'customers', on: [{ source: 'customer_ref', lookup: 'customerRef' }], required: false },
      ],
      mode: 'full',
      mappings: [],
    });

    // Orders 1 and 2 belong to CUS-0002 and CUS-0003.
    expect(preview.rows.map((row) => (row.customer as Row).customerRef)).toEqual(['CUS-0002', 'CUS-0003']);
    expect(preview.lookups).toEqual([
      {
        as: 'customer',
        connection: 'crm',
        collection: 'customers',
        statement: 'db.getCollection("customers").find({"$or":[{"customerRef":"CUS-0002"},{"customerRef":"CUS-0003"}]})',
        keyCount: 2,
      },
    ]);
  });
});

describe('MySQL sandbox to PostgreSQL (README demo job)', () => {
  const job = makeJob({
    mode: 'incremental',
    watermarkField: 'updated_at',
    batchSize: 25,
    source: { connectionId: 'shop', collection: 'products' },
    target: { connectionId: 'newcore', collection: 'public.products', keyFields: ['sku'] },
    mappings: [
      { from: 'sku', to: 'sku', transform: 'none' },
      { from: 'name', to: 'name', transform: 'none' },
      { from: 'category', to: 'category', transform: 'expression', argument: 'value.trim().toLowerCase()' },
      { from: 'price_cents', to: 'price', transform: 'expression', argument: 'value / 100' },
      { from: 'active', to: 'is_active', transform: 'none' },
      { from: 'stock', to: 'stock', transform: 'none' },
      { from: 'attributes.color', to: 'color', transform: 'none' },
      { from: 'updated_at', to: 'updated_at', transform: 'none' },
    ],
  });

  it('loads the shop seed', async () => {
    const opened = await connectionsStub().open('shop');
    try {
      expect(await opened.connector.count('products')).toBe(60);
      expect(await opened.connector.count('order_lines')).toBe(2400);
    } finally {
      await opened.connector.close();
    }
  });

  it('copies the products with the README mappings and reconciles clean', async () => {
    const { stats } = await run(job);
    expect(stats).toMatchObject({ read: 60, written: 60, skipped: 0 });

    const { rows } = await newcore.query("SELECT * FROM public.products WHERE sku IN ('SKU-0009', 'SKU-0010') ORDER BY sku");
    expect(rows[0]).toMatchObject({ sku: 'SKU-0009', is_active: false });
    // SKU-0010 has a padded, capitalised category in the seed.
    expect(rows[1]).toMatchObject({ category: 'kitchen', price: '15.69', is_active: true, color: 'green', stock: 70 });

    const report = await sync.reconcile(job);
    expect(report).toMatchObject({ sourceCount: 60, targetCount: 60, matched: 60, missingCount: 0, mismatchedRows: 0 });
  });
});
