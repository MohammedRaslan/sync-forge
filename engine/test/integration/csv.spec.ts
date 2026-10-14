import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MongoClient } from 'mongodb';
import { Connection, createConnection } from 'mysql2/promise';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ConnectionView, ConnectorConfig, MongoConfig, MysqlConfig, PostgresConfig } from '../../src/connections/connection.model';
import { ConnectionsService } from '../../src/connections/connections.service';
import { ConnectorFactory } from '../../src/connectors/connector.factory';
import { Job } from '../../src/jobs/job.model';
import { SyncRunner } from '../../src/sync/sync-runner';
import { SyncService } from '../../src/sync/sync.service';
import { TransformRegistry } from '../../src/transforms/transform.registry';
import { Started, startMongo, startMysql, startPostgres } from './containers';

/**
 * CSV files as a source and as a lookup, written into real databases. Every CSV cell is text: Postgres and
 * MySQL convert it to the column type, MongoDB needs the number/boolean/date transforms. Synthetic data only.
 */

let postgres: Started<PostgresConfig>;
let mysql: Started<MysqlConfig>;
let mongo: Started<MongoConfig>;
let csvDir: string;
let configs: Record<string, ConnectorConfig>;
let pg: Pool;
let my: Connection;
let mongoClient: MongoClient;
let sync: SyncService;

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

/** The same columns for every typed-target test, mapped one to one. */
const ITEM_MAPPINGS: Job['mappings'] = ['id', 'amount', 'active', 'placed_at', 'note'].map((field) => ({ from: field, to: field, transform: 'none' }));

beforeAll(async () => {
  [postgres, mysql, mongo] = await Promise.all([startPostgres(), startMysql(), startMongo()]);
  csvDir = mkdtempSync(join(tmpdir(), 'syncforge-csv-it-'));
  // Comma-separated with a byte order mark. Row 2 has an unquoted empty note (null), row 3 a quoted "" (empty text).
  writeFileSync(
    join(csvDir, 'items.csv'),
    '﻿id,amount,active,placed_at,note\n' +
      '1,12.50,true,2025-03-01T10:00:00Z,first\n' +
      '2,7.25,false,2025-03-02T11:30:00+02:00,\n' +
      '3,100.00,true,2025-03-03T00:00:00Z,""\n' +
      '4,0.99,false,2025-03-04T23:59:59Z,"semi; colon, comma"\n',
  );
  // The same rows separated by semicolons, with MySQL-style date-times and 1/0 flags.
  writeFileSync(
    join(csvDir, 'items-semi.csv'),
    'id;amount;active;placed_at;note\n' +
      '1;12.50;1;2025-03-01T10:00:00Z;first\n' +
      '2;7.25;0;2025-03-02T09:30:00Z;\n' +
      '3;100.00;1;2025-03-03T00:00:00Z;""\n' +
      '4;0.99;0;2025-03-04T23:59:59Z;"semi; colon, comma"\n',
  );
  // Date-times without an offset, which mean UTC; the 23:30 one lands on another day in any zone east of UTC.
  writeFileSync(join(csvDir, 'naive.csv'), 'id,placed_at,placed_on\n1,2025-03-01 10:00:00,2025-03-01\n2,2025-03-02 23:30:00,2025-03-02\n');
  writeFileSync(join(csvDir, 'products.csv'), 'id,name,unit\n10,Widget A,pcs\n20,Widget B,kg\n30,Unused,pcs\n');

  configs = {
    files: { kind: 'csv', delimiter: 'auto', directory: csvDir },
    pg: postgres.config,
    my: mysql.config,
    mongo: { ...mongo.config, database: 'csvtarget' },
  };
  const { host, port, database, user, password } = postgres.config;
  pg = new Pool({ host, port, database, user, password, max: 2 });
  my = await createConnection({ host: mysql.config.host, port: mysql.config.port, user: 'root', password: 'mysql', database: 'test', timezone: 'Z' });
  mongoClient = await MongoClient.connect(mongo.config.uri);
  sync = new SyncService(connectionsStub(), new TransformRegistry());
});

