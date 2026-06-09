// ============================================================
// FilingLens — IndexedDB vector store (Session 2)
// ------------------------------------------------------------
// Two object stores:
//   'vectors'  keyed by `${rawTextHash}:${chunkId}` with an index on rawTextHash.
//              Each record holds the chunk text, char range (DOCUMENT space), and the
//              embedding as an ArrayBuffer (serialised Float32Array, unit-normalised).
//   'manifest' keyed by rawTextHash. Presence means this document is fully indexed;
//              buildIndex() is idempotent — re-opening the side panel never re-embeds.
//
// All IDB access is serialised through a lazy singleton; the DB is opened once and
// reused. The offscreen document (and only it) writes; retrievals are read-only.
// ============================================================

const DB_NAME = 'filing-lens-vectors';
const DB_VERSION = 1;
const VECTORS_STORE = 'vectors';
const MANIFEST_STORE = 'manifest';

export interface VectorRecord {
  /** `${rawTextHash}:${chunkId}` */
  key: string;
  rawTextHash: string;
  chunkId: string;
  sectionId: string;
  /** DOCUMENT-space [start, end) char range into positionMap.text. */
  charRange: [number, number];
  /** Float32Array stored as ArrayBuffer (unit-length). */
  vector: ArrayBuffer;
  text: string;
}

export interface ManifestRecord {
  rawTextHash: string;
  chunkCount: number;
  indexedAt: number;
  modelId: string;
}

// ── singleton DB promise ──────────────────────────────────────────────────────

let _db: IDBDatabase | null = null;
let _opening: Promise<IDBDatabase> | null = null;

function openDB(): Promise<IDBDatabase> {
  if (_db) return Promise.resolve(_db);
  if (_opening) return _opening;

  _opening = new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = (e) => {
      const db = (e.target as IDBOpenDBRequest).result;

      if (!db.objectStoreNames.contains(VECTORS_STORE)) {
        const store = db.createObjectStore(VECTORS_STORE, { keyPath: 'key' });
        store.createIndex('byHash', 'rawTextHash', { unique: false });
      }

      if (!db.objectStoreNames.contains(MANIFEST_STORE)) {
        db.createObjectStore(MANIFEST_STORE, { keyPath: 'rawTextHash' });
      }
    };

    req.onsuccess = () => {
      _db = req.result;
      _db.onclose = () => {
        _db = null;
        _opening = null;
      };
      resolve(_db);
    };

    req.onerror = () => reject(req.error);
  });

  return _opening;
}

function idbRequest<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// ── manifest helpers ─────────────────────────────────────────────────────────

export async function isIndexed(rawTextHash: string): Promise<ManifestRecord | null> {
  const db = await openDB();
  const tx = db.transaction(MANIFEST_STORE, 'readonly');
  const store = tx.objectStore(MANIFEST_STORE);
  const result = await idbRequest<ManifestRecord | undefined>(store.get(rawTextHash));
  return result ?? null;
}

export async function recordManifest(record: ManifestRecord): Promise<void> {
  const db = await openDB();
  const tx = db.transaction(MANIFEST_STORE, 'readwrite');
  await idbRequest(tx.objectStore(MANIFEST_STORE).put(record));
}

// ── vector write ──────────────────────────────────────────────────────────────

/**
 * Store a batch of vector records in a single transaction.
 * Vectors should be unit-normalised Float32Array buffers.
 */
export async function putVectors(records: VectorRecord[]): Promise<void> {
  if (records.length === 0) return;
  const db = await openDB();
  const tx = db.transaction(VECTORS_STORE, 'readwrite');
  const store = tx.objectStore(VECTORS_STORE);
  for (const rec of records) {
    store.put(rec);
  }
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

// ── vector read for retrieval ─────────────────────────────────────────────────

/**
 * Load all vector records for a document in one index scan.
 * Returns decoded Float32Array vectors alongside provenance metadata.
 */
export interface LoadedVector {
  chunkId: string;
  sectionId: string;
  charRange: [number, number];
  text: string;
  vector: Float32Array;
}

export async function loadVectors(rawTextHash: string): Promise<LoadedVector[]> {
  const db = await openDB();
  const tx = db.transaction(VECTORS_STORE, 'readonly');
  const index = tx.objectStore(VECTORS_STORE).index('byHash');
  const records = await idbRequest<VectorRecord[]>(index.getAll(rawTextHash));
  return records.map((r) => ({
    chunkId: r.chunkId,
    sectionId: r.sectionId,
    charRange: r.charRange,
    text: r.text,
    vector: new Float32Array(r.vector),
  }));
}

// ── debug / purge ─────────────────────────────────────────────────────────────

export async function clearDocument(rawTextHash: string): Promise<void> {
  const db = await openDB();
  const tx = db.transaction([VECTORS_STORE, MANIFEST_STORE], 'readwrite');
  const index = tx.objectStore(VECTORS_STORE).index('byHash');
  const keys = await idbRequest<IDBValidKey[]>(index.getAllKeys(rawTextHash));
  const vecStore = tx.objectStore(VECTORS_STORE);
  for (const k of keys) vecStore.delete(k);
  tx.objectStore(MANIFEST_STORE).delete(rawTextHash);
  await new Promise<void>((res, rej) => {
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  });
}
