import { Job } from '../../src/jobs/job.model';
import { JobsService } from '../../src/jobs/jobs.service';
import { RunLocks } from '../../src/jobs/run-locks';
import { RunRecord } from '../../src/sync/run.model';
import { RunsRepository } from '../../src/sync/runs.repository';
import { RunsService } from '../../src/sync/runs.service';
import { SyncRunner } from '../../src/sync/sync-runner';
import { SyncService } from '../../src/sync/sync.service';
import { StoredWatermark } from '../../src/sync/watermark';

/**
 * A RunsService on a real SyncService, with run history and job state in memory instead of the workspace.
 * `current.job` is what the jobs stub returns, so a test can fix a job between runs.
 */
export function runsHarness(sync: SyncService, job: Job) {
  const current = { job };
  let watermark: StoredWatermark | null = null;
  const savedWatermarks: StoredWatermark[] = [];
  const records = new Map<string, RunRecord>();
  const jobs = {
    get: async () => current.job,
    getWatermark: async () => watermark,
    saveWatermark: async (_id: string, value: StoredWatermark) => {
      watermark = value;
      savedWatermarks.push(value);
    },
  } as unknown as JobsService;
  const runs = {
    save: async (run: RunRecord) => void records.set(run.id, structuredClone(run)),
    list: async () => [...records.values()],
    get: async (id: string) => records.get(id),
    delete: async (id: string) => records.delete(id),
  } as unknown as RunsRepository;
  const service = new RunsService(runs, jobs, new RunLocks(), sync, new SyncRunner());

  /** Starts a run and waits for it to finish. */
  const runToEnd = async (options: { retryOf?: string } = {}): Promise<RunRecord> => {
    const { id } = await service.start(current.job.id, options);
    for (let attempt = 0; attempt < 600; attempt += 1) {
      const run = await service.get(id);
      if (run.status !== 'running') return run;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error('run did not finish');
  };
  return { current, savedWatermarks, runToEnd };
}
