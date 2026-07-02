// ============================================================
// Relic — gated debug logging
// ------------------------------------------------------------
// `debugLog` is a drop-in replacement for `console.debug` that no-ops in
// production builds. Vite statically replaces `import.meta.env.DEV` with a
// boolean literal, so in production bundles the body folds to a dead branch
// (and the call site to nothing meaningful) — no diagnostic chatter ships to
// end users. `console.warn` / `console.error` are intentionally NOT gated.
// ============================================================

export function debugLog(...args: unknown[]): void {
  if (import.meta.env.DEV) {
    // eslint-disable-next-line no-console
    console.debug(...args);
  }
}
