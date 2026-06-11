/**
 * Content-readiness gate for on-demand ("Analyze this page") ingestion.
 *
 * The on-demand path injects the content script the instant the user clicks the
 * toolbar icon. On server-rendered pages (EDGAR filings, static articles) the
 * document text is already present, but client-rendered SPAs (Yahoo Finance,
 * Bloomberg, CNBC) stream their article body in AFTER initial load. Ingesting a
 * premature snapshot there captures only the app shell, so FILING_READY never
 * fires and the panel times out.
 *
 * waitForContent() resolves immediately when enough extractable text is already
 * present (so EDGAR / static pages are unaffected), and otherwise waits — via a
 * MutationObserver plus a poll fallback — until the extractable text crosses a
 * threshold and stops growing (settles), or a hard cap elapses.
 *
 * The readiness probe reuses pickFilingRoot() so the signal matches exactly what
 * ingestion will later read (including same-origin filing iframes).
 */

import { pickFilingRoot } from './dom-root.js';

/** Minimum extractable characters before a page is considered "ready" to ingest. */
export const READY_MIN_CHARS = 750;
/** Once the threshold is met, wait this long with no meaningful growth before resolving. */
export const SETTLE_MS = 500;
/** Hard cap — resolve best-effort even if the page never produces enough text. */
export const MAX_WAIT_MS = 8000;
/** Poll fallback interval (covers mutations a MutationObserver may not surface, e.g. canvas/late layout). */
const POLL_MS = 250;
/** Growth below this many chars between checks counts as "settled". */
const GROWTH_EPSILON = 32;

/** Best extractable text length right now (mirrors what ingestion will read). */
export function currentTextLength(doc: Document = document): number {
  try {
    const root = pickFilingRoot(doc).root as HTMLElement;
    return root.innerText?.length ?? root.textContent?.length ?? 0;
  } catch {
    return 0;
  }
}

export interface WaitForContentOptions {
  doc?: Document;
  minChars?: number;
  settleMs?: number;
  maxWaitMs?: number;
}

/**
 * Resolve once the page has enough stable, extractable text — or at the cap.
 * Never rejects: ingestion runs on whatever is present when this resolves.
 */
export function waitForContent(opts: WaitForContentOptions = {}): Promise<void> {
  const doc = opts.doc ?? document;
  const minChars = opts.minChars ?? READY_MIN_CHARS;
  const settleMs = opts.settleMs ?? SETTLE_MS;
  const maxWaitMs = opts.maxWaitMs ?? MAX_WAIT_MS;

  // Fast path: content already present (EDGAR, static pages) → no waiting.
  if (currentTextLength(doc) >= minChars) return Promise.resolve();

  return new Promise<void>((resolve) => {
    let lastLen = currentTextLength(doc);
    let settled = false;
    let observer: MutationObserver | null = null;
    let pollTimer: ReturnType<typeof setInterval> | null = null;
    let settleTimer: ReturnType<typeof setTimeout> | null = null;
    let capTimer: ReturnType<typeof setTimeout> | null = null;

    const cleanup = () => {
      if (settled) return;
      settled = true;
      observer?.disconnect();
      if (pollTimer !== null) clearInterval(pollTimer);
      if (settleTimer !== null) clearTimeout(settleTimer);
      if (capTimer !== null) clearTimeout(capTimer);
      resolve();
    };

    // Re-evaluate readiness on every signal. Once the threshold is met we arm a
    // settle timer; further meaningful growth re-arms it so we ingest only after
    // the SPA stops streaming content in.
    const check = () => {
      if (settled) return;
      const len = currentTextLength(doc);
      const grew = len - lastLen > GROWTH_EPSILON;
      lastLen = Math.max(lastLen, len);

      if (len >= minChars) {
        if (settleTimer === null || grew) {
          if (settleTimer !== null) clearTimeout(settleTimer);
          settleTimer = setTimeout(cleanup, settleMs);
        }
      } else if (settleTimer !== null) {
        // Dropped back below threshold (rare re-render) — cancel the pending settle.
        clearTimeout(settleTimer);
        settleTimer = null;
      }
    };

    observer = new MutationObserver(check);
    observer.observe(doc.documentElement, {
      subtree: true,
      childList: true,
      characterData: true,
    });
    pollTimer = setInterval(check, POLL_MS);
    capTimer = setTimeout(cleanup, maxWaitMs);

    // Evaluate once synchronously in case content landed between the fast-path
    // check and observer setup.
    check();
  });
}
