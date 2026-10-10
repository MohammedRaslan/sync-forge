import { Agent } from 'node:https';
import { Container, CosmosClient, Database, SqlParameter, SqlQuerySpec } from '@azure/cosmos';
import { CollectionInfo, Connector, FieldInfo, FilterOp, ReadRequest, Row, SourceFilter, SourceScope } from '../connector.types';
import { CosmosConfig } from '../../connections/connection.model';
import { inferSchema } from '../schema-inference';
import { ValidationError } from '../../common/errors';
import { forEachWithConcurrency } from '../../common/collections';
import { getPath, unflatten } from '../../common/paths';
import { normalizeRecord, normalizeValue } from '../../common/values';
import { fromStoredWatermark } from '../../sync/watermark';

const SAMPLE_SIZE = 500;
const WRITE_CONCURRENCY = 8;
const SYSTEM_FIELDS = new Set(['_rid', '_self', '_etag', '_attachments']);

/** Builds `c["address"]["city"]`, which is safe for any field name. */
export function cosmosPath(path: string): string {
  return `c${path
    .split('.')
    .map((segment) => `[${JSON.stringify(segment)}]`)
    .join('')}`;
}

/** Cosmos DB stores JSON; dates become ISO strings, the same way the SDK serializes them. */
function toCosmosValue(value: unknown): unknown {
  const normalized = normalizeValue(value);
  return normalized instanceof Date ? normalized.toISOString() : normalized;
}

/** "Not equal" also matches missing and null values, like MongoDB's $ne. */
function filterCondition(path: string, op: FilterOp, parameter: string): string {
  const operators: Record<Exclude<FilterOp, 'ne'>, string> = { eq: '=', gt: '>', gte: '>=', lt: '<', lte: '<=' };
  return op === 'ne'
    ? `(NOT IS_DEFINED(${path}) OR IS_NULL(${path}) OR ${path} != ${parameter})`
    : `${path} ${operators[op]} ${parameter}`;
}

function whereFor(filters: readonly SourceFilter[], parameters: SqlParameter[]): string[] {
  return filters.map((filter) => {
    const name = `@f${parameters.length}`;
    parameters.push({ name, value: toCosmosValue(filter.value) as string | number | boolean });
    return filterCondition(cosmosPath(filter.field), filter.op, name);
  });
}

function whereClause(conditions: readonly string[]): string {
  return conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : '';
}

/** The query behind a read; shared by readBatches and explainRead so they never disagree. */
function querySpecFor(request: ReadRequest): SqlQuerySpec & { parameters: SqlParameter[] } {
  const { watermark } = request;
  const parameters: SqlParameter[] = [];
  const conditions = whereFor(request.filters ?? [], parameters);
  if (watermark?.from) {
    parameters.push({ name: '@from', value: toCosmosValue(fromStoredWatermark(watermark.from)) as string | number });
    conditions.push(`${cosmosPath(watermark.field)} >= @from`);
  }
  let query = `SELECT * FROM c${whereClause(conditions)}`;
  if (watermark) query += ` ORDER BY ${cosmosPath(watermark.field)} ASC`;
  return { query, parameters };
}

/** The query behind a key lookup; shared by findByKeys and explainFindByKeys. */
function keyQuerySpec(keyFields: string[], keys: Row[]): SqlQuerySpec & { parameters: SqlParameter[] } {
  const parameters: SqlParameter[] = [];
  const conditions = keys.map((key) => {
    const parts = keyFields.map((field) => {
      const name = `@p${parameters.length}`;
      // `upsert` stores ids as strings, and Cosmos DB never matches 42 against "42".
      const value = field === 'id' ? String(normalizeValue(key[field])) : toCosmosValue(key[field]);
      parameters.push({ name, value: value as string });
      return `${cosmosPath(field)} = ${name}`;
    });
    return `(${parts.join(' AND ')})`;
  });
  return { query: `SELECT * FROM c WHERE ${conditions.join(' OR ')}`, parameters };
}

/** The document written for a row: nested from dotted names, with a string id. Shared by upsert and explainUpsert. */
function toDocument(row: Row): Row {
  const document = unflatten(normalizeRecord(row));
  if (document.id === null || document.id === undefined || document.id === '') {
    throw new ValidationError('Every Cosmos DB document needs an "id"');
  }
  document.id = String(document.id);
  return document;
}

/** A query as people read it: parameters written in as JSON literals, so it can be copied and run. */
function describeQuerySpec({ query, parameters }: { query: string; parameters: SqlParameter[] }): string {
  const values = new Map(parameters.map((parameter) => [parameter.name, parameter.value]));
  return query.replace(/@\w+/g, (name) => (values.has(name) ? JSON.stringify(values.get(name)) : name));
}

function stripSystemFields(document: Row): Row {
  return Object.fromEntries(Object.entries(document).filter(([field]) => !SYSTEM_FIELDS.has(field)));
}

