import { Connection, createConnection } from 'mysql2/promise';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ConnectionView, MysqlConfig } from '../../src/connections/connection.model';
import { ConnectionOpener, SyncService } from '../../src/sync/sync.service';
import { SyncRunner } from '../../src/sync/sync-runner';
import { TransformRegistry } from '../../src/transforms/transform.registry';
import { Job } from '../../src/jobs/job.model';
import { StoredWatermark } from '../../src/sync/watermark';
import { Row } from '../../src/connectors/connector.types';
import { MysqlConnector } from '../../src/connectors/mysql/mysql.connector';
import { ContractHarness, SEED_ROWS, describeConnectorContract } from './connector-contract';
import { Started, startMysql } from './containers';

let database: Started<MysqlConfig>;
let admin: Connection;
let connector: MysqlConnector;
let targets = 0;

async function createTable(name: string, extra = ''): Promise<string> {
  await admin.query(
    `CREATE TABLE \`${name}\` (id VARCHAR(40) PRIMARY KEY, name VARCHAR(100) NOT NULL, qty INT NULL, updated_at DATETIME(3) NULL, meta JSON NULL${extra})`,
  );
  return name;
}

async function readAll(request: Partial<Parameters<MysqlConnector['readBatches']>[0]> & { collection: string }): Promise<Row[]> {
  const rows: Row[] = [];
  for await (const batch of connector.readBatches({ batchSize: 100, ...request })) rows.push(...batch);
  return rows;
}

beforeAll(async () => {
  database = await startMysql();
  const { host, port, user, password } = database.config;
  admin = await createConnection({ host, port, user, password, database: 'test', timezone: 'Z' });
  await createTable('items');
  for (const row of SEED_ROWS) {
    const values = [row.id, row.name, row.qty, row.updated_at] as Array<string | number | Date>;
    await admin.execute('INSERT INTO items (id, name, qty, updated_at) VALUES (?, ?, ?, ?)', values);
  }
  connector = new MysqlConnector(database.config);
}, 300_000);

afterAll(async () => {
  await connector?.close();
  await admin?.end();
  await database?.stop();
});

const harness = (): ContractHarness => ({ connector, sourceCollection: 'items', createTarget: () => createTable(`target_${++targets}`) });

describeConnectorContract('MySQL', harness);

describe('MySQL connector', () => {
  it('matches on the key fields only: a clash on another unique column fails instead of updating another row', async () => {
    const target = await createTable(`target_${++targets}`, ', email VARCHAR(100) UNIQUE');
    await connector.upsert(target, [{ id: 'a', name: 'Ann', email: 'ann@x.io' }], ['id']);

    // A new id with Ann's email: ON DUPLICATE KEY UPDATE would silently rewrite Ann's row.
    await expect(connector.upsert(target, [{ id: 'b', name: 'Bob', email: 'ann@x.io' }], ['id'])).rejects.toThrow(/Duplicate entry/);

    const [ann] = await connector.findByKeys(target, ['id'], [{ id: 'a' }]);
    expect(ann).toMatchObject({ id: 'a', name: 'Ann', email: 'ann@x.io' });
    expect(await connector.count(target)).toBe(1);
  });

  it('writes a batch completely or not at all', async () => {
    const target = await createTable(`target_${++targets}`);
    await expect(connector.upsert(target, [{ id: 'ok', name: 'fine' }, { id: 'bad', name: null }], ['id'])).rejects.toThrow();
    expect(await connector.count(target)).toBe(0);
  });

  it('upserts on composite keys', async () => {
    await admin.query('CREATE TABLE prices (tenant VARCHAR(10), code VARCHAR(10), amount DECIMAL(10,2), PRIMARY KEY (tenant, code))');
    await connector.upsert('prices', [{ tenant: 't1', code: 'a', amount: 1.5 }, { tenant: 't2', code: 'a', amount: 2 }], ['tenant', 'code']);
    await connector.upsert('prices', [{ tenant: 't2', code: 'a', amount: '12.50' }], ['tenant', 'code']);
    const found = await connector.findByKeys('prices', ['tenant', 'code'], [{ tenant: 't2', code: 'a' }]);
    expect(found).toEqual([{ tenant: 't2', code: 'a', amount: '12.50' }]);
    expect(await connector.count('prices')).toBe(2);
  });

  it('round-trips booleans, JSON, big integers and UTC dates', async () => {
    await admin.query('CREATE TABLE types_test (id BIGINT PRIMARY KEY, active TINYINT(1), meta JSON, at DATETIME(3))');
    const at = new Date('2025-01-31T08:15:00.000Z');
    await connector.upsert('types_test', [{ id: '9007199254740993', active: true, meta: { tags: ['a'] }, at }], ['id']);

    const [row] = await connector.findByKeys('types_test', ['id'], [{ id: '9007199254740993' }]);
    expect(row).toEqual({ id: '9007199254740993', active: true, meta: { tags: ['a'] }, at });
    const [stored] = (await admin.query("SELECT DATE_FORMAT(at, '%Y-%m-%d %H:%i') AS at FROM types_test")) as unknown as [Row[]];
    expect(stored[0].at).toBe('2025-01-31 08:15');
    const fields = await connector.describeCollection('types_test');
    expect(fields.find((field) => field.path === 'active')?.type).toBe('boolean');
  });

  it('reads, counts and describes SQL query sources in a read-only transaction', async () => {
    const query = 'SELECT id, qty * 2 AS doubled, updated_at FROM items WHERE qty <= 20;';
    const rows = await readAll({ collection: 'doubled', query, batchSize: 7 });
    expect(rows).toHaveLength(20);
    // qty * 2 is a BIGINT, and big integers come back as text so no digits are lost.
    expect(rows.find((row) => row.id === 'r05')?.doubled).toBe('10');
    expect(await connector.count('doubled', { query })).toBe(20);
    expect((await connector.describeQuery(query)).map(({ path, type }) => [path, type])).toEqual([
      ['id', 'varchar'],
      ['doubled', 'bigint'],
      ['updated_at', 'datetime'],
    ]);

    await expect(connector.count('gone', { query: 'SELECT 1 AS n FROM items FOR UPDATE' })).rejects.toThrow();
    await expect(readAll({ collection: 'x', query: 'DELETE FROM items' })).rejects.toThrow();
    expect(await connector.count('items')).toBe(SEED_ROWS.length);
  });

  it('keeps a question mark inside a query source untouched', async () => {
    const rows = await readAll({
      collection: 'marks',
      query: "SELECT id, 'why?' AS label FROM items",
      filters: [{ field: 'id', op: 'eq', value: 'r01' }],
    });
    expect(rows).toEqual([{ id: 'r01', label: 'why?' }]);
  });

  it('shows the read, lookup and write statements with values written in', () => {
    expect(connector.explainRead({ collection: 'items', batchSize: 10, filters: [{ field: 'qty', op: 'gt', value: 20 }], watermark: { field: 'updated_at' } })).toBe(
      'SELECT * FROM `items` WHERE `qty` > 20 ORDER BY `updated_at` IS NULL, `updated_at` ASC;',
    );
    const write = connector.explainUpsert('items', [{ id: 'r01', name: "O'Brien" }], ['id']);
    expect(write).toContain("INSERT INTO `items` (`id`, `name`) VALUES ('r01', 'O\\'Brien');");
    expect(write).toContain("UPDATE `items` SET `name` = 'O\\'Brien' WHERE `id` = 'r01';");
  });
});

