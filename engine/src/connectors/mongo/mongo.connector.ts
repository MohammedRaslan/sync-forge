import { AnyBulkWriteOperation, BSON, Db, Document, Filter, FindOptions, MongoClient, ObjectId, Sort } from 'mongodb';
import { CollectionInfo, Connector, FieldInfo, FilterOp, ReadRequest, Row, SourceFilter, SourceScope } from '../connector.types';
import { MongoConfig } from '../../connections/connection.model';
import { inferSchema } from '../schema-inference';
import { collapsePaths } from '../../common/paths';
import { StoredWatermark, fromStoredWatermark } from '../../sync/watermark';

const SAMPLE_SIZE = 500;

const MONGO_OPERATORS: Record<FilterOp, string> = { eq: '$eq', ne: '$ne', gt: '$gt', gte: '$gte', lt: '$lt', lte: '$lte' };

/**
 * Values are written as they come: BSON types (ObjectId, Decimal128, dates) survive a
 * MongoDB-to-MongoDB sync. Values from other sources arrive as plain JS values.
 */
export class MongoConnector implements Connector {
  private readonly client: MongoClient;
  private readonly db: Db;

  constructor(config: MongoConfig) {
    this.client = new MongoClient(config.uri, { serverSelectionTimeoutMS: 10_000, appName: 'syncforge' });
    this.db = this.client.db(config.database);
  }

  async ping(): Promise<void> {
    await this.db.command({ ping: 1 });
  }

  async close(): Promise<void> {
    await this.client.close();
  }

  async listCollections(): Promise<CollectionInfo[]> {
    const collections = await this.db.listCollections({}, { nameOnly: true }).toArray();
    return collections
      .filter((collection) => !collection.name.startsWith('system.'))
      .map((collection) => ({ name: collection.name, kind: 'collection' as const }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async describeCollection(collection: string): Promise<FieldInfo[]> {
    const sample = await this.db.collection(collection).aggregate([{ $sample: { size: SAMPLE_SIZE } }]).toArray();
    return inferSchema(sample, ['_id']);
  }

  async *readBatches(request: ReadRequest): AsyncIterable<Row[]> {
    const { filter, options } = findFor(request);
    const cursor = this.db.collection(request.collection).find(filter, { ...options, batchSize: request.batchSize });

    try {
      let batch: Row[] = [];
      for await (const document of cursor) {
        if (request.signal?.aborted) return;
        batch.push(document);
        if (batch.length >= request.batchSize) {
          yield batch;
          batch = [];
        }
      }
      if (batch.length > 0) yield batch;
    } finally {
      await cursor.close();
    }
  }

  async count(collection: string, scope: SourceScope = {}): Promise<number> {
    return this.db.collection(collection).countDocuments(filterFor(scope.filters ?? []));
  }

  explainRead(request: ReadRequest): string {
    const { filter, options } = findFor(request);
    let text = `db.getCollection(${JSON.stringify(request.collection)}).find(${ejson(filter)}, ${ejson(options.projection)})`;
    text += `.sort(${ejson(options.sort)})`;
    if (options.limit !== undefined) text += `.limit(${options.limit})`;
    return text;
  }

  async upsert(collection: string, rows: Row[], keyFields: string[]): Promise<void> {
    if (rows.length === 0) return;
    await this.db.collection(collection).bulkWrite(upsertOperations(rows, keyFields), { ordered: false });
  }

  explainUpsert(collection: string, rows: Row[], keyFields: string[]): string {
    if (rows.length === 0) return '// nothing to write';
    return `db.getCollection(${JSON.stringify(collection)}).bulkWrite(${ejson(upsertOperations(rows, keyFields))}, {"ordered":false})`;
  }

  async findByKeys(collection: string, keyFields: string[], keys: Row[]): Promise<Row[]> {
    if (keys.length === 0) return [];
    return this.db.collection(collection).find(keyFilter(keyFields, keys)).toArray();
  }

  explainFindByKeys(collection: string, keyFields: string[], keys: Row[]): string {
    return `db.getCollection(${JSON.stringify(collection)}).find(${ejson(keyFilter(keyFields, keys))})`;
  }
}

/** One upsert per row; shared by upsert and explainUpsert. */
function upsertOperations(rows: Row[], keyFields: string[]): AnyBulkWriteOperation<Document>[] {
  return rows.map((row) => {
    const filter = pickFields(row, keyFields);
    const changes = Object.fromEntries(Object.entries(row).filter(([field]) => !keyFields.includes(field)));
    // $set (not replace) keeps fields in the target document that this job does not manage.
    // Dotted keys such as "address.city" update a nested field in place.
    const update = Object.keys(changes).length > 0 ? { $set: changes } : { $setOnInsert: filter };
    return { updateOne: { filter, update, upsert: true } };
  });
}

/** The filter behind a key lookup; shared by findByKeys and explainFindByKeys. */
function keyFilter(keyFields: string[], keys: Row[]): Filter<Document> {
  return { $or: keys.map((key) => pickFields(key, keyFields)) };
}

/** Extended JSON keeps dates and ObjectIds recognisable when a query is shown to people. */
function ejson(value: unknown): string {
  return BSON.EJSON.stringify(value ?? {}, { relaxed: true });
}

function pickFields(row: Row, fields: string[]): Row {
  return Object.fromEntries(fields.map((field) => [field, row[field]]));
}

/** Filter, projection and order of a read; shared by readBatches and explainRead so they never disagree. */
function findFor(request: ReadRequest): { filter: Filter<Document>; options: FindOptions & { sort: Sort } } {
  const { watermark } = request;
  const conditions = [...(request.filters ?? [])];
  if (watermark?.from) conditions.push({ field: watermark.field, op: 'gte', value: toMongoValue(watermark.from) });
  const projectionPaths = request.fields && collapsePaths([...request.fields, ...(watermark ? [watermark.field] : [])]);
  return {
    filter: filterFor(conditions),
    options: {
      projection: projectionPaths && Object.fromEntries(projectionPaths.map((path) => [path, 1])),
      sort: watermark ? { [watermark.field]: 1 } : { _id: 1 },
      limit: request.limit,
    },
  };
}

/** $and keeps two conditions on the same field (a filter and the watermark) from overwriting each other. */
function filterFor(filters: readonly SourceFilter[]): Filter<Document> {
  const conditions = filters.map((filter) => ({ [filter.field]: { [MONGO_OPERATORS[filter.op]]: filter.value } }));
  if (conditions.length === 0) return {};
  return conditions.length === 1 ? conditions[0] : { $and: conditions };
}

function toMongoValue(watermark: StoredWatermark): unknown {
  return watermark.type === 'objectId' ? new ObjectId(watermark.value) : fromStoredWatermark(watermark);
}
