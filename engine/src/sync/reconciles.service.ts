import { Injectable } from '@nestjs/common';
import { Job } from '../jobs/job.model';
import { ReconcileSummary, summarizeReconcile } from './reconcile.model';
import { ReconcilesRepository } from './reconciles.repository';
import { ReconcileReport, SyncService } from './sync.service';

/**
 * Runs a reconcile and keeps the counts of the latest one per job.
 * Summaries outlive their job, like run history.
 */
@Injectable()
export class ReconcilesService {
  constructor(
    private readonly reconciles: ReconcilesRepository,
    private readonly sync: SyncService,
  ) {}

  /** A failing reconcile throws before anything is saved, so the previous summary stays. */
  async reconcile(job: Job): Promise<ReconcileReport> {
    const report = await this.sync.reconcile(job);
    await this.reconciles.save({ id: job.id, ...summarizeReconcile(job.id, report) });
    return report;
  }

  async latestByJob(): Promise<Record<string, ReconcileSummary>> {
    const latest: Record<string, ReconcileSummary> = {};
    for (const { id: _id, ...summary } of await this.reconciles.list()) latest[summary.jobId] = summary;
    return latest;
  }
}
