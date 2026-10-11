import { Inject, Injectable } from '@nestjs/common';
import { AppError, UpstreamError, ValidationError, errorMessage } from '../common/errors';
import { getPath } from '../common/paths';
import { keyString, normalizeRecord, normalizeValue } from '../common/values';
import { Connector, ReadRequest, Row } from '../connectors/connector.types';
import { ConnectionView } from '../connections/connection.model';
import { ConnectionsService } from '../connections/connections.service';
import { Job, JobInput, Lookup, SourcePreviewInput, sourceScope } from '../jobs/job.model';
import { TransformRegistry } from '../transforms/transform.registry';
import { LookupEnricher, OpenLookup, readFields } from './lookup-enricher';
import { differingFields, displayKey } from './row-diff';
import { RecordingKeyReader } from './recording-key-reader';
import { RowMapper, sourceFieldsOf } from './row-mapper';
import { RunCancelledError } from './sync-runner';

/** All the pipeline needs from connections: open one by id. The app uses ConnectionsService; standalone scripts their own. */
export type ConnectionOpener = Pick<ConnectionsService, 'open'>;

export interface Pipeline {
  source: Connector;
  target: Connector;
  sourceConnection: ConnectionView;
  targetConnection: ConnectionView;
  mapper: RowMapper;
  enricher: LookupEnricher;
}

export interface PreviewResult {
  fields: string[];
  rows: Array<{ source: Row; target?: Row; error?: string }>;
  /** The statement(s) a run sends to write the first preview rows, or null when no row could be mapped. */
  writeStatement: string | null;
}

export interface LookupStatement {
  as: string;
  connection: string;
  collection: string;
  /** The query this lookup sends for the preview rows' keys, or null when they had no keys to look up. */
  statement: string | null;
  /** Distinct keys the lookup looked up for the preview rows. */
  keyCount: number;
}

export interface SourcePreviewResult {
  /** The read statement a run executes (first run for incremental jobs: no watermark value yet). */
  statement: string;
  /** The queries lookups send, in the order they run (once per batch during a run). */
  lookups: LookupStatement[];
  /** The first source rows with the job's conditions applied, every field, lookups attached, nothing mapped. */
  rows: Row[];
}

export interface FieldMismatch {
  key: string;
  field: string;
  expected: unknown;
  actual: unknown;
}

export interface ReconcileReport {
  checkedAt: string;
  sourceCount: number;
  targetCount: number;
  sampled: number;
  matched: number;
  missingCount: number;
  missingKeys: string[];
  mismatchedRows: number;
  mismatches: FieldMismatch[];
  unmappable: number;
}

const PREVIEW_ROWS = 10;
/** Enough keys (or rows) to show the shape of a lookup or write query without a wall of values. */
const KEYS_SHOWN = 3;
const RECONCILE_SAMPLE = 200;
const REPORT_LIMIT = 100;

/** Opens source and target for a job, checks they fit together, and offers preview and reconciliation. */
@Injectable()
export class SyncService {
  constructor(
    @Inject(ConnectionsService) private readonly connections: ConnectionOpener,
    private readonly transforms: TransformRegistry,
  ) {}

  async withPipeline<T>(job: JobInput, work: (pipeline: Pipeline) => Promise<T>): Promise<T> {
    // Compile first: a bad expression fails before any database is touched.
    const mapper = RowMapper.compile(job.mappings, this.transforms);
    const opened: Connector[] = [];
    const open = async (connectionId: string) => {
      const connection = await this.connections.open(connectionId);
      opened.push(connection.connector);
      return connection;
    };
    try {
      const source = await open(job.source.connectionId);
      const target = await open(job.target.connectionId);
      const lookups: Array<OpenLookup & { view: ConnectionView }> = [];
      for (const spec of job.lookups ?? []) {
        const connection = await open(spec.connectionId);
        lookups.push({ spec, reader: connection.connector, view: connection.view });
      }
      assertCompatible(job, source.view, target.view, lookups);
      return await work({
        source: source.connector,
        target: target.connector,
        sourceConnection: source.view,
        targetConnection: target.view,
        mapper,
        enricher: new LookupEnricher(lookups),
      });
    } catch (error) {
      throw asAppError(error);
    } finally {
      await Promise.allSettled(opened.map((connector) => connector.close()));
    }
  }