describe('MySQL jobs end to end', () => {
  const opener: ConnectionOpener = {
    async open(id: string) {
      const view: ConnectionView = { id, name: id, kind: 'mysql', summary: id, settings: {}, hasSecret: true, createdAt: '', updatedAt: '' };
      return { connector: new MysqlConnector(database.config), view };
    },
  };
  const sync = () => new SyncService(opener, new TransformRegistry());
  const job: Job = {
    id: 'mysql-job',
    name: 'items to copy',
    source: { connectionId: 'src', collection: 'items' },
    target: { connectionId: 'dst', collection: 'items_copy', keyFields: ['id'] },
    mappings: [
      { from: 'id', to: 'id', transform: 'none' },
      { from: 'name', to: 'label', transform: 'uppercase' },
      { from: 'qty', to: 'qty', transform: 'none' },
      { from: 'updated_at', to: 'updated_at', transform: 'none' },
    ],
    mode: 'incremental',
    watermarkField: 'updated_at',
    batchSize: 7,
    errorPolicy: 'fail',
    createdAt: '',
    updatedAt: '',
  };
  const run = (from: StoredWatermark | null) =>
    sync().withPipeline(job, ({ source, target, mapper, enricher }) =>
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

  it('copies MySQL to MySQL incrementally and reconciles clean', async () => {
    await admin.query('CREATE TABLE items_copy (id VARCHAR(40) PRIMARY KEY, label VARCHAR(100), qty INT, updated_at DATETIME(3))');

    const first = await run(null);
    expect(first.stats).toMatchObject({ read: 25, written: 25, skipped: 0 });

    await admin.query("UPDATE items SET name = 'Changed', updated_at = '2030-01-01 00:00:00' WHERE id IN ('r03', 'r04')");
    const second = await run(first.watermark);
    // The two changed rows plus r24 and r25, which share the first run's last watermark (it is inclusive).
    expect(second.stats.read).toBe(4);
    const [changed] = (await admin.query("SELECT label FROM items_copy WHERE id = 'r03'")) as unknown as [Row[]];
    expect(changed[0].label).toBe('CHANGED');

    const report = await sync().reconcile(job);
    expect(report).toMatchObject({ sourceCount: 25, targetCount: 25, matched: 25, missingCount: 0, mismatchedRows: 0 });
  });
});
