// ============================================================
// Relic — Redline IndexedDB store (Session 6)
// ------------------------------------------------------------
// One database ('relic-redlines'), one object store ('redlines').
// Cache key: `${rawTextHash}::${priorKey}` so Auto and years-back YoY runs for
// the same current filing do not overwrite each other. Analyst / export always
// read priorKey 'auto'.
//
// Written by the side panel (the only context that owns the full RedlineResponse
// after the builtin summary upgrade). PRIVACY: stays on-device.
// ============================================================

import type { SectionDiff } from '@/types';
import type { AlignmentSummary, RedlinePriorInfo } from '@/messages/types';
import { evictToCap, txComplete, DEFAULT_CACHE_CAP } from '@/lib/idbEvict';

const DB_NAME = 'relic-redlines';
/** v1 keyed by rawTextHash only; v2 uses compound id `${hash}::${priorKey}`. */
const DB_VERSION = 2;
const STORE = 'redlines';

/** `'auto'` = previous-filing comparison; `acc:<accessionNo>` = a specific pick. */
export type RedlinePriorKey = 'auto' | `acc:${string}`;

export interface RedlineEntry {
  /**
   * Compound IndexedDB key. Set by `putRedline`; callers may omit it.
   * Format: `${rawTextHash}::${priorKey}`.
   */
  id?: string;
  /** Current filing rawTextHash. */
  rawTextHash: string;
  /**
   * Which prior-selection mode produced this entry. Defaults to `'auto'` when
   * omitted (Analyst / export / legacy callers).
   */
  priorKey?: RedlinePriorKey;
  status: 'computed' | 'no_prior' | 'unsupported_form';
  diffs: SectionDiff[];
  alignment: AlignmentSummary[];
  prior?: RedlinePriorInfo;
  cachedAt: number;
}

/** Map a chosen prior accession to the cache priorKey (undefined → auto). */
export function priorKeyFromAccession(accessionNo?: string): RedlinePriorKey {
  return accessionNo ? `acc:${accessionNo}` : 'auto';
}

export function redlineCacheId(rawTextHash: string, priorKey: RedlinePriorKey = 'auto'): string {
  return `${rawTextHash}::${priorKey}`;
}

let _db: IDBDatabase | null = null;
let _opening: Promise<IDBDatabase> | null = null;

function openDB(): Promise<IDBDatabase> {
  if (_db) return Promise.resolve(_db);
  if (_opening) return _opening;

  _opening = new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = (e.target as IDBOpenDBRequest).result;
      const tx = (e.target as IDBOpenDBRequest).transaction!;
      const oldVersion = e.oldVersion;

      if (oldVersion < 2) {
        // v1 → v2: keyPath changes from rawTextHash to compound `id`. Must
        // delete + recreate the store; migrate existing rows to `::auto`.
        if (oldVersion >= 1 && db.objectStoreNames.contains(STORE)) {
          const oldStore = tx.objectStore(STORE);
          const getAllReq = oldStore.getAll();
          getAllReq.onsuccess = () => {
            const rows = (getAllReq.result ?? []) as Array<Record<string, unknown>>;
            db.deleteObjectStore(STORE);
            const store = db.createObjectStore(STORE, { keyPath: 'id' });
            for (const row of rows) {
              const hash = String(row.rawTextHash ?? '');
              if (!hash) continue;
              store.put({
                ...row,
                priorKey: 'auto',
                id: redlineCacheId(hash, 'auto'),
              });
            }
          };
        } else if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE, { keyPath: 'id' });
        }
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

/**
 * Load a cached redline. Defaults to `priorKey: 'auto'` so Analyst and export
 * keep seeing the default (previous-filing) comparison.
 */
export async function getCachedRedline(
  rawTextHash: string,
  priorKey: RedlinePriorKey = 'auto',
): Promise<RedlineEntry | null> {
  const db = await openDB();
  const tx = db.transaction(STORE, 'readonly');
  const result = await idbReq<RedlineEntry | undefined>(
    tx.objectStore(STORE).get(redlineCacheId(rawTextHash, priorKey)),
  );
  return result ?? null;
}

export async function putRedline(entry: RedlineEntry): Promise<void> {
  const priorKey: RedlinePriorKey = entry.priorKey ?? 'auto';
  const stored: RedlineEntry = {
    ...entry,
    priorKey,
    id: redlineCacheId(entry.rawTextHash, priorKey),
  };
  const db = await openDB();
  const tx = db.transaction(STORE, 'readwrite');
  const store = tx.objectStore(STORE);
  store.put(stored);
  evictToCap(store, DEFAULT_CACHE_CAP, (r) => (r as RedlineEntry).cachedAt);
  await txComplete(tx);
}
