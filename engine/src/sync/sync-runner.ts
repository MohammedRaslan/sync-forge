import { Injectable } from '@nestjs/common';
import { errorMessage } from '../common/errors';
import { getPath } from '../common/paths';
import { keyString, normalizeRecord } from '../common/values';
import { DataReader, DataWriter, Row } from '../connectors/connector.types';
import { Job, sourceScope } from '../jobs/job.model';
import { LookupEnricher } from './lookup-enricher';
import { displayKey } from './row-diff';
import { RowMapper } from './row-mapper';
import { LEGACY_DATE_WATERMARK_SHIFT_HOURS, StoredWatermark, toStoredWatermark, upgradedWatermark } from './watermark';

export interface RunStats {
  read: number;
  written: number;
  skipped: number;
  batches: number;
}

export type LogLevel = 'info' | 'warn' | 'error';

/** A row the run could not sync, kept so people can see which rows and why. */
export interface RowFailure {
  /** Position in this run's read order, starting at 1. */
  row: number;
  /** Key values, once the row was mapped far enough to have them. */
  key: string | null;
  stage: 'lookup' | 'map' | 'write';
  reason: string;
  /** The row as it was to be written (write failures only). */
  values?: Row;
}

export interface RunHooks {
  log(level: LogLevel, message: string): void;
  /**
   * Called after every written batch with the watermark of the last row read so far, and once after a run
   * that read nothing but moved an older engine's watermark back (see `upgradedWatermark`).
   */
  onBatchWritten(stats: RunStats, checkpoint: StoredWatermark | null): Promise<void>;
  /** Called once per row that is finally given up on (only with the "skip" error policy). */
  onRowFailed(failure: RowFailure): void;
}

export interface RunRequest {
  job: Job;
  source: DataReader;
  target: DataWriter;
  mapper: RowMapper;
  enricher: LookupEnricher;
  from: StoredWatermark | null;
  signal: AbortSignal;
  hooks: RunHooks;
}

export class RunCancelledError extends Error {
  constructor() {
    super('Run cancelled');
    this.name = 'RunCancelledError';
  }
}

const MAX_LOGGED_ROW_ERRORS = 20;
const LEGACY_START_NOTE = ` (watermark saved by an older version: starting ${LEGACY_DATE_WATERMARK_SHIFT_HOURS} h earlier to be safe)`;

/**
 * Executes one job: read batch → look up → map → de-duplicate → upsert → checkpoint, until the
 * source is exhausted. It knows nothing about HTTP, storage or specific databases.
 */
