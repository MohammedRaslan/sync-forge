import { Db, Decimal128, MongoClient, ObjectId } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Row } from '../../src/connectors/connector.types';
import { MongoConnector } from '../../src/connectors/mongo/mongo.connector';
import { MongoConfig } from '../../src/connections/connection.model';
import { toStoredWatermark } from '../../src/sync/watermark';
import { ContractHarness, SEED_ROWS, describeConnectorContract } from './connector-contract';
import { Started, startMongo } from './containers';

let database: Started<MongoConfig>;
let client: MongoClient;
let db: Db;
let connector: MongoConnector;
let targets = 0;

const nextTarget = async () => `target_${++targets}`;

async function readAll(request: Parameters<MongoConnector['readBatches']>[0]): Promise<Row[]> {
  const rows: Row[] = [];
  for await (const batch of connector.readBatches(request)) rows.push(...batch);
  return rows;
}

beforeAll(async () => {
  database = await startMongo();
  client = await MongoClient.connect(database.config.uri);
  db = client.db(database.config.database);
  await db.collection('items').insertMany(SEED_ROWS.map((row) => ({ ...row })));
  connector = new MongoConnector(database.config);
});

afterAll(async () => {
  await connector?.close();
  await client?.close();
  await database?.stop();
});

const harness = (): ContractHarness => ({ connector, sourceCollection: 'items', createTarget: nextTarget });

describeConnectorContract('MongoDB', harness);

describe('MongoDB connector', () => {
  it('keeps fields the job does not manage', async () => {
    const target = await nextTarget();
    await db.collection(target).insertOne({ id: 'u', name: 'old', extra: 'keep me' });
    await connector.upsert(target, [{ id: 'u', name: 'new' }], ['id']);

    const document = await db.collection(target).findOne({ id: 'u' });
    expect(document).toMatchObject({ name: 'new', extra: 'keep me' });
  });

  it('updates nested fields through dotted names', async () => {
    const target = await nextTarget();
    await connector.upsert(target, [{ id: 'd', 'address.city': 'Cairo' }], ['id']);
    await connector.upsert(target, [{ id: 'd', 'address.zip': '11511' }], ['id']);

    const document = await db.collection(target).findOne({ id: 'd' });
    expect(document?.address).toEqual({ city: 'Cairo', zip: '11511' });
  });

  it('upserts rows that contain only key fields', async () => {
    const target = await nextTarget();
    await connector.upsert(target, [{ id: 'k' }], ['id']);
    await connector.upsert(target, [{ id: 'k' }], ['id']);
    expect(await connector.count(target)).toBe(1);
  });

  it('matches on composite keys', async () => {
    const target = await nextTarget();
    const rows = [
      { tenant: 't1', code: 'a', value: 1 },
      { tenant: 't2', code: 'a', value: 2 },
    ];
    await connector.upsert(target, rows, ['tenant', 'code']);
    await connector.upsert(target, [{ tenant: 't2', code: 'a', value: 3 }], ['tenant', 'code']);

    const found = await connector.findByKeys(target, ['tenant', 'code'], [{ tenant: 't2', code: 'a' }]);
    expect(found).toHaveLength(1);
    expect(found[0].value).toBe(3);
    expect(await connector.count(target)).toBe(2);
  });

  it('preserves BSON types in a MongoDB-to-MongoDB copy', async () => {
    const source = await nextTarget();
    const target = await nextTarget();
    const ref = new ObjectId();
    await db.collection(source).insertOne({ code: 'b', ref, price: Decimal128.fromString('12.50') });

    const rows = await readAll({ collection: source, batchSize: 10, fields: ['code', 'ref', 'price'] });
    await connector.upsert(target, rows.map(({ code, ref, price }) => ({ code, ref, price })), ['code']);

    const document = await db.collection(target).findOne({ code: 'b' });
    expect(document?.ref).toBeInstanceOf(ObjectId);
    expect((document?.ref as ObjectId).equals(ref)).toBe(true);
    expect(document?.price).toBeInstanceOf(Decimal128);
    expect(String(document?.price)).toBe('12.50');
  });

  it('infers nested paths and projects nested fields', async () => {
    const collection = await nextTarget();
    await db.collection(collection).insertMany([
      { id: 1, address: { city: 'Cologne', zip: '50667' }, secret: 'x' },
      { id: 2, address: { city: 'Berlin' } },
    ]);

    const paths = (await connector.describeCollection(collection)).map((field) => field.path);
    expect(paths).toEqual(expect.arrayContaining(['address.city', 'address.zip']));

    const rows = await readAll({ collection, batchSize: 10, fields: ['id', 'address.city'] });
    expect(rows[0].address).toEqual({ city: 'Cologne' });
    expect(rows[0].secret).toBeUndefined();
  });

  it('uses ObjectId watermarks', async () => {
    const all = await readAll({ collection: 'items', batchSize: 50, watermark: { field: '_id' } });
    const from = toStoredWatermark(all[10]._id);
    expect(from).toEqual({ type: 'objectId', value: expect.any(String) });

    const rest = await readAll({ collection: 'items', batchSize: 50, watermark: { field: '_id', from: from! } });
    expect(rest.map((row) => row.id)).toEqual(all.slice(10).map((row) => row.id));
  });
});
