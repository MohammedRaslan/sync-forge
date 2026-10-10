import { Injectable } from '@nestjs/common';

/**
 * Tracks which jobs have a run in progress. Lives in the jobs module so job operations
 * (delete, reset watermark) can refuse to touch a running job without depending on the runner.
 */
@Injectable()
export class RunLocks {
  private readonly locked = new Set<string>();

  tryAcquire(jobId: string): boolean {
    if (this.locked.has(jobId)) return false;
    this.locked.add(jobId);
    return true;
  }

  release(jobId: string): void {
    this.locked.delete(jobId);
  }

  isLocked(jobId: string): boolean {
    return this.locked.has(jobId);
  }
}
