// ============================================================
// Disclora — IndexedDB cache for FinBERT sentiment results (Session 4)
// ------------------------------------------------------------
// Store: 'disclora-sentiment'  key: rawTextHash
// Results include DOCUMENT-space SentenceSentiment[] so they can be replayed
// immediately from cache without re-running the model.
// ============================================================

import type { SentenceSentiment } from '@/types';
import { evictToCap, txComplete, DEFAULT_CACHE_CAP } from '@/lib/idbEvict';

const DB_NAME = 'disclora-sentiment';
const DB_VERSION = 1;
const SENTIMENT_STORE = 'sentiments';

interface SentimentRecord {
  rawTextHash: string; // primary key
  modelId: string;
  analyzedAt: number;
  /** DOCUMENT-space SentenceSentiment[] for the full filing. */
  results: SentenceSentiment[];
}

let _db: IDBDatabase | null = null;

function openDb(): Promise<IDBDatabase> {
  if (_db) return Promise.resolve(_db);

  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(SENTIMENT_STORE)) {
        db.createObjectStore(SENTIMENT_STORE, { keyPath: 'rawTextHash' });
      }
    };

    req.onsuccess = () => {
      _db = req.result;
      resolve(_db);
    };

    req.onerror = () => reject(req.error);
  });
}

/**
 * Retrieve cached sentiment results for a filing.
 * Returns null if no cache entry exists or the entry is for a different model.
 */
export async function getSentimentCache(
  rawTextHash: string,
  modelId: string,
): Promise<SentenceSentiment[] | null> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(SENTIMENT_STORE, 'readonly');
    const req = tx.objectStore(SENTIMENT_STORE).get(rawTextHash);
    req.onsuccess = () => {
      const record = req.result as SentimentRecord | undefined;
      if (!record || record.modelId !== modelId) {
        resolve(null);
        return;
      }
      resolve(record.results);
    };
    req.onerror = () => reject(req.error);
  });
}

/** Persist sentiment results to the cache. Overwrites any existing entry. */
export async function putSentimentCache(
  rawTextHash: string,
  modelId: string,
  results: SentenceSentiment[],
): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(SENTIMENT_STORE, 'readwrite');
  const store = tx.objectStore(SENTIMENT_STORE);
  const record: SentimentRecord = { rawTextHash, modelId, analyzedAt: Date.now(), results };
  store.put(record);
  evictToCap(store, DEFAULT_CACHE_CAP, (r) => (r as SentimentRecord).analyzedAt);
  await txComplete(tx);
}

/** Remove the cached entry for a filing (e.g. after a model upgrade). */
export async function clearSentimentCache(rawTextHash: string): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(SENTIMENT_STORE, 'readwrite');
    const req = tx.objectStore(SENTIMENT_STORE).delete(rawTextHash);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}
