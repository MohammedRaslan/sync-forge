import { afterEach, describe, expect, it, vi } from 'vitest';
import { RequestSpacer, Sleep, abortableSleep } from '../src/connectors/http/request-spacer';

/** A spacer on a fake clock: each sleep moves the clock forward and is recorded. */
function setup(start = 1_000_000) {
  let now = start;
  const sleeps: number[] = [];
  const sleep: Sleep = async (ms, signal) => {
    signal?.throwIfAborted();
    sleeps.push(ms);
    now += ms;
  };
  const spacer = new RequestSpacer(() => now, sleep);
  return { spacer, sleeps, advance: (ms: number) => (now += ms), now: () => now };
}

describe('RequestSpacer', () => {
  it('lets the first request through at once', async () => {
    const { spacer, sleeps } = setup();
    await spacer.wait(1000);
    expect(sleeps).toEqual([]);
  });

  it('keeps the next request the interval after the previous one', async () => {
    const { spacer, sleeps, advance } = setup();
    await spacer.wait(1000);
    advance(300);
    await spacer.wait(1000);
    expect(sleeps).toEqual([700]);
  });

  it('does not wait when the interval has already passed', async () => {
    const { spacer, sleeps, advance } = setup();
    await spacer.wait(1000);
    advance(5000);
    await spacer.wait(1000);
    expect(sleeps).toEqual([]);
  });

  it('never waits with an interval of 0', async () => {
    const { spacer, sleeps } = setup();
    await Promise.all([spacer.wait(0), spacer.wait(0), spacer.wait(0)]);
    expect(sleeps).toEqual([]);
  });

  it('spaces concurrent callers one after another, in the order they asked', async () => {
    const { spacer, sleeps, now } = setup(0);
    const started: Array<[string, number]> = [];
    await Promise.all(
      ['source', 'lookup-a', 'lookup-b'].map((name) => spacer.wait(500).then(() => started.push([name, now()]))),
    );
    expect(started).toEqual([
      ['source', 0],
      ['lookup-a', 500],
      ['lookup-b', 1000],
    ]);
    expect(sleeps).toEqual([500, 500]);
  });

  it('holds every later request until a pushed-back time, such as a Retry-After', async () => {
    const { spacer, sleeps, now } = setup(0);
    await spacer.wait(0);
    spacer.pushBack(30_000);
    await spacer.wait(0);
    expect(sleeps).toEqual([30_000]);
    expect(now()).toBe(30_000);
  });

  it('keeps the later of a pushed-back time and the interval', async () => {
    const { spacer, sleeps } = setup(0);
    await spacer.wait(10_000);
    spacer.pushBack(2_000);
    await spacer.wait(10_000);
    expect(sleeps).toEqual([10_000]);
  });

  it('waits again when a push-back arrives while a caller sleeps', async () => {
    let now = 0;
    const sleeps: number[] = [];
    const spacer: RequestSpacer = new RequestSpacer(
      () => now,
      async (ms) => {
        sleeps.push(ms);
        now += ms;
        // Another request got a Retry-After during this sleep.
        if (sleeps.length === 1) spacer.pushBack(now + 4000);
      },
    );
    await spacer.wait(1000);
    await spacer.wait(1000);
    expect(sleeps).toEqual([1000, 4000]);
  });

  it('rejects an aborted caller with the abort reason and lets the next caller through', async () => {
    const { spacer } = setup();
    const controller = new AbortController();
    controller.abort(new Error('run cancelled'));
    await expect(spacer.wait(1000, controller.signal)).rejects.toThrow('run cancelled');
    await expect(spacer.wait(1000)).resolves.toBeUndefined();
  });

  describe('with real timers faked', () => {
    afterEach(() => vi.useRealTimers());

    it('rejects a caller that is aborted while it sleeps, without waiting for the sleep', async () => {
      vi.useFakeTimers();
      const spacer = new RequestSpacer();
      await spacer.wait(60_000);
      const controller = new AbortController();
      const waiting = spacer.wait(60_000, controller.signal);
      const settled = expect(waiting).rejects.toThrow('stop');
      await vi.advanceTimersByTimeAsync(1000);
      controller.abort(new Error('stop'));
      await settled;
      expect(vi.getTimerCount()).toBe(0);
    });

    it('rejects a queued caller as soon as it is aborted, while another caller holds the turn', async () => {
      vi.useFakeTimers();
      const spacer = new RequestSpacer();
      await spacer.wait(0);
      spacer.pushBack(Date.now() + 60_000);
      const holder = spacer.wait(0);
      const controller = new AbortController();
      const queued = spacer.wait(0, controller.signal);
      const settled = expect(queued).rejects.toThrow('stop');
      controller.abort(new Error('stop'));
      await settled;
      await vi.advanceTimersByTimeAsync(60_000);
      await expect(holder).resolves.toBeUndefined();
    });
  });
});

describe('abortableSleep', () => {
  afterEach(() => vi.useRealTimers());

  it('resolves after the given time', async () => {
    vi.useFakeTimers();
    let done = false;
    const sleeping = abortableSleep(5000).then(() => (done = true));
    await vi.advanceTimersByTimeAsync(4999);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await sleeping;
    expect(done).toBe(true);
  });

  it('rejects at once for a signal that is already aborted', async () => {
    const controller = new AbortController();
    controller.abort(new Error('gone'));
    await expect(abortableSleep(5000, controller.signal)).rejects.toThrow('gone');
  });
});
