/**
 * Keeps requests to one API apart in time, so a job's source and its lookups share one rate budget.
 * Pure timing: the HTTP client asks for a turn before each request and reports Retry-After waits back.
 */

/** Milliseconds since the epoch, like `Date.now`. */
export type Clock = () => number;

/** Resolves after `ms`, or rejects with the signal's reason as soon as it is aborted. */
export type Sleep = (ms: number, signal?: AbortSignal) => Promise<void>;

/** A `setTimeout` that an abort signal cancels. Rejects with `signal.reason`. */
export const abortableSleep: Sleep = (ms, signal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });

/**
 * Hands out request turns one at a time, each at least `intervalMs` after the previous turn and not before a
 * time set by {@link RequestSpacer.pushBack}. Callers queue in order, so concurrent readers cannot both slip
 * through after the same wait.
 */
export class RequestSpacer {
  /** Earliest time the next turn may start. */
  private nextAt = 0;
  /** The turn in progress; each new turn starts after it settles. */
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly clock: Clock = Date.now,
    private readonly sleep: Sleep = abortableSleep,
  ) {}

  /**
   * Resolves when the caller may send its request; the next caller then waits `intervalMs` more.
   * Rejects with the signal's reason when aborted, whether still queued or already sleeping.
   */
  wait(intervalMs: number, signal?: AbortSignal): Promise<void> {
    const turn = this.queue.then(() => this.takeTurn(intervalMs, signal));
    // A caller that gave up must not hold up the callers behind it.
    this.queue = turn.catch(() => undefined);
    return signal ? rejectOnAbort(turn, signal) : turn;
  }

  /** Delays every later turn until at least `untilMs` (epoch milliseconds), e.g. after a Retry-After. */
  pushBack(untilMs: number): void {
    this.nextAt = Math.max(this.nextAt, untilMs);
  }

  private async takeTurn(intervalMs: number, signal: AbortSignal | undefined): Promise<void> {
    signal?.throwIfAborted();
    // Measured again after each sleep: a pushBack may have moved the time while this caller slept.
    for (let delay = this.nextAt - this.clock(); delay > 0; delay = this.nextAt - this.clock()) {
      await this.sleep(delay, signal);
    }
    this.nextAt = this.clock() + intervalMs;
  }
}

/** `promise`, or a rejection with the signal's reason if the signal aborts first. */
function rejectOnAbort(promise: Promise<void>, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}