afterAll(async () => {
  await Promise.allSettled([pg?.end(), my?.end(), mongoClient?.close()]);
  await Promise.allSettled([postgres?.stop(), mysql?.stop(), mongo?.stop()]);
  if (csvDir) rmSync(csvDir, { recursive: true, force: true });
});

describe('CSV to PostgreSQL with typed columns', () => {
  const job = makeJob({
    source: { connectionId: 'files', collection: 'items.csv' },
    target: { connectionId: 'pg', collection: 'public.items', keyFields: ['id'] },
    mappings: ITEM_MAPPINGS,
  });

  beforeAll(async () => {
    await pg.query('CREATE TABLE public.items (id int PRIMARY KEY, amount numeric(10,2), active boolean, placed_at timestamptz, note text)');
  });

  it('lets Postgres convert the text cells to the column types, keeping null apart from empty text', async () => {
    const { stats } = await run(job);
    expect(stats).toMatchObject({ read: 4, written: 4, skipped: 0 });

    const { rows } = await pg.query('SELECT * FROM public.items ORDER BY id');
    expect(rows).toEqual([
      { id: 1, amount: '12.50', active: true, placed_at: new Date('2025-03-01T10:00:00Z'), note: 'first' },
      { id: 2, amount: '7.25', active: false, placed_at: new Date('2025-03-02T09:30:00Z'), note: null },
      { id: 3, amount: '100.00', active: true, placed_at: new Date('2025-03-03T00:00:00Z'), note: '' },
      { id: 4, amount: '0.99', active: false, placed_at: new Date('2025-03-04T23:59:59Z'), note: 'semi; colon, comma' },
    ]);
  });

  it('reconciles clean against the text cells', async () => {
    const report = await sync.reconcile(job);
    expect(report).toMatchObject({ sourceCount: 4, targetCount: 4, sampled: 4, matched: 4, missingCount: 0, mismatchedRows: 0 });
  });

  it('is idempotent', async () => {
    await run(job);
    const { rows } = await pg.query('SELECT count(*)::int AS n FROM public.items');
    expect(rows[0].n).toBe(4);
  });
});

describe('CSV to MySQL with typed columns (semicolon-separated)', () => {
  const job = makeJob({
    source: { connectionId: 'files', collection: 'items-semi.csv' },
    target: { connectionId: 'my', collection: 'items', keyFields: ['id'] },
    mappings: ITEM_MAPPINGS.map((mapping) =>
      // TINYINT(1) reads back as a boolean and DATETIME has no offset, so these two get real types before the write.
      mapping.to === 'active' ? { ...mapping, transform: 'boolean' } : mapping.to === 'placed_at' ? { ...mapping, transform: 'date' } : mapping,
    ),
  });

  beforeAll(async () => {
    await my.query('CREATE TABLE items (id INT PRIMARY KEY, amount DECIMAL(10,2), active TINYINT(1), placed_at DATETIME, note VARCHAR(100) NULL)');
  });

  it('lets MySQL convert the text cells to the column types, keeping null apart from empty text', async () => {
    const { stats } = await run(job);
    expect(stats).toMatchObject({ read: 4, written: 4, skipped: 0 });

    const [rows] = await my.query('SELECT * FROM items ORDER BY id');
    expect(rows).toEqual([
      { id: 1, amount: '12.50', active: 1, placed_at: new Date('2025-03-01T10:00:00Z'), note: 'first' },
      { id: 2, amount: '7.25', active: 0, placed_at: new Date('2025-03-02T09:30:00Z'), note: null },
      { id: 3, amount: '100.00', active: 1, placed_at: new Date('2025-03-03T00:00:00Z'), note: '' },
      { id: 4, amount: '0.99', active: 0, placed_at: new Date('2025-03-04T23:59:59Z'), note: 'semi; colon, comma' },
    ]);
  });

  it('reconciles clean', async () => {
    const report = await sync.reconcile(job);
    expect(report).toMatchObject({ sourceCount: 4, targetCount: 4, sampled: 4, matched: 4, missingCount: 0, mismatchedRows: 0 });
  });

  it('is idempotent', async () => {
    await run(job);
    const [rows] = await my.query('SELECT count(*) AS n FROM items');
    expect((rows as Array<{ n: number }>)[0].n).toBe(4);
  });
});

