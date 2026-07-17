// ============================================================
// Relic — withStallGuard tests (the "stuck at 69%" fix)
// ------------------------------------------------------------
// The guard must let arbitrarily long work finish as long as it keeps
// reporting progress, abort work that stops progressing, and never
// misclassify a user abort as a stall.
// ============================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { withStallGuard, StallError } from '../src/lib/stallGuard';

describe('withStallGuard', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('resolves when fn settles before the stall deadline', async () => {
    await expect(withStallGuard(async () => 'ok', { stallMs: 1_000 })).resolves.toBe('ok');
  });

  it('rejects with StallError when fn never settles and never bumps', async () => {
    const p = withStallGuard(() => new Promise<never>(() => {}), { stallMs: 1_000 });
    const assertion = expect(p).rejects.toBeInstanceOf(StallError);
    await vi.advanceTimersByTimeAsync(1_000);
    await assertion;
  });

  it('aborts the child signal when the stall fires', async () => {
    let signal: AbortSignal | undefined;
    const p = withStallGuard(
      (s) => {
        signal = s;
        return new Promise<never>(() => {});
      },
      { stallMs: 1_000 },
    );
    const assertion = expect(p).rejects.toBeInstanceOf(StallError);
    await vi.advanceTimersByTimeAsync(1_000);
    await assertion;
    expect(signal?.aborted).toBe(true);
  });

  it('bumps keep extending the deadline while progress continues', async () => {
    let bump!: () => void;
    let finish!: (v: string) => void;
    const p = withStallGuard<string>(
      (_s, b) => {
        bump = b;
        return new Promise((res) => {
          finish = res;
        });
      },
      { stallMs: 1_000 },
    );
    // 3 × 900ms with a bump each time: 2.7s total > stallMs, but never a full
    // 1s without progress — must NOT stall.
    for (let i = 0; i < 3; i++) {
      await vi.advanceTimersByTimeAsync(900);
      bump();
    }
    finish('done');
    await expect(p).resolves.toBe('done');
  });

  it('stalls once bumps stop', async () => {
    let bump!: () => void;
    const p = withStallGuard(
      (_s, b) => {
        bump = b;
        return new Promise<never>(() => {});
      },
      { stallMs: 1_000 },
    );
    const assertion = expect(p).rejects.toBeInstanceOf(StallError);
    await vi.advanceTimersByTimeAsync(900);
    bump();
    await vi.advanceTimersByTimeAsync(1_000);
    await assertion;
  });

  it('propagates a parent abort as AbortError, not StallError', async () => {
    const parent = new AbortController();
    const p = withStallGuard(
      (signal) =>
        new Promise<never>((_, rej) => {
          signal.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError')));
        }),
      { stallMs: 1_000, parent: parent.signal },
    );
    const assertion = expect(p).rejects.toMatchObject({ name: 'AbortError' });
    parent.abort();
    await assertion;
  });

  it('rejects immediately when the parent is already aborted', async () => {
    const parent = new AbortController();
    parent.abort();
    await expect(
      withStallGuard(async () => 'never', { stallMs: 1_000, parent: parent.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('classifies a late fn rejection after parent abort as AbortError', async () => {
    // fn ignores the child signal entirely; the stall timer is the escape hatch,
    // but because the parent aborted, the caller must see AbortError.
    const parent = new AbortController();
    const p = withStallGuard(() => new Promise<never>(() => {}), {
      stallMs: 1_000,
      parent: parent.signal,
    });
    const assertion = expect(p).rejects.toMatchObject({ name: 'AbortError' });
    parent.abort();
    await vi.advanceTimersByTimeAsync(1_000);
    await assertion;
  });

  it('a bump after settle does not re-arm the timer', async () => {
    let bump!: () => void;
    const p = withStallGuard<string>(
      (_s, b) => {
        bump = b;
        return Promise.resolve('ok');
      },
      { stallMs: 1_000 },
    );
    await expect(p).resolves.toBe('ok');
    bump();
    // If the timer re-armed, advancing would fire an unhandled StallError; the
    // run completing cleanly (no unhandled rejection) is the assertion.
    await vi.advanceTimersByTimeAsync(5_000);
  });
});
