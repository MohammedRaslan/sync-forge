import { ReconcileReport } from './sync.service';

/**
 * Counts from a job's latest reconcile, kept so overviews can show it without re-checking.
 * Deliberately without missing keys or mismatched values: those are customer data.
 */
export interface ReconcileSummary {
  jobId: string;
  checkedAt: string;
  sourceCount: number;
  targetCount: number;
  sampled: number;
  matched: number;
  missingCount: number;
  mismatchedRows: number;
  unmappable: number;
}

/** A summary as stored: one file per job, named by the job id. */
export interface StoredReconcileSummary extends ReconcileSummary {
  id: string;
}

/** Keeps only the counts of a report; keys and row values are dropped. */
export function summarizeReconcile(jobId: string, report: ReconcileReport): ReconcileSummary {
  const { checkedAt, sourceCount, targetCount, sampled, matched, missingCount, mismatchedRows, unmappable } = report;
  return { jobId, checkedAt, sourceCount, targetCount, sampled, matched, missingCount, mismatchedRows, unmappable };
}
