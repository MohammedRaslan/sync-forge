import { readdirSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { NotFoundError, ValidationError } from '../src/common/errors';
import { CsvConfig } from '../src/connections/connection.model';
import { ReadRequest, Row } from '../src/connectors/connector.types';
import { CsvConnector } from '../src/connectors/csv/csv.connector';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/** A connector over a fresh temp folder holding `files` (name → content). */
async function setup(files: Record<string, string>, delimiter: CsvConfig['delimiter'] = 'auto') {
  const directory = await mkdtemp(join(tmpdir(), 'syncforge-csv-'));
  dirs.push(directory);
  for (const [name, content] of Object.entries(files)) await writeFile(join(directory, name), content);
  return { directory, connector: new CsvConnector({ kind: 'csv', delimiter, directory }) };
}

async function readAll(connector: CsvConnector, request: Partial<ReadRequest> & { collection: string }): Promise<Row[][]> {
  const batches: Row[][] = [];
  for await (const batch of connector.readBatches({ batchSize: 100, ...request })) batches.push(batch);
  return batches;
}

/** Files this process has open, on systems that list them in /dev/fd. */
function openFileCount(): number {
  return readdirSync('/dev/fd').length;
}

/** Waits until this process has no more open files than `baseline`: streams close their file asynchronously. */
async function filesClosed(baseline: number): Promise<boolean> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (openFileCount() <= baseline) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return false;
}

async function failure(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error('expected a failure');
}

const ORDERS = 'id,customer,amount,status\n1,ann,12.5,paid\n2,bob,,open\n3,cid,30,paid\n4,dan,"",paid\n5,eve,7,open\n';

