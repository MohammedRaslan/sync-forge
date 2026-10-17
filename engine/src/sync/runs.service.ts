import { randomBytes } from 'node:crypto';
import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ConflictError, NotFoundError, ValidationError, errorMessage } from '../common/errors';
import { keyString } from '../common/values';
import { Job } from '../jobs/job.model';
import { JobsService } from '../jobs/jobs.service';
import { RunLocks } from '../jobs/run-locks';
import { RunRecord, RunSummary, summarize } from './run.model';
import { RunsRepository } from './runs.repository';
import { dryRunWriterFor } from './dry-run-writer';
import { KeyedRowsReader, MissingKey } from './keyed-rows-reader';
import { displayKey } from './row-diff';
import { SourceKey, sourceKeyFields } from './source-key';
import { LogLevel, RowFailure, RowSource, SyncRunner } from './sync-runner';
import { Pipeline, SyncService, assertSourceKeyReadable } from './sync.service';

const PERSIST_INTERVAL_MS = 1_000;
const MAX_LOG_ENTRIES = 200;
const MAX_FAILURES_KEPT = 500;
const RUNS_KEPT_PER_JOB = 30;
/** Keys named in the log line about rows a retry no longer found; all of them are listed with the run. */
const MISSING_KEYS_LOGGED = 10;

interface ActiveRun {
  run: RunRecord;
  controller: AbortController;
}

export interface StartOptions {
  /** Read, map and compare, but write nothing. */
  dryRun?: boolean;
  /** The id of an earlier run of the same job whose failed rows are read again by their source keys. */
  retryOf?: string;
}

/** What a retry reads: the source keys of an earlier run's failed rows. */
interface RetryPlan {
  of: RunRecord;
  /** The job's source key fields (`sourceKeyFields`). */
  fields: string[];
  /** Distinct source keys in the order their rows failed, with the target key the failure showed, if any. */
  rows: Array<{ sourceKey: SourceKey; key: string | null }>;
  /** Failures that cannot be retried: no source key, or one of other source fields than the job has now. */
  unusable: number;
  /** Failed rows the earlier run counted but did not keep, because its list is capped. */
  notKept: number;
}

/**
 * Starts runs in the background, tracks them while they execute, and keeps their history.
 * A run in progress lives in memory (and is flushed to disk about once a second),
 * so polling clients see live progress without hammering the file system.
 */
@Injectable()
export class RunsService implements OnApplicationBootstrap {
  private readonly logger = new Logger(RunsService.name);
  private readonly active = new Map<string, ActiveRun>();

  constructor(
    private readonly runs: RunsRepository,
    private readonly jobs: JobsService,
    private readonly locks: RunLocks,
    private readonly sync: SyncService,
    private readonly runner: SyncRunner,
  ) {}

  /** Runs interrupted by a restart would otherwise show as running forever. */
  async onApplicationBootstrap(): Promise<void> {
    for (const run of await this.runs.list()) {
      if (run.status !== 'running') continue;
      run.status = 'failed';
      run.error = 'The engine stopped while this run was in progress';
      run.finishedAt = run.finishedAt ?? new Date().toISOString();
      await this.runs.save(run);
    }
  }

  /**
   * Starts a run in the background. A dry run starts from the saved watermark too, but never moves it.
   * A retry (`retryOf`) reads only the failed rows of an earlier run, by their source keys, and never reads or
   * moves the watermark. Everything else (lookups, the job's current mappings, the error policy) is as in a normal run.
   */
  async start(jobId: string, options: StartOptions = {}): Promise<RunRecord> {
    if (options.dryRun && options.retryOf !== undefined) {
      throw new ValidationError('A dry run cannot re-run failed rows: start one or the other');
    }
    if (!this.locks.tryAcquire(jobId)) throw new ConflictError('This job is already running');
    try {
      const job = await this.jobs.get(jobId);
      const retry = options.retryOf === undefined ? undefined : await this.retryPlanFor(job, options.retryOf);
      const watermark = job.mode === 'incremental' && !retry ? await this.jobs.getWatermark(job.id) : null;
      const run = this.createRecord(job, watermark, { dryRun: options.dryRun === true, retryOf: retry?.of.id });
      const controller = new AbortController();
      await this.runs.save(run);
      this.active.set(run.id, { run, controller });
      void this.execute(job, run, controller.signal, retry);
      return run;
    } catch (error) {
      this.locks.release(jobId);
      throw error;
    }
  }

  async cancel(runId: string): Promise<RunRecord> {
    const active = this.active.get(runId);
    if (active) {
      active.controller.abort();
      return active.run;
    }
    await this.get(runId);
    throw new ConflictError('This run has already finished');
  }

  async get(runId: string): Promise<RunRecord> {
    const run = this.active.get(runId)?.run ?? (await this.runs.get(runId));
    if (!run) throw new NotFoundError(`Run "${runId}" does not exist`);
    return run;
  }

