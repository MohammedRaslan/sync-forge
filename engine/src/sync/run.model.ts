import { DryRunReport } from './dry-run-writer';
import { LogLevel, RowFailure, RunStats } from './sync-runner';
import { StoredWatermark } from './watermark';

export type RunStatus = 'running' | 'succeeded' | 'failed' | 'cancelled';

export interface RunLogEntry {
  at: string;
  level: LogLevel;
  message: string;
}

export interface RunRecord {
  id: string;
  jobId: string;
  jobName: string;
  mode: 'full' | 'incremental';
  /** A dry run reads, maps and compares, but never writes or moves the watermark. Missing on older runs. */
  dryRun?: boolean;
  status: RunStatus;
  startedAt: string;
  finishedAt: string | null;
  stats: RunStats;
  watermarkFrom: StoredWatermark | null;
  watermarkTo: StoredWatermark | null;
  error: string | null;
  log: RunLogEntry[];
  /** Rows given up on with the "skip" policy, oldest first. Capped; `stats.skipped` has the full count. Missing on older runs. */
  failures?: RowFailure[];
  /** What a dry run found (dry runs only). */
  plan?: DryRunReport;
}

export type RunSummary = Omit<RunRecord, 'log' | 'failures' | 'plan'>;

export function summarize({ log: _log, failures: _failures, plan: _plan, ...summary }: RunRecord): RunSummary {
  return summary;
}
