import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Job } from '../src/jobs/job.model';
import { ReconcilesRepository } from '../src/sync/reconciles.repository';
import { ReconcilesService } from '../src/sync/reconciles.service';
import { ReconcileReport, SyncService } from '../src/sync/sync.service';

const job = { id: 'job-1', name: 'Orders' } as Job;

function makeReport(overrides: Partial<ReconcileReport> = {}): ReconcileReport {
  return {
    checkedAt: '2026-10-14T10:00:00.000Z',
    sourceCount: 120,
    targetCount: 118,
    sampled: 100,
    matched: 95,
    missingCount: 2,
    missingKeys: ['id=secret-customer-7', 'id=secret-customer-9'],
    mismatchedRows: 3,
    mismatches: [{ key: 'id=secret-customer-3', field: 'email', expected: 'jane@example.com', actual: 'old@example.com' }],
    unmappable: 0,
    ...overrides,
  };
}

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function setup(reports: Array<ReconcileReport | Error>) {
  const dir = await mkdtemp(join(tmpdir(), 'syncforge-reconciles-'));
  dirs.push(dir);
  const sync = {
    reconcile: async () => {
      const next = reports.shift();
      if (!next || next instanceof Error) throw next ?? new Error('no report left');
      return next;
    },
  } as unknown as SyncService;
  return { dir, service: new ReconcilesService(new ReconcilesRepository(dir), sync) };
}

describe('ReconcilesService', () => {
  it('stores the counts of a reconcile under the job id, without keys or row values', async () => {
    const { dir, service } = await setup([makeReport()]);
    const report = await service.reconcile(job);

    expect(report.missingKeys).toHaveLength(2);
    const stored = await readFile(join(dir, 'job-1.json'), 'utf8');
    expect(stored).not.toContain('secret-customer');
    expect(stored).not.toContain('example.com');
    expect((await service.latestByJob())['job-1']).toEqual({
      jobId: 'job-1',
      checkedAt: '2026-10-14T10:00:00.000Z',
      sourceCount: 120,
      targetCount: 118,
      sampled: 100,
      matched: 95,
      missingCount: 2,
      mismatchedRows: 3,
      unmappable: 0,
    });
  });

  it('replaces the summary on the next reconcile of the same job', async () => {
    const { service } = await setup([
      makeReport(),
      makeReport({ checkedAt: '2026-10-14T11:00:00.000Z', targetCount: 120, matched: 100, missingCount: 0, mismatchedRows: 0 }),
    ]);
    await service.reconcile(job);
    await service.reconcile(job);

    expect(await service.latestByJob()).toEqual({
      'job-1': expect.objectContaining({ checkedAt: '2026-10-14T11:00:00.000Z', matched: 100, missingCount: 0 }),
    });
  });

  it('keeps the previous summary when a reconcile fails', async () => {
    const { service } = await setup([makeReport(), new Error('target unreachable')]);
    await service.reconcile(job);

    await expect(service.reconcile(job)).rejects.toThrow('target unreachable');
    expect((await service.latestByJob())['job-1']).toMatchObject({ checkedAt: '2026-10-14T10:00:00.000Z' });
  });

  it('returns the latest summary of every job, keyed by job id', async () => {
    const { service } = await setup([makeReport(), makeReport({ sourceCount: 7 })]);
    await service.reconcile(job);
    await service.reconcile({ ...job, id: 'job-2' });

    const latest = await service.latestByJob();
    expect(Object.keys(latest).sort()).toEqual(['job-1', 'job-2']);
    expect(latest['job-2']).toMatchObject({ jobId: 'job-2', sourceCount: 7 });
    expect(latest['job-2']).not.toHaveProperty('id');
  });
});
