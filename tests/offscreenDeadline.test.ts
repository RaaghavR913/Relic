// ============================================================
// Relic — settleWithDeadline tests (per-batch inference deadlines)
// ------------------------------------------------------------
// Models the offscreen pending-map protocol: a timeout must run the teardown
// side-effect first (which sweeps sibling entries), reject with the timeout
// error, and every late/duplicate settle must be a harmless no-op.
// ============================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { settleWithDeadline } from '../src/offscreen/deadline';

describe('settleWithDeadline', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('resolves normally and clears the timer', async () => {
    const onTimeout = vi.fn();
    const h = settleWithDeadline<number>({
      ms: 1_000,
      timeoutError: () => new Error('timed out'),
      onTimeout,
    });
    h.resolve(42);
    await expect(h.promise).resolves.toBe(42);
    vi.advanceTimersByTime(5_000);
    expect(onTimeout).not.toHaveBeenCalled();
  });

  it('rejects with the timeout error after ms, invoking onTimeout first', async () => {
    const order: string[] = [];
    const h = settleWithDeadline<number>({
      ms: 1_000,
      timeoutError: () => {
        order.push('error');
        return new Error('batch timed out');
      },
      onTimeout: () => order.push('teardown'),
    });
    const assertion = expect(h.promise).rejects.toThrow('batch timed out');
    vi.advanceTimersByTime(1_000);
    await assertion;
    expect(order).toEqual(['teardown', 'error']);
  });

  it('a teardown sweep settles sibling entries while the timed-out entry keeps its own error', async () => {
    // Mirrors embedBatch/classifyBatch: entry A times out, its onTimeout removes
    // A from the map and terminates the worker, which rejects every remaining
    // entry (B) with a sweep error.
    const map = new Map<string, { reject: (e: Error) => void }>();
    const sweep = () => {
      for (const p of map.values()) p.reject(new Error('Worker terminated'));
      map.clear();
    };
    const a = settleWithDeadline<number>({
      ms: 1_000,
      timeoutError: () => new Error('A timed out'),
      onTimeout: () => {
        map.delete('a');
        sweep();
      },
    });
    const b = settleWithDeadline<number>({
      ms: 60_000,
      timeoutError: () => new Error('B timed out'),
    });
    map.set('a', { reject: a.reject });
    map.set('b', { reject: b.reject });

    const aAssertion = expect(a.promise).rejects.toThrow('A timed out');
    const bAssertion = expect(b.promise).rejects.toThrow('Worker terminated');
    vi.advanceTimersByTime(1_000);
    await aAssertion;
    await bAssertion;
    expect(map.size).toBe(0);
  });

  it('late settles after a timeout are no-ops', async () => {
    const h = settleWithDeadline<number>({
      ms: 1_000,
      timeoutError: () => new Error('timed out'),
    });
    const assertion = expect(h.promise).rejects.toThrow('timed out');
    vi.advanceTimersByTime(1_000);
    await assertion;
    h.resolve(7); // must not turn the settled rejection into a resolution
    h.reject(new Error('other'));
    await expect(h.promise).rejects.toThrow('timed out');
  });

  it('reject wins over a later resolve', async () => {
    const h = settleWithDeadline<number>({
      ms: 1_000,
      timeoutError: () => new Error('timed out'),
    });
    h.reject(new Error('worker crashed'));
    h.resolve(7);
    await expect(h.promise).rejects.toThrow('worker crashed');
  });
});