describe('CSV date-times without an offset into naive date columns', () => {
  // The integration tests run in Europe/Athens (vitest.integration.config.ts), so reading these as local time would fail.
  const mappings: Job['mappings'] = ['id', 'placed_at', 'placed_on'].map((field) => ({ from: field, to: field, transform: 'none' }));
  const pgJob = makeJob({
    source: { connectionId: 'files', collection: 'naive.csv' },
    target: { connectionId: 'pg', collection: 'public.naive_items', keyFields: ['id'] },
    mappings,
  });
  const myJob = makeJob({
    source: { connectionId: 'files', collection: 'naive.csv' },
    target: { connectionId: 'my', collection: 'naive_items', keyFields: ['id'] },
    mappings,
  });

  beforeAll(async () => {
    await pg.query('CREATE TABLE public.naive_items (id int PRIMARY KEY, placed_at timestamp, placed_on date)');
    await my.query('CREATE TABLE naive_items (id INT PRIMARY KEY, placed_at DATETIME, placed_on DATE)');
  });

  it('stores the wall time as written and reconciles clean against Postgres timestamp and date columns', async () => {
    await run(pgJob);
    const { rows } = await pg.query("SELECT id, placed_at::text AS placed_at, placed_on::text AS placed_on FROM public.naive_items ORDER BY id");
    expect(rows).toEqual([
      { id: 1, placed_at: '2025-03-01 10:00:00', placed_on: '2025-03-01' },
      { id: 2, placed_at: '2025-03-02 23:30:00', placed_on: '2025-03-02' },
    ]);
    const report = await sync.reconcile(pgJob);
    expect(report).toMatchObject({ sourceCount: 2, targetCount: 2, matched: 2, missingCount: 0, mismatchedRows: 0 });
  });

  it('stores the wall time as written and reconciles clean against MySQL DATETIME and DATE columns', async () => {
    await run(myJob);
    const [rows] = await my.query("SELECT id, DATE_FORMAT(placed_at, '%Y-%m-%d %H:%i:%s') AS placed_at, DATE_FORMAT(placed_on, '%Y-%m-%d') AS placed_on FROM naive_items ORDER BY id");
    expect(rows).toEqual([
      { id: 1, placed_at: '2025-03-01 10:00:00', placed_on: '2025-03-01' },
      { id: 2, placed_at: '2025-03-02 23:30:00', placed_on: '2025-03-02' },
    ]);
    const report = await sync.reconcile(myJob);
    expect(report).toMatchObject({ sourceCount: 2, targetCount: 2, matched: 2, missingCount: 0, mismatchedRows: 0 });
  });
});

describe('CSV to MongoDB with transforms', () => {
  const job = makeJob({
    source: { connectionId: 'files', collection: 'items.csv' },
    target: { connectionId: 'mongo', collection: 'items', keyFields: ['itemId'] },
    mappings: [
      { from: 'id', to: 'itemId', transform: 'number' },
      { from: 'amount', to: 'amount', transform: 'number' },
      { from: 'active', to: 'active', transform: 'boolean' },
      { from: 'placed_at', to: 'placedAt', transform: 'date' },
      { from: 'note', to: 'note', transform: 'none' },
    ],
  });

  it('stores numbers, booleans and dates as BSON types', async () => {
    const { stats } = await run(job);
    expect(stats).toMatchObject({ read: 4, written: 4, skipped: 0 });

    const items = mongoClient.db('csvtarget').collection('items');
    const first = await items.findOne({ itemId: 1 });
    expect(first).toMatchObject({ itemId: 1, amount: 12.5, active: true, placedAt: new Date('2025-03-01T10:00:00Z'), note: 'first' });
    expect(await items.countDocuments({ itemId: { $type: 'number' }, amount: { $type: 'number' }, active: { $type: 'bool' }, placedAt: { $type: 'date' } })).toBe(4);
    expect(await items.findOne({ itemId: 2 })).toMatchObject({ note: null });
    expect(await items.findOne({ itemId: 3 })).toMatchObject({ note: '' });
  });

  it('reconciles clean', async () => {
    const report = await sync.reconcile(job);
    expect(report).toMatchObject({ sourceCount: 4, targetCount: 4, matched: 4, missingCount: 0, mismatchedRows: 0 });
  });
});