/**
 * Cosmos DB documents are keyed by `id` within a partition. Upserts replace the whole
 * document, so a job writing to Cosmos DB must map every field the document needs.
 */
export class CosmosConnector implements Connector {
  private readonly client: CosmosClient;
  private readonly database: Database;
  private readonly partitionKeyPaths = new Map<string, string[]>();

  constructor(config: CosmosConfig) {
    this.client = new CosmosClient({
      endpoint: config.endpoint,
      key: config.key,
      // Only for the local emulator, which uses a self-signed certificate.
      agent: config.allowSelfSignedCert ? new Agent({ rejectUnauthorized: false }) : undefined,
    });
    this.database = this.client.database(config.database);
  }

  async ping(): Promise<void> {
    await this.database.read();
  }

  async close(): Promise<void> {
    this.client.dispose();
  }

  async listCollections(): Promise<CollectionInfo[]> {
    const { resources } = await this.database.containers.readAll().fetchAll();
    return resources
      .map((container) => ({ name: container.id, kind: 'container' as const }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async describeCollection(collection: string): Promise<FieldInfo[]> {
    // Cosmos DB has no random sampling; the first documents are a reasonable approximation.
    const { resources } = await this.container(collection)
      .items.query<Row>({ query: 'SELECT TOP @n * FROM c', parameters: [{ name: '@n', value: SAMPLE_SIZE }] })
      .fetchAll();
    return inferSchema(resources.map(stripSystemFields), ['id']);
  }

  async *readBatches(request: ReadRequest): AsyncIterable<Row[]> {
    const iterator = this.container(request.collection).items.query<Row>(querySpecFor(request), {
      maxItemCount: request.batchSize,
    });
    let read = 0;
    while (iterator.hasMoreResults() && !request.signal?.aborted) {
      const { resources } = await iterator.fetchNext();
      if (!resources || resources.length === 0) continue;
      const remaining = request.limit === undefined ? resources.length : request.limit - read;
      const rows = resources.slice(0, remaining).map(stripSystemFields);
      read += rows.length;
      yield rows;
      if (request.limit !== undefined && read >= request.limit) return;
    }
  }

  async count(collection: string, scope: SourceScope = {}): Promise<number> {
    const parameters: SqlParameter[] = [];
    const query = `SELECT VALUE COUNT(1) FROM c${whereClause(whereFor(scope.filters ?? [], parameters))}`;
    const { resources } = await this.container(collection).items.query<number>({ query, parameters }).fetchAll();
    return resources[0] ?? 0;
  }

  explainRead(request: ReadRequest): string {
    const text = describeQuerySpec(querySpecFor(request));
    return request.limit === undefined ? text : `${text}\n-- stops after ${request.limit} documents`;
  }

  explainFindByKeys(_collection: string, keyFields: string[], keys: Row[]): string {
    return describeQuerySpec(keyQuerySpec(keyFields, keys));
  }

  explainUpsert(collection: string, rows: Row[], _keyFields: string[]): string {
    if (rows.length === 0) return '// nothing to write';
    const calls = rows.map((row) => `container(${JSON.stringify(collection)}).items.upsert(${JSON.stringify(toDocument(row))})`);
    return [`// ${WRITE_CONCURRENCY} upserts at a time; each replaces the whole document with this id`, ...calls].join('\n');
  }

  async upsert(collection: string, rows: Row[], _keyFields: string[]): Promise<void> {
    const container = this.container(collection);
    const partitionPaths = await this.partitionPaths(collection);

    const documents = rows.map((row) => {
      const document = toDocument(row);
      for (const path of partitionPaths) {
        if (getPath(document, path) === undefined) {
          throw new ValidationError(`Document "${document.id}" is missing the partition key "${path}"`);
        }
      }
      return document;
    });

    await forEachWithConcurrency(documents, WRITE_CONCURRENCY, (document) => container.items.upsert(document));
  }

  async findByKeys(collection: string, keyFields: string[], keys: Row[]): Promise<Row[]> {
    if (keys.length === 0) return [];
    const { resources } = await this.container(collection).items.query<Row>(keyQuerySpec(keyFields, keys)).fetchAll();
    return resources.map(stripSystemFields);
  }

  private container(name: string): Container {
    return this.database.container(name);
  }

  /** Partition key paths as dotted paths, e.g. "/tenant/id" becomes "tenant.id". */
  private async partitionPaths(collection: string): Promise<string[]> {
    const cached = this.partitionKeyPaths.get(collection);
    if (cached) return cached;
    const { resource } = await this.container(collection).read();
    const paths = (resource?.partitionKey?.paths ?? []).map((path) => path.replace(/^\//, '').replace(/\//g, '.'));
    this.partitionKeyPaths.set(collection, paths);
    return paths;
  }
}
