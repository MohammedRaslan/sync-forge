import { CosmosClient, Database } from '@azure/cosmos';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ValidationError } from '../../src/common/errors';
import { CosmosConfig } from '../../src/connections/connection.model';
import { Row } from '../../src/connectors/connector.types';
import { CosmosConnector } from '../../src/connectors/cosmos/cosmos.connector';
import { ContractHarness, SEED_ROWS, describeConnectorContract } from './connector-contract';
import { Started, startCosmos } from './containers';

let database: Started<CosmosConfig>;
let client: CosmosClient;
let db: Database;
let connector: CosmosConnector;
let targets = 0;

async function createContainer(partitionKey = '/id'): Promise<string> {
  const id = `target_${++targets}`;
  await db.containers.create({ id, partitionKey: { paths: [partitionKey] } });
  return id;
}

async function readAll(collection: string): Promise<Row[]> {
  const rows: Row[] = [];
  for await (const batch of connector.readBatches({ collection, batchSize: 100 })) rows.push(...batch);
  return rows;
}

beforeAll(async () => {
  database = await startCosmos();
  client = new CosmosClient({ endpoint: database.config.endpoint, key: database.config.key });
  ({ database: db } = await client.databases.createIfNotExists({ id: database.config.database }));
  const { container } = await db.containers.create({ id: 'items', partitionKey: { paths: ['/id'] } });
  for (const row of SEED_ROWS) {
    // Cosmos DB stores JSON, so dates live as ISO strings.
    await container.items.create({ ...row, updated_at: (row.updated_at as Date).toISOString() });
  }
  connector = new CosmosConnector(database.config);
});

afterAll(async () => {
  await connector?.close();
  client?.dispose();
  await database?.stop();
});

const harness = (): ContractHarness => ({ connector, sourceCollection: 'items', createTarget: () => createContainer() });

describeConnectorContract('Cosmos DB', harness);

describe('Cosmos DB connector', () => {
  it('finds documents whose id was mapped from a number', async () => {
    // An integer source key (e.g. a Postgres integer PK) is stored as the string "42".
    const target = await createContainer();
    await connector.upsert(target, [{ id: 42, name: 'numeric' }], ['id']);

    const found = await connector.findByKeys(target, ['id'], [{ id: 42 }]);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ id: '42', name: 'numeric' });
  });

  it('writes nested partition keys from dotted names', async () => {
    const target = await createContainer('/tenant/id');
    await connector.upsert(target, [{ id: 'a', 'tenant.id': 't1', name: 'nested' }], ['id']);

    const [document] = await readAll(target);
    expect(document).toMatchObject({ id: 'a', tenant: { id: 't1' }, name: 'nested' });
  });

  it('rejects documents without the partition key', async () => {
    const target = await createContainer('/tenant/id');
    await expect(connector.upsert(target, [{ id: 'a', name: 'no tenant' }], ['id'])).rejects.toBeInstanceOf(ValidationError);
  });

  it('rejects documents without an id', async () => {
    const target = await createContainer();
    await expect(connector.upsert(target, [{ id: '', name: 'blank' }], ['id'])).rejects.toBeInstanceOf(ValidationError);
  });

  it('replaces the whole document on upsert', async () => {
    const target = await createContainer();
    await connector.upsert(target, [{ id: 'w', name: 'first', extra: 'dropped' }], ['id']);
    await connector.upsert(target, [{ id: 'w', name: 'second' }], ['id']);

    const [document] = await connector.findByKeys(target, ['id'], [{ id: 'w' }]);
    expect(document.name).toBe('second');
    expect(document.extra).toBeUndefined();
  });

  it('strips system fields from what it reads', async () => {
    const rows = [...(await readAll('items')), ...(await connector.findByKeys('items', ['id'], [{ id: 'r01' }]))];
    for (const row of rows) {
      for (const field of ['_rid', '_self', '_etag', '_attachments']) expect(row).not.toHaveProperty(field);
    }
  });
});
