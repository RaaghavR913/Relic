// ============================================================
// Disclora — on-device cache reset
// ------------------------------------------------------------
// Deletes every IndexedDB store that holds derived analysis for a filing:
// investor analyses, year-over-year redlines, FinBERT sentiment, and extractive
// summaries. Filings are re-analysed on next open. Nothing here leaves the device.
//
// We delete by database name rather than importing the store modules, so the
// settings page never opens a connection that would block its own deletion.
// ============================================================

/** Every IndexedDB database Disclora uses to cache derived analysis. */
export const CACHE_DB_NAMES = [
  'disclora-analyses',
  'disclora-redlines',
  'disclora-sentiment',
  'disclora-summaries',
] as const;

function deleteDatabase(name: string): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    const req = indexedDB.deleteDatabase(name);
    req.onsuccess = done;
    req.onerror = done; // best-effort: a missing or errored DB shouldn't block the rest
    // `blocked` fires when another context holds an open connection. Resolve anyway;
    // the deletion completes once that connection closes. Don't hang the UI on it.
    req.onblocked = done;
    // Safety net in case none of the events fire (e.g. private-mode quirks).
    setTimeout(done, 3000);
  });
}

/** Clear all cached analyses. Resolves once every database has been requested to delete. */
export async function clearAllCaches(): Promise<void> {
  await Promise.all(CACHE_DB_NAMES.map(deleteDatabase));
}
