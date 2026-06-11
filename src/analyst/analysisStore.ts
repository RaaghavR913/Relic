// ============================================================
// FilingLens — Analyst analysis IndexedDB store
// ------------------------------------------------------------
// One database ('filing-lens-analyses'), one object store ('analyses').
// Cache key: `${rawTextHash}:${register}` — re-opening the panel for the
// same filing replays the full investor analysis without re-prompting.
//
// PRIVACY: stays on-device.
// ============================================================

import type { FilingAnalysis } from '@/types';

const DB_NAME = 'filing-lens-analyses';
const DB_VERSION = 1;
const STORE = 'analyses';

export interface AnalysisEntry {
  /** Compound key: `${rawTextHash}:${register}` */
  key: string;
  rawTextHash: string;
  register: string;
  analysis: FilingAnalysis;
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
        db.createObjectStore(STORE, { keyPath: 'key' });
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

function makeKey(rawTextHash: string, register: string): string {
  return `${rawTextHash}:${register}`;
}

export async function getCachedAnalysis(
  rawTextHash: string,
  register: string,
): Promise<FilingAnalysis | null> {
  const db = await openDB();
  const tx = db.transaction(STORE, 'readonly');
  const result = await idbReq<AnalysisEntry | undefined>(
    tx.objectStore(STORE).get(makeKey(rawTextHash, register)),
  );
  return result?.analysis ?? null;
}

export async function putAnalysis(
  rawTextHash: string,
  register: string,
  analysis: FilingAnalysis,
): Promise<void> {
  const db = await openDB();
  const entry: AnalysisEntry = {
    key: makeKey(rawTextHash, register),
    rawTextHash,
    register,
    analysis,
    cachedAt: Date.now(),
  };
  const tx = db.transaction(STORE, 'readwrite');
  await idbReq(tx.objectStore(STORE).put(entry));
}

export async function clearAnalysis(rawTextHash: string, register: string): Promise<void> {
  const db = await openDB();
  const tx = db.transaction(STORE, 'readwrite');
  await idbReq(tx.objectStore(STORE).delete(makeKey(rawTextHash, register)));
}
