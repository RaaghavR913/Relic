// ============================================================
// Disclora — shared IndexedDB LRU eviction
// ------------------------------------------------------------
// The on-device caches (sentiment, redline, summaries, analyses) were unbounded:
// every distinct filing added a record that persisted forever. This caps each
// store at N entries, evicting the oldest by timestamp on write. The selection is
// a pure function so it can be unit-tested without an IndexedDB implementation;
// the thin IDB wrappers run inside the caller's existing readwrite transaction.
// ============================================================

/** Default per-store entry cap. Stores with many records per filing override it. */
export const DEFAULT_CACHE_CAP = 80;

/**
 * Pure selection: given all records, the cap, a timestamp accessor and a key
 * accessor, return the keys of the oldest records that exceed the cap (to delete).
 * Returns [] when at/under capacity.
 */
export function selectEvictions<T>(
  records: ReadonlyArray<T>,
  cap: number,
  tsOf: (record: T) => number,
  keyOf: (record: T) => IDBValidKey,
): IDBValidKey[] {
  if (records.length <= cap) return [];
  const sorted = [...records].sort((a, b) => tsOf(a) - tsOf(b)); // oldest first
  return sorted.slice(0, records.length - cap).map(keyOf);
}

/**
 * Within the caller's readwrite transaction, evict the oldest records so the store
 * holds at most `cap` entries. Best-effort and fire-and-forget: it queues a getAll
 * (synchronously, so the transaction does not idle) and deletes the overflow. Keys
 * are read off the store's own keyPath, so it works for both simple and compound
 * keyPath stores.
 */
export function evictToCap(
  store: IDBObjectStore,
  cap: number,
  tsOf: (record: unknown) => number,
): void {
  const keyPath = store.keyPath as string;
  const req = store.getAll();
  req.onsuccess = () => {
    const records = (req.result ?? []) as Array<Record<string, IDBValidKey>>;
    const keys = selectEvictions(records, cap, tsOf, (r) => r[keyPath]!);
    for (const key of keys) store.delete(key);
  };
}

/** Resolve when a transaction commits (so callers can await put + eviction). */
export function txComplete(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}
