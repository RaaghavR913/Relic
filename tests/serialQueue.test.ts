// ============================================================
// FilingLens — M3 test: serial queue (pooled Q&A session mutex)
// ============================================================

import { describe, it, expect } from 'vitest';
import { createSerialQueue } from '../src/sidepanel/qa/serialize';

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('createSerialQueue', () => {
  it('runs overlapping tasks strictly sequentially — never interleaved', async () => {
    const runExclusive = createSerialQueue();
    let active = 0;
    let maxConcurrent = 0;
    const order: number[] = [];

    const task = (id: number, delay: number) =>
      runExclusive(async () => {
        active++;
        maxConcurrent = Math.max(maxConcurrent, active);
        await tick(delay);
        order.push(id);
        active--;
      });

    // Fire three asks back-to-back (as a rapid double/triple-click would).
    await Promise.all([task(1, 15), task(2, 5), task(3, 10)]);

    expect(maxConcurrent).toBe(1);     // exclusivity — only one in the session at a time
    expect(order).toEqual([1, 2, 3]);  // preserves submission order despite varied delays
  });

  it('does not let a rejecting task poison the chain', async () => {
    const runExclusive = createSerialQueue();
    const order: string[] = [];

    const bad = runExclusive(async () => {
      order.push('bad-start');
      throw new Error('boom');
    });
    const good = runExclusive(async () => {
      order.push('good');
      return 42;
    });

    await expect(bad).rejects.toThrow('boom');
    await expect(good).resolves.toBe(42);
    expect(order).toEqual(['bad-start', 'good']);
  });

  it('resolves each task with its own return value', async () => {
    const runExclusive = createSerialQueue();
    const a = await runExclusive(async () => 'a');
    const b = await runExclusive(async () => 'b');
    expect([a, b]).toEqual(['a', 'b']);
  });

  it('starts a queued task only after the previous one settles', async () => {
    const runExclusive = createSerialQueue();
    const events: string[] = [];

    const first = runExclusive(async () => {
      events.push('first:start');
      await tick(10);
      events.push('first:end');
    });
    const second = runExclusive(async () => {
      events.push('second:start');
    });

    await Promise.all([first, second]);
    // second must not start until first has fully ended.
    expect(events).toEqual(['first:start', 'first:end', 'second:start']);
  });
});