  /**
   * Source rows with lookups attached, and the queries a run sends, before a target or mappings exist.
   * Opens the source and lookup connections, never the target.
   */
  async previewSource(input: SourcePreviewInput): Promise<SourcePreviewResult> {
    const opened: Connector[] = [];
    const open = async (connectionId: string) => {
      const connection = await this.connections.open(connectionId);
      opened.push(connection.connector);
      return connection;
    };
    try {
      const source = await open(input.source.connectionId);
      assertSourceCompatible(input, source.view);
      const request: ReadRequest = {
        collection: input.source.collection,
        ...sourceScope(input.source),
        batchSize: PREVIEW_ROWS,
        fields: readFields(sourceFieldsOf(input.mappings), input.lookups ?? []),
        watermark: input.mode === 'incremental' && input.watermarkField ? { field: input.watermarkField } : undefined,
      };
      const rows: Row[] = [];
      // Every field, so people can see what the source offers before choosing.
      for await (const batch of source.connector.readBatches({ ...request, fields: undefined, limit: PREVIEW_ROWS })) {
        rows.push(...batch);
      }

      const lookups = [];
      for (const spec of input.lookups ?? []) {
        const connection = await open(spec.connectionId);
        lookups.push({ spec, view: connection.view, connector: connection.connector, reader: new RecordingKeyReader(connection.connector) });
      }
      assertLookupsCompatible(lookups);
      const enriched = await new LookupEnricher(lookups).enrich(rows);

      return {
        statement: source.connector.explainRead(request),
        lookups: lookups.map(({ spec, view, connector, reader }) => ({
          as: spec.as,
          connection: view.name,
          collection: spec.collection,
          statement: reader.firstCall
            ? connector.explainFindByKeys(spec.collection, reader.firstCall.keyFields, reader.firstCall.keys.slice(0, KEYS_SHOWN))
            : null,
          keyCount: reader.firstCall?.keys.length ?? 0,
        })),
        rows: enriched.map(({ row }) => normalizeRecord(row)),
      };
    } catch (error) {
      throw asAppError(error);
    } finally {
      await Promise.allSettled(opened.map((connector) => connector.close()));
    }
  }

  /** Maps the first rows of the source without writing anything. Works on unsaved jobs. */
  async preview(job: JobInput): Promise<PreviewResult> {
    return this.withPipeline(job, async ({ source, target, mapper, enricher }) => {
      const rows: PreviewResult['rows'] = [];
      const mapped: Row[] = [];
      const fields = mapper.sourceFields;
      for await (const batch of source.readBatches({
        collection: job.source.collection,
        ...sourceScope(job.source),
        batchSize: PREVIEW_ROWS,
        limit: PREVIEW_ROWS,
        fields: enricher.sourceFields(fields),
        // Same order as a first incremental run and the source preview, so all preview tabs show the same rows.
        watermark: job.mode === 'incremental' && job.watermarkField ? { field: job.watermarkField } : undefined,
      })) {
        for (const { row, error } of await enricher.enrich(batch)) {
          const sourceView = normalizeRecord(fields ? Object.fromEntries(fields.map((f) => [f, getPath(row, f)])) : row);
          if (error) {
            rows.push({ source: sourceView, error });
            continue;
          }
          try {
            const targetRow = mapper.map(row);
            mapped.push(targetRow);
            rows.push({ source: sourceView, target: normalizeRecord(targetRow) });
          } catch (error) {
            rows.push({ source: sourceView, error: errorMessage(error) });
          }
        }
      }
      const shown = mapped.slice(0, KEYS_SHOWN);
      const writeStatement = shown.length > 0 ? target.explainUpsert(job.target.collection, shown, job.target.keyFields) : null;
      return { fields: mapper.targetFields, rows, writeStatement };
    });
  }

