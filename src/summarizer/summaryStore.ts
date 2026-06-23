// ============================================================
// Disclora — Summary IndexedDB store (Session 3)
// ------------------------------------------------------------
// One database ('disclora-summaries'), one object store ('summaries').
// Cache key: `${rawTextHash}:${sectionId}:${register}`.
// Both the offscreen doc (extractive write) and the side panel
// (builtin write + all reads) use this store.
//
// PRIVACY: no filing text leaves the device.
// ============================================================

import { evictToCap, txComplete } from '@/lib/idbEvict';

const DB_NAME = 'disclora-summaries';
const DB_VERSION = 1;
const STORE = 'summaries';
/** Higher than the per-filing stores: this store holds one entry PER SECTION. */
const SUMMARY_CAP = 600;

export interface SummaryEntry {
  /** Compound key: `${rawTextHash}:${sectionId}:${register}` */
  key: string;
  rawTextHash: string;
  sectionId: string;
  /** 'builtin' | 'extractive' */
  register: string;
  /** Retained for back-compat with older entries; now mirrors `analyst`. Not read by the UI. */
  plain: string;
  /** The displayed summary: analyst note (builtin) or joined key sentences (extractive / fallback). */
  analyst: string;
  /**
   * SECTION-space char ranges [start, end) for jump-to-source.
   * Add section.charRange[0] to get DOCUMENT-space for HIGHLIGHT_RANGE.
   * Builtin: one range covering the whole section [0, section.text.length].
   * Extractive: one range per selected sentence.
   */
  plainAnchors: Array<[number, number]>;
  cachedAt: number;
}

// ── singleton DB ──────────────────────────────────────────────────────────────

let _db: IDBDatabase | null = null;
let _opening: Promise<IDBDatabase> | null = null;

function openDB(): Promise<IDBDatabase> {
  if (_db) return Promise.resolve(_db);
  if (_opening) return _opening;

  _opening = new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = (e) => {
      const db = (e.target as IDBOpenDBRequest).result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: 'key' });
        store.createIndex('byDoc', 'rawTextHash', { unique: false });
      }
    };

    req.onsuccess = () => {
      _db = req.result;
      _db.onclose = () => { _db = null; _opening = null; };
      resolve(_db);
    };
    req.onerror = () => reject(req.error);
  });

  return _opening;
}

function idbReq<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function makeKey(rawTextHash: string, sectionId: string, register: string): string {
  return `${rawTextHash}:${sectionId}:${register}`;
}

// ── public API ────────────────────────────────────────────────────────────────

export async function getCachedSummary(
  rawTextHash: string,
  sectionId: string,
  register: string,
): Promise<SummaryEntry | null> {
  const db = await openDB();
  const tx = db.transaction(STORE, 'readonly');
  const result = await idbReq<SummaryEntry | undefined>(
    tx.objectStore(STORE).get(makeKey(rawTextHash, sectionId, register)),
  );
  return result ?? null;
}

export async function putSummary(entry: Omit<SummaryEntry, 'key'>): Promise<void> {
  const db = await openDB();
  const full: SummaryEntry = {
    ...entry,
    key: makeKey(entry.rawTextHash, entry.sectionId, entry.register),
  };
  const tx = db.transaction(STORE, 'readwrite');
  const store = tx.objectStore(STORE);
  store.put(full);
  evictToCap(store, SUMMARY_CAP, (r) => (r as SummaryEntry).cachedAt);
  await txComplete(tx);
}

/** Remove all cached summaries for a document (e.g. when re-ingesting). */
export async function clearSummariesForDoc(rawTextHash: string): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    const idx = tx.objectStore(STORE).index('byDoc');
    const req = idx.openCursor(IDBKeyRange.only(rawTextHash));
    req.onsuccess = () => {
      const cursor = req.result as IDBCursorWithValue | null;
      if (!cursor) { resolve(); return; }
      cursor.delete();
      cursor.continue();
    };
    req.onerror = () => reject(req.error);
    tx.onerror = () => reject(tx.error);
  });
}
