// ============================================================
// Relic — deadline-wrapped settle handles for offscreen ↔ worker RPC
// ------------------------------------------------------------
// The offscreen document talks to its inference workers with fire-and-forget
// postMessage + a pending map of {resolve, reject} callbacks. A worker that
// silently wedges (a WebGPU device-lost that never throws, an OOM-killed
// thread) posts nothing back, which used to leave those promises pending
// forever and freeze the panel's progress bar mid-percent. Every entry now
// carries a deadline: if the worker doesn't settle it in time, `onTimeout`
// runs (the offscreen host tears the wedged worker down, settling every
// sibling request) and the promise rejects.
//
// Pure module — no chrome.*, no worker refs — so vitest can drive it with
// fake timers without importing offscreen.ts (which registers runtime
// listeners at module load).
// ============================================================

export interface DeadlineHandle<T> {
  promise: Promise<T>;
  /** Settle successfully; clears the deadline. No-op after any settle. */
  resolve: (value: T) => void;
  /** Settle with an error; clears the deadline. No-op after any settle. */
  reject: (err: Error) => void;
}

/**
 * Create a promise with attached settle callbacks and a hard deadline.
 * On timeout, `onTimeout` runs first (teardown side-effects — typically
 * removing this entry from the pending map and terminating the worker, which
 * sweeps the siblings), then the promise rejects with `timeoutError()`.
 */
export function settleWithDeadline<T>(opts: {
  ms: number;
  timeoutError: () => Error;
  onTimeout?: () => void;
}): DeadlineHandle<T> {
  let resolveInner!: (value: T) => void;
  let rejectInner!: (err: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolveInner = res;
    rejectInner = rej;
  });

  let settled = false;
  const timer = setTimeout(() => {
    if (settled) return;
    settled = true;
    try {
      opts.onTimeout?.();
    } finally {
      rejectInner(opts.timeoutError());
    }
  }, opts.ms);

  return {
    promise,
    resolve: (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveInner(value);
    },
    reject: (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rejectInner(err);
    },
  };
}