@Injectable()
export class SyncRunner {
  async run(request: RunRequest): Promise<{ stats: RunStats; watermark: StoredWatermark | null }> {
    const { job, source, target, mapper, enricher, signal, hooks } = request;
    const watermarkField = job.mode === 'incremental' ? job.watermarkField : undefined;
    const keyFields = job.target.keyFields;
    const stats: RunStats = { read: 0, written: 0, skipped: 0, batches: 0 };
    const skipBadRows = job.errorPolicy === 'skip';
    const startFrom = watermarkField && request.from ? upgradedWatermark(request.from) : null;
    // A watermark from an older engine starts earlier; saving the moved-back value keeps it from moving again.
    const movedBack = startFrom !== null && startFrom !== request.from;
    let watermark = startFrom;
    let loggedErrors = 0;
    /** Rows whose write failed; each gets one more try after the last batch. */
    const retryLater: Array<{ number: number; row: Row }> = [];

    const warn = (message: string) => {
      if (loggedErrors < MAX_LOGGED_ROW_ERRORS) hooks.log('warn', message);
      else if (loggedErrors === MAX_LOGGED_ROW_ERRORS) hooks.log('warn', 'More rows failed; they are listed with the run but not logged.');
      loggedErrors += 1;
    };

    if (watermarkField) {
      hooks.log(
        'info',
        watermark
          ? `Reading rows where ${watermarkField} >= ${watermark.value}${movedBack ? LEGACY_START_NOTE : ''}`
          : `No watermark yet: reading every row ordered by ${watermarkField}`,
      );
    }

    const batches = source.readBatches({
      collection: job.source.collection,
      ...sourceScope(job.source),
      batchSize: job.batchSize,
      fields: enricher.sourceFields(mapper.sourceFields),
      watermark: watermarkField ? { field: watermarkField, from: watermark ?? undefined } : undefined,
      signal,
    });

    for await (const batch of batches) {
      throwIfCancelled(signal);
      const firstRowNumber = stats.read + 1;
      stats.read += batch.length;

      const mapped: Row[] = [];
      const rowNumbers = new Map<Row, number>();
      (await enricher.enrich(batch)).forEach(({ row, error }, index) => {
        const number = firstRowNumber + index;
        const stage = error ? 'lookup' : 'map';
        try {
          if (error) throw new Error(error);
          const result = mapRow(row, mapper, keyFields);
          rowNumbers.set(result, number);
          mapped.push(result);
        } catch (caught) {
          const reason = errorMessage(caught);
          if (!skipBadRows) throw new Error(`Row ${number}: ${reason}`);
          stats.skipped += 1;
          warn(`Row ${number}: ${reason}`);
          hooks.onRowFailed({ row: number, key: null, stage, reason });
        }
      });

      const rows = dedupeByKey(mapped, keyFields);
      if (skipBadRows) {
        const failed = await upsertIsolatingFailures(target, job.target.collection, rows, keyFields, signal);
        stats.written += rows.length - failed.length;
        for (const { row, reason } of failed) {
          const number = rowNumbers.get(row)!;
          stats.skipped += 1;
          warn(`Row ${number} (${displayKey(row, keyFields)}): ${reason}. It will be retried once at the end.`);
          retryLater.push({ number, row });
        }
      } else {
        if (rows.length > 0) await target.upsert(job.target.collection, rows, keyFields);
        stats.written += rows.length;
      }
      stats.batches += 1;

      if (watermarkField) watermark = lastWatermark(batch, watermarkField) ?? watermark;
      await hooks.onBatchWritten({ ...stats }, watermark);
    }

    throwIfCancelled(signal);
    // Without a batch nothing was checkpointed: save the moved-back start, so the next run does not shift again.
    if (movedBack && stats.batches === 0) await hooks.onBatchWritten({ ...stats }, watermark);

    if (retryLater.length > 0) {
      // A second chance fixes failures caused by order, e.g. a foreign key to a row from a later batch.
      hooks.log('info', `Retrying ${retryLater.length} rows that could not be written`);
      let stillFailing = 0;
      for (const { number, row } of retryLater) {
        throwIfCancelled(signal);
        try {
          await target.upsert(job.target.collection, [row], keyFields);
          stats.written += 1;
          stats.skipped -= 1;
        } catch (error) {
          stillFailing += 1;
          hooks.onRowFailed({
            row: number,
            key: displayKey(row, keyFields),
            stage: 'write',
            reason: errorMessage(error),
            values: normalizeRecord(row),
          });
        }
      }
      hooks.log(
        stillFailing === 0 ? 'info' : 'warn',
        stillFailing === 0
          ? `All ${retryLater.length} rows were written on retry`
          : `${stillFailing} of ${retryLater.length} rows still could not be written; they are listed with the run`,
      );
      await hooks.onBatchWritten({ ...stats }, watermark);
    }

    return { stats, watermark };
  }
}

/**
 * Writes a batch; if that fails, writes its rows one at a time so one bad row does not stop
 * the others. Returns the rows that still failed. Safe because every write is an idempotent upsert.
 */
async function upsertIsolatingFailures(
  target: DataWriter,
  collection: string,
  rows: Row[],
  keyFields: string[],
  signal: AbortSignal,
): Promise<Array<{ row: Row; reason: string }>> {
  if (rows.length === 0) return [];
  try {
    await target.upsert(collection, rows, keyFields);
    return [];
  } catch (batchError) {
    if (rows.length === 1) return [{ row: rows[0], reason: errorMessage(batchError) }];
  }
  const failed: Array<{ row: Row; reason: string }> = [];
  for (const row of rows) {
    throwIfCancelled(signal);
    try {
      await target.upsert(collection, [row], keyFields);
    } catch (error) {
      failed.push({ row, reason: errorMessage(error) });
    }
  }
  return failed;
}

function throwIfCancelled(signal: AbortSignal): void {
  if (signal.aborted) throw new RunCancelledError();
}

function mapRow(row: Row, mapper: RowMapper, keyFields: readonly string[]): Row {
  const mapped = mapper.map(row);
  for (const key of keyFields) {
    if (mapped[key] === null || mapped[key] === undefined || mapped[key] === '') {
      throw new Error(`key field "${key}" is empty`);
    }
  }
  return mapped;
}

/**
 * A batch may contain the same key twice (e.g. two source rows mapping to one target row).
 * Postgres rejects that within one statement, and it is ambiguous anyway: the last row wins.
 */
export function dedupeByKey(rows: readonly Row[], keyFields: readonly string[]): Row[] {
  const byKey = new Map<string, Row>();
  for (const row of rows) byKey.set(keyString(keyFields.map((field) => row[field])), row);
  return [...byKey.values()];
}

/** Rows arrive in watermark order, so the last non-empty value is the checkpoint. */
function lastWatermark(batch: readonly Row[], field: string): StoredWatermark | null {
  for (let index = batch.length - 1; index >= 0; index -= 1) {
    const watermark = toStoredWatermark(getPath(batch[index], field));
    if (watermark) return watermark;
  }
  return null;
}