describe('CSV file as a lookup', () => {
  const job = makeJob({
    source: {
      connectionId: 'pg',
      collection: 'order_lines',
      query: 'SELECT n AS line_id, CASE WHEN n % 2 = 0 THEN 20 ELSE 10 END AS product_id, n * 3 AS qty FROM generate_series(1, 6) AS n',
    },
    lookups: [{ as: 'product', connectionId: 'files', collection: 'products.csv', on: [{ source: 'product_id', lookup: 'id' }], required: true }],
    target: { connectionId: 'pg', collection: 'public.order_lines', keyFields: ['line_id'] },
    mappings: [
      { from: 'line_id', to: 'line_id', transform: 'none' },
      { from: 'product.name', to: 'product_name', transform: 'none' },
      { from: 'product.unit', to: 'unit', transform: 'none' },
      { from: 'qty', to: 'qty', transform: 'none' },
    ],
  });

  beforeAll(async () => {
    await pg.query('CREATE TABLE public.order_lines (line_id int PRIMARY KEY, product_name text NOT NULL, unit text, qty int)');
  });

  it('enriches each Postgres row from the CSV row whose text key equals its integer key', async () => {
    const { stats } = await run(job);
    expect(stats).toMatchObject({ read: 6, written: 6, skipped: 0 });

    const { rows } = await pg.query('SELECT line_id, product_name, unit, qty FROM public.order_lines ORDER BY line_id LIMIT 2');
    expect(rows).toEqual([
      { line_id: 1, product_name: 'Widget A', unit: 'pcs', qty: 3 },
      { line_id: 2, product_name: 'Widget B', unit: 'kg', qty: 6 },
    ]);
  });

  it('reconciles with the CSV lookup applied', async () => {
    const report = await sync.reconcile(job);
    expect(report).toMatchObject({ sourceCount: 6, targetCount: 6, matched: 6, missingCount: 0, mismatchedRows: 0, unmappable: 0 });
  });
});

describe('CSV source with a condition', () => {
  const job = makeJob({
    source: { connectionId: 'files', collection: 'items.csv', filters: [{ field: 'amount', op: 'gte', type: 'number', value: '10' }] },
    target: { connectionId: 'pg', collection: 'public.big_items', keyFields: ['id'] },
    mappings: ITEM_MAPPINGS.filter((mapping) => mapping.to === 'id' || mapping.to === 'amount'),
  });

  beforeAll(async () => {
    await pg.query('CREATE TABLE public.big_items (id int PRIMARY KEY, amount numeric(10,2))');
  });

  it('writes only the rows that match, comparing the cells as numbers', async () => {
    // As text, "7.25" >= "10" would hold; as numbers only 12.50 and 100.00 do.
    const { stats } = await run(job);
    expect(stats).toMatchObject({ read: 2, written: 2, skipped: 0 });
    const { rows } = await pg.query('SELECT id FROM public.big_items ORDER BY id');
    expect(rows.map((row) => row.id)).toEqual([1, 3]);

    const report = await sync.reconcile(job);
    expect(report).toMatchObject({ sourceCount: 2, targetCount: 2, missingCount: 0, mismatchedRows: 0 });
  });
});