  /**
   * Compares counts, then re-maps a sample of source rows and checks each one against the target.
   * The sample is the first rows in the source's natural order, which keeps the check fast and repeatable.
   */
  async reconcile(job: Job): Promise<ReconcileReport> {
    return this.withPipeline(job, async ({ source, target, mapper, enricher }) => {
      const [sourceCount, targetCount] = await Promise.all([
        source.count(job.source.collection, sourceScope(job.source)),
        target.count(job.target.collection),
      ]);

      const expected: Row[] = [];
      let unmappable = 0;
      for await (const batch of source.readBatches({
        collection: job.source.collection,
        ...sourceScope(job.source),
        batchSize: RECONCILE_SAMPLE,
        limit: RECONCILE_SAMPLE,
        fields: enricher.sourceFields(mapper.sourceFields),
      })) {
        for (const { row, error } of await enricher.enrich(batch)) {
          try {
            if (error) throw new Error(error);
            expected.push(mapper.map(row));
          } catch {
            unmappable += 1;
          }
        }
      }

      const keyFields = job.target.keyFields;
      const keyOf = (row: Row) => keyString(keyFields.map((field) => getPath(row, field)));
      const keys = expected.map((row) => Object.fromEntries(keyFields.map((field) => [field, row[field]])));
      const actualRows = await target.findByKeys(job.target.collection, keyFields, keys);
      const actualByKey = new Map(actualRows.map((row) => [keyOf(row), row]));

      const missingKeys: string[] = [];
      const mismatches: FieldMismatch[] = [];
      let matched = 0;
      let mismatchedRows = 0;

      for (const row of expected) {
        const key = displayKey(row, keyFields);
        const actual = actualByKey.get(keyOf(row));
        if (!actual) {
          missingKeys.push(key);
          continue;
        }
        const differences = differingFields(row, actual, mapper.targetFields).map((field) => ({
            key,
            field,
            expected: normalizeValue(row[field]),
            actual: normalizeValue(getPath(actual, field)),
          }));
        if (differences.length === 0) matched += 1;
        else {
          mismatchedRows += 1;
          mismatches.push(...differences);
        }
      }

      return {
        checkedAt: new Date().toISOString(),
        sourceCount,
        targetCount,
        sampled: expected.length,
        matched,
        missingCount: missingKeys.length,
        missingKeys: missingKeys.slice(0, REPORT_LIMIT),
        mismatchedRows,
        mismatches: mismatches.slice(0, REPORT_LIMIT),
        unmappable,
      };
    });
  }
}

function asAppError(error: unknown): Error {
  if (error instanceof AppError || error instanceof RunCancelledError) return error;
  return new UpstreamError(errorMessage(error), error);
}

/** Relational databases: they take SQL query sources and address columns, not nested paths. */
const SQL_KINDS = new Set<ConnectionView['kind']>(['postgres', 'mysql']);
const KIND_NAME: Record<ConnectionView['kind'], string> = { postgres: 'Postgres', mysql: 'MySQL', mongo: 'MongoDB', cosmos: 'Cosmos DB' };

/** Source rules that depend on the source database. */
function assertSourceCompatible(job: Pick<JobInput, 'source' | 'mode' | 'watermarkField'>, source: ConnectionView): void {
  if (job.source.query !== undefined && !SQL_KINDS.has(source.kind)) {
    throw new ValidationError('Custom SQL queries are only supported for PostgreSQL and MySQL sources');
  }
  if (source.kind === 'mongo' && job.source.filters?.some((filter) => filter.field === '_id')) {
    throw new ValidationError('Conditions on _id are not supported: _id is an ObjectId and would never equal a text value');
  }
  if (SQL_KINDS.has(source.kind)) {
    const nested = job.source.filters?.find((filter) => filter.field.includes('.'));
    if (nested) throw new ValidationError(`${KIND_NAME[source.kind]} conditions need a column name, got "${nested.field}"`);
    if (job.mode === 'incremental' && job.watermarkField?.includes('.')) {
      throw new ValidationError(`${KIND_NAME[source.kind]} watermarks must be a column name`);
    }
  }
}

/** Lookup rules that depend on the lookup database. */
function assertLookupsCompatible(lookups: ReadonlyArray<{ spec: Lookup; view: ConnectionView }>): void {
  for (const { spec, view } of lookups) {
    const nested = spec.on.find((pair) => pair.lookup.includes('.'));
    if (SQL_KINDS.has(view.kind) && nested) {
      throw new ValidationError(`Lookup "${spec.as}": ${KIND_NAME[view.kind]} tables are matched on column names, got "${nested.lookup}"`);
    }
  }
}

/** Rules that depend on which databases a job connects, so they cannot live in the job schema. */
function assertCompatible(
  job: JobInput,
  source: ConnectionView,
  target: ConnectionView,
  lookups: ReadonlyArray<{ spec: Lookup; view: ConnectionView }>,
): void {
  assertSourceCompatible(job, source);
  assertLookupsCompatible(lookups);
  if (source.id === target.id && job.source.collection === job.target.collection) {
    throw new ValidationError('Source and target are the same collection');
  }
  if (SQL_KINDS.has(target.kind)) {
    const nested = job.mappings.find((mapping) => mapping.to.includes('.'));
    if (nested) throw new ValidationError(`${KIND_NAME[target.kind]} targets need plain column names, got "${nested.to}"`);
  }
  if (target.kind === 'cosmos' && (job.target.keyFields.length !== 1 || job.target.keyFields[0] !== 'id')) {
    throw new ValidationError('Cosmos DB targets are matched on the document id: map a field to "id" and make it the only key');
  }
}
