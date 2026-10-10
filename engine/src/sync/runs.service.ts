import { randomBytes } from 'node:crypto';
import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ConflictError, NotFoundError, errorMessage } from '../common/errors';
import { Job } from '../jobs/job.model';
import { JobsService } from '../jobs/jobs.service';
import { RunLocks } from '../jobs/run-locks';
import { RunRecord, RunSummary, summarize } from './run.model';
import { RunsRepository } from './runs.repository';
import { dryRunWriterFor } from './dry-run-writer';
import { LogLevel, SyncRunner } from './sync-runner';
import { SyncService } from './sync.service';

const PERSIST_INTERVAL_MS = 1_000;
const MAX_LOG_ENTRIES = 200;
const MAX_FAILURES_KEPT = 500;
const RUNS_KEPT_PER_JOB = 30;

interface ActiveRun {
  run: RunRecord;
  controller: AbortController;
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

  /** Starts a run in the background. A dry run starts from the saved watermark too, but never moves it. */
  async start(jobId: string, options: { dryRun?: boolean } = {}): Promise<RunRecord> {
    if (!this.locks.tryAcquire(jobId)) throw new ConflictError('This job is already running');
    try {
      const job = await this.jobs.get(jobId);
      const watermark = job.mode === 'incremental' ? await this.jobs.getWatermark(job.id) : null;
      const run = this.createRecord(job, watermark, { dryRun: options.dryRun === true });
      const controller = new AbortController();
      await this.runs.save(run);
      this.active.set(run.id, { run, controller });
      void this.execute(job, run, controller.signal);
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
   * Most recent real run per job, for job overviews: a finished dry run says nothing about the target.
   * A dry run in progress still counts, so overviews show the job as busy.
   */
  async latestByJob(): Promise<Record<string, RunSummary>> {
    const latest: Record<string, RunSummary> = {};
    for (const run of await this.allRuns()) {
      if (!run.dryRun || run.status === 'running') latest[run.jobId] ??= summarize(run);
    }
    return latest;
  }

  /** Newest first, with live in-memory state for runs in progress. */
  private async allRuns(): Promise<RunRecord[]> {
    const stored = await this.runs.list();
    return stored
      .map((run) => this.active.get(run.id)?.run ?? run)
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  private createRecord(job: Job, watermark: RunRecord['watermarkFrom'], { dryRun }: { dryRun: boolean }): RunRecord {
    return {
      id: `run-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`,
      jobId: job.id,
      jobName: job.name,
      mode: job.mode,
      ...(dryRun && { dryRun: true }),
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
  private async execute(job: Job, run: RunRecord, signal: AbortSignal): Promise<void> {
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

    try {
      log('info', `Started ${run.dryRun ? 'dry ' : ''}${job.mode} run from ${job.source.collection} to ${job.target.collection}`);
      if (run.dryRun) log('info', 'Dry run: rows are read, mapped and compared with the target; nothing is written.');
      const { stats } = await this.sync.withPipeline(job, (pipeline) => {
        const dryRunWriter = run.dryRun ? dryRunWriterFor(pipeline) : undefined;
        if (dryRunWriter) run.plan = dryRunWriter.report;
        return this.runner.run({
          job,
          source: pipeline.source,
          target: dryRunWriter ?? pipeline.target,
          mapper: pipeline.mapper,
          enricher: pipeline.enricher,
          from: run.watermarkFrom,
          signal,
          hooks: {
            log,
            onBatchWritten: async (batchStats, checkpoint) => {
              run.stats = batchStats;
              if (job.mode === 'incremental' && checkpoint && !run.dryRun) {
                // Saved after every batch, so a failed run resumes where it stopped.
                run.watermarkTo = checkpoint;
                await this.jobs.saveWatermark(job.id, checkpoint);
              }
              await persist();
            },
            onRowFailed: (failure) => {
              if (run.failures!.length < MAX_FAILURES_KEPT) run.failures!.push(failure);
            },
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
      if (stats.skipped > 0 && job.mode === 'incremental' && !run.dryRun) {
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