describe('CsvConnector', () => {
  it('lists only uploaded .csv files, leaving out dot files, other files and folders', async () => {
    const { directory, connector } = await setup({ 'b.csv': 'a\n1\n', 'A.CSV': 'a\n1\n', '.b.csv.123.part': 'a\n', 'notes.txt': 'x' });
    await mkdir(join(directory, 'nested.csv'));
    expect(await connector.listCollections()).toEqual([
      { name: 'A.CSV', kind: 'file' },
      { name: 'b.csv', kind: 'file' },
    ]);
  });

  it('treats a folder that does not exist yet as having no files', async () => {
    const connector = new CsvConnector({ kind: 'csv', delimiter: 'auto', directory: join(tmpdir(), 'syncforge-csv-missing-folder') });
    await expect(connector.ping()).resolves.toBeUndefined();
    expect(await connector.listCollections()).toEqual([]);
  });

  it('describes columns in header order as text, nullable when a sampled cell is empty', async () => {
    const { connector } = await setup({ 'orders.csv': ORDERS });
    expect(await connector.describeCollection('orders.csv')).toEqual([
      { path: 'id', type: 'string', nullable: false, primaryKey: false },
      { path: 'customer', type: 'string', nullable: false, primaryKey: false },
      { path: 'amount', type: 'string', nullable: true, primaryKey: false },
      { path: 'status', type: 'string', nullable: false, primaryKey: false },
    ]);
  });

  it('describes the columns of a file that holds only a header row', async () => {
    const { connector } = await setup({ 'empty.csv': 'id;name\n' });
    expect((await connector.describeCollection('empty.csv')).map((field) => field.path)).toEqual(['id', 'name']);
  });

  it('reads every cell as text, an unquoted empty cell as null and a quoted one as empty text', async () => {
    const { connector } = await setup({ 'orders.csv': ORDERS });
    const [rows] = await readAll(connector, { collection: 'orders.csv' });
    expect(rows[0]).toEqual({ id: '1', customer: 'ann', amount: '12.5', status: 'paid' });
    expect(rows[1].amount).toBeNull();
    expect(rows[3].amount).toBe('');
  });

  it('strips a byte order mark and detects the delimiter from the header row', async () => {
    const { connector } = await setup({ 'bom.csv': '﻿id;name\n1;Ann\n' });
    expect(await readAll(connector, { collection: 'bom.csv' })).toEqual([[{ id: '1', name: 'Ann' }]]);
  });

  it('uses the configured delimiter instead of detecting one', async () => {
    const { connector } = await setup({ 'tabs.csv': 'id\tnote\n1\ta;b;c\n' }, '\t');
    expect(await readAll(connector, { collection: 'tabs.csv' })).toEqual([[{ id: '1', note: 'a;b;c' }]]);
  });

  it('counts the rows that match the filters', async () => {
    const { connector } = await setup({ 'orders.csv': ORDERS });
    expect(await connector.count('orders.csv')).toBe(5);
    expect(await connector.count('orders.csv', { filters: [{ field: 'status', op: 'eq', value: 'paid' }] })).toBe(3);
    expect(await connector.count('orders.csv', { filters: [{ field: 'amount', op: 'gt', value: 10 }] })).toBe(2);
    // "Not equal" also matches the unquoted empty (null) cell, like the database connectors; the quoted "" is no number.
    expect(await connector.count('orders.csv', { filters: [{ field: 'amount', op: 'ne', value: 7 }] })).toBe(3);
  });

  it('refuses a count over a SQL query', async () => {
    const { connector } = await setup({ 'orders.csv': ORDERS });
    expect(await failure(connector.count('orders.csv', { query: 'SELECT 1' }))).toBeInstanceOf(ValidationError);
  });

  it('reads in batches of at most the batch size, stopping at the limit', async () => {
    const { connector } = await setup({ 'orders.csv': ORDERS });
    const batches = await readAll(connector, { collection: 'orders.csv', batchSize: 2 });
    expect(batches.map((batch) => batch.map((row) => row.id))).toEqual([['1', '2'], ['3', '4'], ['5']]);

    const limited = await readAll(connector, { collection: 'orders.csv', batchSize: 2, limit: 3 });
    expect(limited.map((batch) => batch.map((row) => row.id))).toEqual([['1', '2'], ['3']]);

    const filtered = await readAll(connector, { collection: 'orders.csv', filters: [{ field: 'status', op: 'eq', value: 'paid' }], limit: 2 });
    expect(filtered.flat().map((row) => row.id)).toEqual(['1', '3']);
  });

  it('stops after the current batch once the run is cancelled', async () => {
    const { connector } = await setup({ 'orders.csv': ORDERS });
    const controller = new AbortController();
    const seen: Row[][] = [];
    for await (const batch of connector.readBatches({ collection: 'orders.csv', batchSize: 2, signal: controller.signal })) {
      seen.push(batch);
      controller.abort();
    }
    expect(seen).toHaveLength(1);
  });

  it('stops reading once the run is cancelled, even while filters skip every row', async () => {
    const { connector } = await setup({ 'orders.csv': ORDERS });
    const controller = new AbortController();
    controller.abort();
    const filters = [{ field: 'id', op: 'eq' as const, value: '5' }];
    expect(await readAll(connector, { collection: 'orders.csv', batchSize: 1, filters, signal: controller.signal })).toEqual([]);
  });

  it('reads every row of a file that ends with blank lines', async () => {
    const { connector } = await setup({ 'orders.csv': 'id,name\n1,Ann\n2,Bob\n\n\n' });
    expect(await readAll(connector, { collection: 'orders.csv' })).toEqual([
      [
        { id: '1', name: 'Ann' },
        { id: '2', name: 'Bob' },
      ],
    ]);
  });

  it('skips a blank line in a single-column file instead of reading it as an empty row', async () => {
    const { connector } = await setup({ 'ids.csv': 'id\n1\n\n2\n' });
    expect(await readAll(connector, { collection: 'ids.csv' })).toEqual([[{ id: '1' }, { id: '2' }]]);
    expect(await connector.count('ids.csv')).toBe(2);
  });

  it.skipIf(process.platform === 'win32')('closes the file when the caller stops early or the file cannot be parsed', async () => {
    const rows = Array.from({ length: 5000 }, (_, index) => `${index},name ${index}`).join('\n');
    const { connector } = await setup({ 'big.csv': `id,name\n${rows}\n`, 'ragged.csv': `id,name\n${rows}\n1\n` });
    const baseline = openFileCount();

    for await (const batch of connector.readBatches({ collection: 'big.csv', batchSize: 10 })) {
      expect(batch).toHaveLength(10);
      break;
    }
    expect(await filesClosed(baseline)).toBe(true);

    expect(await failure(connector.count('ragged.csv'))).toBeInstanceOf(ValidationError);
    expect(await filesClosed(baseline)).toBe(true);
  });

  it('refuses a watermark: CSV sources run in full mode', async () => {
    const { connector } = await setup({ 'orders.csv': ORDERS });
    const error = await failure(readAll(connector, { collection: 'orders.csv', watermark: { field: 'id' } }));
    expect(error).toBeInstanceOf(ValidationError);
    expect(error.message).toMatch(/^CSV sources run in full mode/);
  });

  it('finds rows by key, matching the number 42 with the cell "42"', async () => {
    const { connector } = await setup({ 'customers.csv': 'customer_id,name\n41,Ann\n42,Bob\n42,Bob again\n' });
    const found = await connector.findByKeys('customers.csv', ['customer_id'], [{ customer_id: 42 }, { customer_id: '42' }, { customer_id: 7 }]);
    expect(found).toEqual([
      { customer_id: '42', name: 'Bob' },
      { customer_id: '42', name: 'Bob again' },
    ]);
    expect(await connector.findByKeys('customers.csv', ['customer_id'], [])).toEqual([]);
  });

  it('indexes a file once per key fields and reuses the index for later lookups', async () => {
    const { directory, connector } = await setup({ 'customers.csv': 'customer_id,name\n1,Ann\n2,Bob\n' });
    expect(await connector.findByKeys('customers.csv', ['customer_id'], [{ customer_id: 1 }])).toEqual([{ customer_id: '1', name: 'Ann' }]);

    // Rewritten after the first lookup: the same connector keeps answering from the index it built.
    await writeFile(join(directory, 'customers.csv'), 'customer_id,name\n1,Changed\n2,Changed\n');
    expect(await connector.findByKeys('customers.csv', ['customer_id'], [{ customer_id: 2 }])).toEqual([{ customer_id: '2', name: 'Bob' }]);
    // Other key fields need their own index, read from the file as it is now.
    expect(await connector.findByKeys('customers.csv', ['name'], [{ name: 'Changed' }])).toHaveLength(2);
  });

  it('refuses writes', async () => {
    const { connector } = await setup({ 'orders.csv': ORDERS });
    expect(await failure(connector.upsert())).toBeInstanceOf(ValidationError);
    expect(() => connector.explainUpsert()).toThrow('CSV connections can only be read for now');
  });

  it('reports a ragged row with its line number and without any cell text', async () => {
    const { connector } = await setup({ 'ragged.csv': 'id,name,email\n1,Ann,ann@example.com\n2,SECRETCELL\n' });
    const error = await failure(readAll(connector, { collection: 'ragged.csv' }));
    expect(error).toBeInstanceOf(ValidationError);
    expect(error.message).toBe('ragged.csv line 3: expected 3 columns, got 2');
    expect(error.message).not.toContain('SECRETCELL');
  });

  it('refuses a header with a repeated column', async () => {
    const { connector } = await setup({ 'dup.csv': 'id,id\n1,2\n' });
    const error = await failure(connector.count('dup.csv'));
    expect(error).toBeInstanceOf(ValidationError);
    expect(error.message).toBe('dup.csv: column "id" appears twice in the header row');
  });

  it('reports a file that was not uploaded, and refuses names that are not CSV file names', async () => {
    const { connector } = await setup({});
    const missing = await failure(connector.count('missing.csv'));
    expect(missing).toBeInstanceOf(NotFoundError);
    expect(missing.message).toBe('"missing.csv" is not uploaded to this connection');
    expect(await failure(connector.count('../secret.key'))).toBeInstanceOf(ValidationError);
    expect(await failure(connector.describeCollection('.hidden.csv'))).toBeInstanceOf(ValidationError);
  });

  it('explains reads and key lookups in words', async () => {
    const { connector } = await setup({}, ',');
    expect(
      connector.explainRead({
        collection: 'customers.csv',
        batchSize: 500,
        filters: [
          { field: 'amount', op: 'gt', value: 10 },
          { field: 'status', op: 'eq', value: 'paid' },
        ],
        limit: 10,
      }),
    ).toBe('Read "customers.csv" (delimiter ",", header row) keeping rows where amount > 10 and status = "paid", first 10 rows');
    expect(connector.explainFindByKeys('customers.csv', ['customer_id'], [{ customer_id: 1 }, { customer_id: 2 }, { customer_id: 3 }])).toBe(
      'Index "customers.csv" by customer_id (once per run), then match 3 keys: 1, 2, 3',
    );
  });
});