  async listForJob(jobId: string): Promise<RunSummary[]> {
    return (await this.allRuns()).filter((run) => run.jobId === jobId).map(summarize);
  }

  /**
   * Most recent real run per job, for job overviews: a finished dry run says nothing about the target, and a
   * finished retry covers only some rows, so the run it retried still describes the job. Either one in progress
   * still counts, so overviews show the job as busy.
   */
  async latestByJob(): Promise<Record<string, RunSummary>> {
    const latest: Record<string, RunSummary> = {};
    for (const run of await this.allRuns()) {
      const coversJob = !run.dryRun && run.retryOf === undefined;
      if (coversJob || run.status === 'running') latest[run.jobId] ??= summarize(run);
    }
    return latest;
  }

  /** Checks that `runId` can be retried for this job and collects the source keys of its failed rows. */
  private async retryPlanFor(job: Job, runId: string): Promise<RetryPlan> {
    const of = await this.get(runId);
    if (of.jobId !== job.id) throw new ValidationError(`Run "${runId}" belongs to another job`);
    if (of.status === 'running') throw new ConflictError(`Run "${runId}" is still in progress; re-run its failed rows when it has finished`);
    if (of.dryRun) throw new ValidationError("A dry run writes nothing, so its failed rows can't be re-run: start a run instead");
    const failures = of.failures ?? [];
    if (failures.length === 0) throw new ValidationError(`Run "${runId}" has no failed rows to re-run`);
    const keyFields = sourceKeyFields(job);
    if ('reason' in keyFields) throw new ValidationError(`Failed rows can't be re-run: ${keyFields.reason}`);
    const { fields } = keyFields;

    const rows = new Map<string, RetryPlan['rows'][number]>();
    let unusable = 0;
    for (const { sourceKey, key } of failures) {
      if (!sourceKey || !hasExactly(sourceKey, fields)) unusable += 1;
      else rows.set(keyString(fields.map((field) => sourceKey[field])), { sourceKey, key });
    }
    if (rows.size === 0) {
      throw new ValidationError(
        `None of the ${failures.length} failed rows of run "${runId}" can be re-run: ${NO_SOURCE_KEY}`,
      );
    }
    // `read` failures are not counted as skipped (they were never read), so they do not count against the cap.
    const kept = failures.filter((failure) => failure.stage !== 'read').length;
    return { of, fields, rows: [...rows.values()], unusable, notKept: Math.max(0, of.stats.skipped - kept) };
  }

