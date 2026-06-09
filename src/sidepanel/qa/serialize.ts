// ============================================================
// FilingLens — Serial queue (promise-chain mutex)
// ------------------------------------------------------------
// Minimal mutex used to serialize calls into the single pooled Gemini Nano
// LanguageModel session (AskPanel). Rapid/overlapping asks must not interleave
// on the one shared session, so each task is queued strictly after the previous
// one SETTLES (resolves or rejects). A task's rejection does not poison the
// chain — the next task still runs. Aborts are handled by the caller's
// AbortController; this only guarantees ordering/exclusivity.
// ============================================================

export type RunExclusive = <T>(task: () => Promise<T>) => Promise<T>;

/** Create an independent serial queue. Each returned `runExclusive` shares one chain. */
export function createSerialQueue(): RunExclusive {
  let tail: Promise<unknown> = Promise.resolve();
  return function runExclusive<T>(task: () => Promise<T>): Promise<T> {
    // Chain onto the tail so this task starts only after the previous settled.
    const result = tail.then(task);
    // Keep the chain alive but swallow outcomes so one task's rejection (or
    // result type) never affects the next task's scheduling.
    tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
}
