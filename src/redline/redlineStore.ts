// ============================================================
// FilingLens — Redline IndexedDB store (Session 6)
// ------------------------------------------------------------
// One database ('filing-lens-redlines'), one object store ('redlines').
// Cache key: the current filing's rawTextHash. A cached entry records the
// computed SectionDiff[] plus the resolved prior-filing metadata, so re-opening
// the side panel for the same filing replays the redline without re-fetching
// EDGAR or re-embedding.
//
// Written by the side panel (the only context that owns the full RedlineResponse
// after the builtin summary upgrade). PRIVACY: stays on-device.
// ============================================================

import type { SectionDiff } from '@/types';
import type { AlignmentSummary, RedlinePriorInfo } from '@/messages/types';

const DB_NAME = 'filing-lens-redlines';
const DB_VERSION = 1;
const STORE = 'redlines';

export interface RedlineEntry {
  /** Current filing rawTextHash. */
  rawTextHash: string;
  status: 'computed' | 'no_prior' | 'unsupported_form';
  diffs: SectionDiff[];
  alignment: AlignmentSummary[];
  prior?: RedlinePriorInfo;
  cachedAt: number;
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
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'rawTextHash' });
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

export async function getCachedRedline(rawTextHash: string): Promise<RedlineEntry | null> {
  const db = await openDB();
  const tx = db.transaction(STORE, 'readonly');
  const result = await idbReq<RedlineEntry | undefined>(tx.objectStore(STORE).get(rawTextHash));
  return result ?? null;
}

export async function putRedline(entry: RedlineEntry): Promise<void> {
  const db = await openDB();
  const tx = db.transaction(STORE, 'readwrite');
  await idbReq(tx.objectStore(STORE).put(entry));
}