  /** Newest first, with live in-memory state for runs in progress. */
  private async allRuns(): Promise<RunRecord[]> {
    const stored = await this.runs.list();
    return stored
      .map((run) => this.active.get(run.id)?.run ?? run)
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  private createRecord(
    job: Job,
    watermark: RunRecord['watermarkFrom'],
    { dryRun, retryOf }: { dryRun: boolean; retryOf?: string },
  ): RunRecord {
    return {
      id: `run-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`,
      jobId: job.id,
      jobName: job.name,
      mode: job.mode,
      ...(dryRun && { dryRun: true }),
      ...(retryOf !== undefined && { retryOf }),
      status: 'running',
      startedAt: new Date().toISOString(),
      finishedAt: null,
      stats: { read: 0, written: 0, skipped: 0, batches: 0 },
      watermarkFrom: watermark,
      watermarkTo: watermark,
      error: null,
      log: [],
      failures: [],
    };
  }

  /** Never throws: every outcome is recorded on the run. */
  private async execute(job: Job, run: RunRecord, signal: AbortSignal, retry?: RetryPlan): Promise<void> {
    let lastPersisted = 0;
    const persist = async (force = false): Promise<void> => {
      if (!force && Date.now() - lastPersisted < PERSIST_INTERVAL_MS) return;
      lastPersisted = Date.now();
      await this.runs.save(run).catch((error) => this.logger.warn(`Could not save run ${run.id}: ${errorMessage(error)}`));
    };
    const log = (level: LogLevel, message: string): void => {
      run.log.push({ at: new Date().toISOString(), level, message });
      if (run.log.length > MAX_LOG_ENTRIES) run.log.splice(0, run.log.length - MAX_LOG_ENTRIES);
    };

    const recordFailure = (failure: RowFailure): void => {
      if (run.failures!.length < MAX_FAILURES_KEPT) run.failures!.push(failure);
    };
    const savesWatermark = job.mode === 'incremental' && !run.dryRun && !retry;

    try {
      if (retry) logRetryStart(retry, log);
      else log('info', `Started ${run.dryRun ? 'dry ' : ''}${job.mode} run from ${job.source.collection} to ${job.target.collection}`);
      if (run.dryRun) log('info', 'Dry run: rows are read, mapped and compared with the target; nothing is written.');
      const { stats } = await this.sync.withPipeline(job, (pipeline) => {
        const dryRunWriter = run.dryRun ? dryRunWriterFor(pipeline) : undefined;
        if (dryRunWriter) run.plan = dryRunWriter.report;
        return this.runner.run({
          // A retry reads rows by key, not in watermark order: as a full run, the runner neither reads nor checkpoints a watermark.
          job: retry ? { ...job, mode: 'full' } : job,
          source: retry ? retryReader(retry, pipeline, log, recordFailure) : pipeline.source,
          target: dryRunWriter ?? pipeline.target,
          mapper: pipeline.mapper,
          enricher: pipeline.enricher,
          from: run.watermarkFrom,
          signal,
          hooks: {
            log,
            onBatchWritten: async (batchStats, checkpoint) => {
              run.stats = batchStats;
              if (savesWatermark && checkpoint) {
                // Saved after every batch, so a failed run resumes where it stopped.
                run.watermarkTo = checkpoint;
                await this.jobs.saveWatermark(job.id, checkpoint);
              }
              await persist();
            },
            onRowFailed: recordFailure,
          },
        });
      });
      run.status = 'succeeded';
      if (run.plan) {
        const { inserts, updates, unchanged } = run.plan;
        log('info', `Dry run finished: ${stats.read} read, would insert ${inserts}, update ${updates}, leave ${unchanged} unchanged, skip ${stats.skipped}`);
      } else {
        log('info', `Finished: ${stats.read} read, ${stats.written} written, ${stats.skipped} skipped`);
      }
      if (stats.skipped > 0 && savesWatermark) {
        log('warn', 'Skipped rows are behind the watermark now. Fix them and reset the watermark to retry them.');
      }
    } catch (error) {
      if (signal.aborted) {
        run.status = 'cancelled';
        log('warn', 'Cancelled. Rows written so far are kept.');
      } else {
        run.status = 'failed';
        run.error = errorMessage(error);
        log('error', run.error);
      }
    } finally {
      run.finishedAt = new Date().toISOString();
      await persist(true);
      this.active.delete(run.id);
      this.locks.release(job.id);
      await this.prune(job.id).catch((error) => this.logger.warn(`Could not prune runs: ${errorMessage(error)}`));
    }
  }

  private async prune(jobId: string): Promise<void> {
    const runs = (await this.allRuns()).filter((run) => run.jobId === jobId && run.status !== 'running');
    await Promise.all(runs.slice(RUNS_KEPT_PER_JOB).map((run) => this.runs.delete(run.id)));
  }
}

const NO_SOURCE_KEY =
  'they were recorded by an older version, before their source key was known (an empty key, or one that is neither text nor a number), or with other key fields than the job has now';

function hasExactly(key: SourceKey, fields: readonly string[]): boolean {
  return Object.keys(key).length === fields.length && fields.every((field) => Object.hasOwn(key, field));
}

function logRetryStart(retry: RetryPlan, log: (level: LogLevel, message: string) => void): void {
  const { of, rows, unusable, notKept } = retry;
  const startedAt = `${of.startedAt.slice(0, 16).replace('T', ' ')} UTC`;
  log('info', `Retrying ${rows.length} failed rows of run ${of.id} from ${startedAt}, read again from the source by ${retry.fields.join(', ')}`);
  if (unusable > 0) log('warn', `${unusable} failed rows cannot be retried: ${NO_SOURCE_KEY}`);
  if (notKept > 0) {
    log('warn', `${notKept} more rows failed in that run but were not kept with it (it keeps the first ${MAX_FAILURES_KEPT}); run the job again to cover them`);
  }
}

/** Reads the retried rows from the source; keys it no longer finds are logged and listed as `read` failures. */
function retryReader(
  retry: RetryPlan,
  pipeline: Pipeline,
  log: (level: LogLevel, message: string) => void,
  recordFailure: (failure: RowFailure) => void,
): RowSource {
  assertSourceKeyReadable(retry.fields, pipeline.sourceConnection);
  const onMissing = (missing: MissingKey[]): void => {
    const named = missing.slice(0, MISSING_KEYS_LOGGED).map(({ key }) => displayKey(key, retry.fields));
    const more = missing.length > MISSING_KEYS_LOGGED ? ` and ${missing.length - MISSING_KEYS_LOGGED} more` : '';
    log('warn', `${missing.length} rows are no longer in the source: ${named.join(', ')}${more}`);
    for (const { position, key } of missing) {
      recordFailure({ row: position, key: retry.rows[position - 1].key, stage: 'read', reason: 'No longer in the source', sourceKey: key });
    }
  };
  return new KeyedRowsReader(pipeline.source, retry.fields, retry.rows.map(({ sourceKey }) => sourceKey), onMissing);
}
