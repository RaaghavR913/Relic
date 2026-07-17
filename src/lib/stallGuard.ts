// ============================================================
// Relic — stall-aware deadline guard
// ------------------------------------------------------------
// withDeadline (analyst/pipeline.ts) enforces a FIXED time budget. That is the
// wrong shape for Chrome's one-time Gemini Nano download, which legitimately
// takes minutes on a slow link: a healthy download must be allowed to finish,
// but one that stops making progress must not pin a panel forever (the
// "stuck at 69%" first-run bug). withStallGuard restarts its timer on every
// bump(), so only `stallMs` WITHOUT progress — not total elapsed time — aborts
// the work. The Promise.race guarantees the caller stops awaiting even if
// Chrome ignores the abort signal mid-download.
// ============================================================

export class StallError extends Error {
  constructor(stallMs: number) {
    super(`No progress for ${Math.round(stallMs / 1000)}s — treating as stalled`);
    this.name = 'StallError';
  }
}

/**
 * Run `fn` with a deadline that resets on every `bump()`. Callers must bump on
 * REAL progress only (e.g. a download fraction that actually changed — Chrome
 * can re-emit the same fraction while stalled). On stall the child signal is
 * aborted (best-effort) and the returned promise rejects with StallError; a
 * parent abort propagates as an AbortError so callers can bail cleanly.
 */
export async function withStallGuard<T>(
  fn: (signal: AbortSignal, bump: () => void) => Promise<T>,
  opts: { stallMs: number; parent?: AbortSignal },
): Promise<T> {
  const { stallMs, parent } = opts;
  if (parent?.aborted) throw new DOMException('aborted', 'AbortError');

  const child = new AbortController();
  const onAbort = () => child.abort();
  parent?.addEventListener('abort', onAbort);

  let done = false;
  let timer!: ReturnType<typeof setTimeout>;
  let fireStall: () => void = () => {};

  const stalled = new Promise<never>((_, reject) => {
    fireStall = () => {
      child.abort();
      reject(new StallError(stallMs));
    };
    timer = setTimeout(fireStall, stallMs);
  });

  const bump = () => {
    if (done) return;
    clearTimeout(timer);
    timer = setTimeout(fireStall, stallMs);
  };

  const work = fn(child.signal, bump);
  // Observe post-race rejections (e.g. the AbortError our own abort provokes
  // after the race already settled with StallError) so they never go unhandled.
  work.catch(() => {});

  try {
    return await Promise.race([work, stalled]);
  } catch (err) {
    // A real parent abort (user cancel / unmount / new run) outranks the stall
    // classification.
    if (parent?.aborted) throw new DOMException('aborted', 'AbortError');
    throw err;
  } finally {
    done = true;
    clearTimeout(timer);
    parent?.removeEventListener('abort', onAbort);
  }
}
