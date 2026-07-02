// ============================================================
// Relic — cross-panel "analysis running" signal
// ------------------------------------------------------------
// A tiny module-level pub/sub so the header can show the "On-device" chip
// whenever ANY panel is mid-analysis. The Analyst LM pipeline and the built-in
// Summarizer run in the side panel itself (no progress messages the shell can
// observe), so a shared counter is simpler and more faithful than trying to
// infer activity from the message bus. The side panel is a single React root, so
// one module singleton is all that's needed.
//
// PRIVACY: this only tracks a count of in-flight analyses — no filing text.
// ============================================================

import { useEffect, useState } from 'react';

let activeCount = 0;
const listeners = new Set<(active: boolean) => void>();

function emit(): void {
  const active = activeCount > 0;
  for (const fn of listeners) fn(active);
}

/**
 * Mark one analysis as started; returns an idempotent "finished" function. Panels
 * shouldn't call this directly — use the useReportAnalysisActivity hook.
 */
function begin(): () => void {
  activeCount++;
  emit();
  let ended = false;
  return () => {
    if (ended) return;
    ended = true;
    activeCount = Math.max(0, activeCount - 1);
    emit();
  };
}

/** Subscribe to activity changes; fires immediately with the current value. */
export function subscribeAnalysisActivity(fn: (active: boolean) => void): () => void {
  listeners.add(fn);
  fn(activeCount > 0);
  return () => {
    listeners.delete(fn);
  };
}

/** True while any panel reports an in-flight analysis. */
export function useAnalysisActive(): boolean {
  const [active, setActive] = useState(activeCount > 0);
  useEffect(() => subscribeAnalysisActivity(setActive), []);
  return active;
}

/**
 * Report this panel's in-flight status. Pass a boolean that is true while the
 * panel is working; the count is incremented while true and released on
 * false/unmount, so the header chip reflects the union of all panels.
 */
export function useReportAnalysisActivity(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    return begin();
  }, [active]);
}
