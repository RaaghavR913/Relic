// ============================================================
// Relic — offscreen document main thread (Session 2)
// ------------------------------------------------------------
// Responsibilities:
//   1. Encoder Web Worker lifecycle (lazy init, idle-unload).
//   2. Extractive summarization (sentence-centrality ranking via embeddings).
//   3. FinBERT sentiment classification.
//   4. Redline diff (textual + embedding-backed semantic pass).
//
// The offscreen doc receives messages routed from the SW with target:'offscreen'.
// It sends progress updates directly to side-panel listeners (target:'sidepanel')
// and sends OFFSCREEN_IDLE to the SW when the idle timer fires.
//
// PRIVACY: no text leaves the device. Model weights are BUNDLED in the extension
// (loaded via chrome.runtime.getURL('models/') with allowRemoteModels=false) — they
// are never fetched from Hugging Face at runtime. The only network calls are EDGAR.
// ============================================================

import type {
  OffscreenExtractiveMsg,
  OffscreenSentimentMsg,
  EmbedProgressMsg,
  ExtractiveResponse,
  SentimentResponse,
  SentimentSectionDoneMsg,
  SentimentProgressMsg,
  InferenceBackendMsg,
  WorkerOutbound,
  WorkerInitMsg,
  SentimentWorkerOutbound,
  SentimentWorkerClassifyResultMsg,
  OffscreenRedlineMsg,
  RedlineResponse,
  RedlineProgressMsg,
  RedlineStage,
  AlignmentSummary,
  OffscreenEmbedMsg,
  EmbedTextsResponse,
  OffscreenParsePdfMsg,
  ParsePdfResponse,
} from '@/messages/types';
import { parsePdf, base64ToBytes } from './pdfParse';
import { settleWithDeadline } from './deadline';
import { getBackendTuning } from './backendTuning';
import { probeWebGpuAdapter } from './webgpuPreflight';
import type { InferenceDevice } from '@/workers/backendOrder';
import type { DocumentModel, Section, SentenceSentiment, SectionDiff } from '@/types';
import { filterNonTableSentences } from './sentenceFilter';
import { debugLog } from '@/lib/debug';
import { calibrateSentimentLabel } from './calibrateSentiment';
import {
  splitSentences,
  rankByCentrality,
  selectTopN,
  targetSentenceCount,
  cosineSim,
} from '@/summarizer/extractive';
import {
  structuralDiff,
  assembleSectionDiff,
  diffSection,
  templatedChangeSummary,
  jaccardSimilarity,
  type Similarity,
  type SectionDiffCore,
} from '@/redline/diff';
import { alignSections, focusAlignments } from '@/redline/align';
import { parsePriorFiling } from '@/redline/parsePrior';
import { getSentimentCache, putSentimentCache } from '@/db/sentimentStore';
import { sectionPriority } from '@/analyst/relevance';

// ── constants ─────────────────────────────────────────────────────────────────

const MODEL_ID = 'mixedbread-ai/mxbai-embed-xsmall-v1';
/**
 * FinBERT ONNX export — ProsusAI/finbert via the Xenova ONNX community export.
 * The quantized weights are bundled under models/ and loaded locally
 * (allowRemoteModels=false) — never fetched from the Hub at runtime.
 */
const FINBERT_MODEL_ID = 'Xenova/finbert';
const IDLE_TIMEOUT_MS = 5 * 60 * 1_000; // 5 minutes

/**
 * Low-memory profile. navigator.deviceMemory is capped at 8 by Chrome and
 * absent on some platforms (absent ⇒ assume 8 / don't degrade). At ≤ 4 GB the
 * int8 models still fit, but peak WASM arena use must stay small: halve the
 * batch sizes, run a single embed lane (two in-flight batches double the
 * scratch buffers), and cap ORT at 2 threads so the machine stays responsive.
 */
const DEVICE_MEMORY_GB =
  (navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? 8;
const LOW_MEMORY = DEVICE_MEMORY_GB <= 4;

/**
 * Per-batch inference deadlines. A worker that silently wedges (WebGPU
 * device-lost that never throws, an OOM-killed thread) posts nothing back;
 * without a deadline the awaiting promise — and the panel's progress bar —
 * froze forever. The first batch on a fresh worker pays one-time WASM JIT /
 * backend compile, so it gets a longer budget.
 */
const COLD_BATCH_TIMEOUT_MS = 60_000;
const WARM_BATCH_TIMEOUT_MS = 30_000;

/**
 * ORT WASM thread count. Multi-threaded ORT needs cross-origin isolation
 * (COOP:same-origin + COEP:require-corp, declared in manifest.json), which flips
 * self.crossOriginIsolated to true and unlocks SharedArrayBuffer for the bundled
 * threaded ORT builds (ort-wasm-simd-threaded*). Without isolation (older Chrome,
 * enterprise policy) we fall back to a single thread — the pre-existing behaviour.
 * Capped at 4: int8 FinBERT/embeddings stop scaling past that and we don't want to
 * monopolise every core on the machine (2 on the low-memory profile — see above).
 */
const ORT_NUM_THREADS = self.crossOriginIsolated
  ? Math.min(LOW_MEMORY ? 2 : 4, navigator.hardwareConcurrency || 1)
  : 1;

// Default tuning assumes WASM until READY (preserves historical WASM batch sizes).
let encoderTuning = getBackendTuning(LOW_MEMORY, 'wasm');
let sentimentTuning = getBackendTuning(LOW_MEMORY, 'wasm');

/** Session preference after preflight / READY — skips doomed WebGPU attempts. */
let sessionPreferredDevice: InferenceDevice | null = null;
let preflightPromise: Promise<InferenceDevice> | null = null;

async function resolvePreferredDevice(): Promise<InferenceDevice> {
  if (sessionPreferredDevice) return sessionPreferredDevice;
  if (!preflightPromise) {
    preflightPromise = probeWebGpuAdapter().then((probe) => {
      const preferred: InferenceDevice = probe.adapter ? 'webgpu' : 'wasm';
      if (!sessionPreferredDevice) sessionPreferredDevice = preferred;
      debugLog(
        `[offscreen] WebGPU preflight: supported=${probe.supported} adapter=${probe.adapter} → preferred=${preferred}`,
      );
      return sessionPreferredDevice ?? preferred;
    });
  }
  return preflightPromise;
}

function broadcastInferenceBackend(
  role: 'encoder' | 'sentiment',
  device: InferenceDevice,
  attempts?: string[],
): void {
  const msg: InferenceBackendMsg = {
    target: 'sidepanel',
    type: 'INFERENCE_BACKEND',
    role,
    device,
    ...(attempts ? { attempts } : {}),
  };
  chrome.runtime.sendMessage(msg).catch(() => {});
}

function onWorkerReady(
  role: 'encoder' | 'sentiment',
  device: InferenceDevice,
  attempts?: string[],
): void {
  sessionPreferredDevice = device;
  if (role === 'encoder') {
    workerDevice = device;
    encoderTuning = getBackendTuning(LOW_MEMORY, device);
    // Encoder reclaimed WebGPU while FinBERT is still warm → drop FinBERT so
    // both never sit on GPU together (transparent; next sentiment rebuilds).
    if (
      device === 'webgpu' &&
      sentimentWorker !== null &&
      sentimentWorkerDevice === 'webgpu' &&
      sentimentInFlight === 0
    ) {
      debugLog('[offscreen] tearing warm FinBERT — encoder reclaimed WebGPU');
      terminateSentimentWorker('Yielding GPU to encoder');
    }
  } else {
    sentimentWorkerDevice = device;
    sentimentTuning = getBackendTuning(LOW_MEMORY, device);
  }
  broadcastInferenceBackend(role, device, attempts);
}

/**
 * Keep-warm FinBERT only when it would not leave both models WebGPU-resident.
 * (Dual WebGPU residency spikes VRAM; WASM FinBERT keep-warm is fine.)
 */
function shouldKeepFinbertWarm(): boolean {
  if (DEVICE_MEMORY_GB < 8) return false;
  if (sentimentWorkerDevice === 'webgpu' && workerDevice === 'webgpu' && worker !== null) {
    return false;
  }
  return true;
}

// ── encoder worker state ──────────────────────────────────────────────────────

let worker: Worker | null = null;
let workerReady: Promise<'webgpu' | 'wasm'> | null = null;
let workerDevice: 'webgpu' | 'wasm' = 'wasm';
/** True once the current worker instance has completed a batch (cold JIT paid). */
let encoderBatchDone = false;

/** Pending EMBED request callbacks, keyed by correlation id. */
const pending = new Map<
  string,
  { resolve: (v: Float32Array[]) => void; reject: (e: Error) => void }
>();

let pendingInit: { resolve: (d: 'webgpu' | 'wasm') => void; reject: (e: Error) => void } | null =
  null;

// ── sentiment (FinBERT) worker state ──────────────────────────────────────────

let sentimentWorker: Worker | null = null;
let sentimentWorkerReady: Promise<'webgpu' | 'wasm'> | null = null;
let sentimentWorkerDevice: 'webgpu' | 'wasm' = 'wasm';
/** True once the current worker instance has completed a batch (cold JIT paid). */
let sentimentBatchDone = false;

/** Pending CLASSIFY request callbacks, keyed by correlation id. */
const sentimentPending = new Map<
  string,
  { resolve: (v: { labels: string[]; scores: number[] }) => void; reject: (e: Error) => void }
>();

let sentimentPendingInit: {
  resolve: (d: 'webgpu' | 'wasm') => void;
  reject: (e: Error) => void;
} | null = null;

let _classifyIdCounter = 0;

/**
 * Count of ANALYZE_SENTIMENT requests currently being processed. The sentiment
 * worker is only torn down when this returns to 0, so an overlapping/queued batch
 * is never terminated out from under an in-flight classification.
 */
let sentimentInFlight = 0;

// ── idle-unload ───────────────────────────────────────────────────────────────

let idleTimer: ReturnType<typeof setTimeout> | null = null;

function resetIdleTimer(): void {
  if (idleTimer !== null) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    debugLog('[offscreen] idle timeout — unloading workers');
    terminateWorkers();
    // Ask the SW to close this offscreen document.
    chrome.runtime.sendMessage({ target: 'sw', type: 'OFFSCREEN_IDLE' }).catch(() => {});
  }, IDLE_TIMEOUT_MS);
}

function terminateWorkers(): void {
  terminateEncoderWorker();
  terminateSentimentWorker();
}

/**
 * Tear down the encoder worker, settling EVERYTHING it owed: a caller blocked
 * in ensureWorker() (model still loading) and every in-flight embed batch.
 * Leaving any of these pending froze the panel's progress bar with no error
 * (the pre-fix behaviour). Nulling workerReady makes the next request rebuild
 * a fresh worker instead of reusing a corpse or a forever-rejected promise.
 */
function terminateEncoderWorker(reason = 'Worker terminated'): void {
  worker?.terminate();
  worker = null;
  workerReady = null;
  encoderBatchDone = false;
  pendingInit?.reject(new Error(`${reason} (during model load)`));
  pendingInit = null;
  for (const p of pending.values()) p.reject(new Error(reason));
  pending.clear();
}

/**
 * Tear down just the FinBERT sentiment worker, leaving the encoder worker (which
 * serves summaries + the redline semantic pass) untouched. Called after a
 * sentiment pass finishes so the ~1 GB peak FinBERT holds on WASM devices is freed
 * without waiting for the 5-minute idle unload (immediately on low-memory devices,
 * after a short keep-warm window otherwise — see scheduleSentimentTeardown).
 * ensureSentimentWorker() rebuilds a fresh worker (and re-INITs from the retained
 * constants) on the next request.
 */
function terminateSentimentWorker(reason = 'Worker terminated'): void {
  clearSentimentTeardownTimer();
  sentimentWorker?.terminate();
  sentimentWorker = null;
  sentimentWorkerReady = null;
  sentimentBatchDone = false;
  sentimentPendingInit?.reject(new Error(`${reason} (during model load)`));
  sentimentPendingInit = null;
  for (const p of sentimentPending.values()) p.reject(new Error(reason));
  sentimentPending.clear();
}

// ── FinBERT keep-warm ─────────────────────────────────────────────────────────

/**
 * Eager teardown frees FinBERT's ~1 GB WASM peak but repays full model load +
 * WASM compile on every pass. With ≥ 8 GB reported (Chrome caps the report at 8)
 * keep it warm briefly between passes; the 5-minute idle unload stays the
 * backstop. Low-memory devices keep today's eager teardown. Dual-WebGPU
 * residency is refused via shouldKeepFinbertWarm().
 */
const SENTIMENT_KEEP_WARM_MS = 90_000;
let sentimentTeardownTimer: ReturnType<typeof setTimeout> | null = null;

function clearSentimentTeardownTimer(): void {
  if (sentimentTeardownTimer !== null) {
    clearTimeout(sentimentTeardownTimer);
    sentimentTeardownTimer = null;
  }
}

function scheduleSentimentTeardown(): void {
  if (!shouldKeepFinbertWarm()) {
    terminateSentimentWorker();
    return;
  }
  clearSentimentTeardownTimer();
  sentimentTeardownTimer = setTimeout(() => {
    sentimentTeardownTimer = null;
    if (sentimentInFlight === 0) terminateSentimentWorker();
  }, SENTIMENT_KEEP_WARM_MS);
}

// ── worker message handler ────────────────────────────────────────────────────

function handleWorkerMsg(e: MessageEvent): void {
  const msg = e.data as WorkerOutbound;

  if (msg.type === 'READY') {
    // First READY resolves ensureWorker(); a later READY (mid-pass WASM fallback)
    // only retunes + broadcasts — never reject/re-resolve the settled promise.
    const isFirst = pendingInit !== null;
    onWorkerReady('encoder', msg.device, msg.diag?.attempts);
    if (msg.diag) debugLog(`[offscreen] encoder ready on ${msg.device} —`, msg.diag.attempts);
    if (isFirst) {
      pendingInit?.resolve(msg.device);
      pendingInit = null;
    }
    return;
  }

  if (msg.type === 'PROGRESS') {
    sendProgress('model_load', msg.progress, msg.file, msg.indeterminate);
    return;
  }

  if (msg.type === 'EMBED_RESULT') {
    const cb = pending.get(msg.id);
    if (cb) {
      encoderBatchDone = true;
      const vectors = msg.buffers.map((ab) => new Float32Array(ab));
      cb.resolve(vectors);
      pending.delete(msg.id);
    }
    return;
  }

  if (msg.type === 'ERROR') {
    if (msg.id) {
      const cb = pending.get(msg.id);
      if (cb) {
        cb.reject(new Error(msg.message));
        pending.delete(msg.id);
      }
    } else {
      // Init failed inside the worker. Reject the waiting ensureWorker() call
      // with the real error, then drop the dead-on-arrival worker so the next
      // request rebuilds instead of reusing a forever-rejected workerReady.
      pendingInit?.reject(new Error(msg.message));
      pendingInit = null;
      terminateEncoderWorker(msg.message);
    }
  }
}

// ── worker lifecycle ──────────────────────────────────────────────────────────

function ensureWorker(): Promise<'webgpu' | 'wasm'> {
  if (workerReady) return workerReady;

  workerReady = (async () => {
    const preferredDevice = await resolvePreferredDevice();

    const device = await new Promise<'webgpu' | 'wasm'>((resolve, reject) => {
      pendingInit = { resolve, reject };

      worker = new Worker(new URL('../workers/encoder.worker.ts', import.meta.url), {
        type: 'module',
      });
      worker.onmessage = handleWorkerMsg;
      worker.onerror = (ev) => {
        terminateEncoderWorker(ev.message ? `Worker crashed: ${ev.message}` : 'Worker crashed');
      };

      const wasmPaths = chrome.runtime.getURL('wasm/');
      const modelBasePath = chrome.runtime.getURL('models/');
      const initMsg: WorkerInitMsg = {
        type: 'INIT',
        wasmPaths,
        modelBasePath,
        modelId: MODEL_ID,
        numThreads: ORT_NUM_THREADS,
        preferredDevice,
      };
      worker.postMessage(initMsg);
    });

    // WebGPU-only warmup: pay shader/ORT compile before the first user batch.
    // Soft-fail: if warmup errors after READY, still return the device (deadlines
    // / next real call handle hard failures). WASM skips warmup.
    if (device === 'webgpu') {
      try {
        await embedBatch(['Relic warmup.']);
      } catch (err) {
        debugLog('[offscreen] encoder warmup soft-failed:', err);
      }
    }

    return device;
  })().catch((err) => {
    workerReady = null;
    throw err;
  });

  return workerReady;
}

// ── embed helper ──────────────────────────────────────────────────────────────

let _embedIdCounter = 0;

function embedBatch(texts: string[]): Promise<Float32Array[]> {
  // A teardown can race the sibling concurrency lane — fail fast instead of
  // posting to a dead worker.
  if (!worker) return Promise.reject(new Error('Encoder worker not available'));
  const id = `e${++_embedIdCounter}`;
  const ms = encoderBatchDone ? WARM_BATCH_TIMEOUT_MS : COLD_BATCH_TIMEOUT_MS;
  const handle = settleWithDeadline<Float32Array[]>({
    ms,
    timeoutError: () => new Error(`Embedding batch timed out after ${Math.round(ms / 1000)}s`),
    onTimeout: () => {
      // Drop self first so the teardown sweep below doesn't consume this
      // entry, then tear the wedged worker down — settling every sibling and
      // nulling workerReady so the next request rebuilds fresh.
      pending.delete(id);
      terminateEncoderWorker('Encoder worker unresponsive');
    },
  });
  pending.set(id, { resolve: handle.resolve, reject: handle.reject });
  worker.postMessage({ type: 'EMBED', id, texts });
  return handle.promise;
}

/**
 * Embed an array of texts in mini-batches of EMBED_BATCH with EMBED_CONCURRENCY
 * parallel calls. Reports embedding progress via sendProgress.
 */
async function embedAll(texts: string[]): Promise<Float32Array[]> {
  const results: Float32Array[] = new Array(texts.length);
  let done = 0;
  const { embedBatch: batchSize, embedConcurrency } = encoderTuning;

  // Slice into batches.
  const batches: Array<{ start: number; texts: string[] }> = [];
  for (let i = 0; i < texts.length; i += batchSize) {
    batches.push({ start: i, texts: texts.slice(i, i + batchSize) });
  }

  // Process with controlled concurrency.
  let batchIdx = 0;

  async function processNext(): Promise<void> {
    while (batchIdx < batches.length) {
      const b = batches[batchIdx++]!;
      const vecs = await embedBatch(b.texts);
      // Each completed batch proves the pipeline is alive: a legitimately long
      // pass (large doc on low-end WASM) must not be torn down by the idle
      // timer mid-flight.
      resetIdleTimer();
      for (let j = 0; j < vecs.length; j++) {
        results[b.start + j] = vecs[j]!;
      }
      done += b.texts.length;
      sendProgress('embedding', done / texts.length);
    }
  }

  const workers = Array.from({ length: embedConcurrency }, processNext);
  await Promise.all(workers);
  return results;
}

// ── sentiment worker message handler ─────────────────────────────────────────

function handleSentimentWorkerMsg(e: MessageEvent): void {
  const msg = e.data as SentimentWorkerOutbound;

  if (msg.type === 'READY') {
    const isFirst = sentimentPendingInit !== null;
    onWorkerReady('sentiment', msg.device, msg.diag?.attempts);
    if (msg.diag) debugLog(`[offscreen] FinBERT ready on ${msg.device} —`, msg.diag.attempts);
    if (isFirst) {
      sentimentPendingInit?.resolve(msg.device);
      sentimentPendingInit = null;
    }
    return;
  }

  if (msg.type === 'PROGRESS') {
    sendSentimentProgress('model_load', msg.progress, msg.file, msg.indeterminate);
    return;
  }

  if (msg.type === 'CLASSIFY_RESULT') {
    const m = msg as SentimentWorkerClassifyResultMsg;
    const cb = sentimentPending.get(m.id);
    if (cb) {
      sentimentBatchDone = true;
      cb.resolve({ labels: m.labels, scores: m.scores });
      sentimentPending.delete(m.id);
    }
    return;
  }

  if (msg.type === 'ERROR') {
    if (msg.id) {
      const cb = sentimentPending.get(msg.id);
      if (cb) {
        cb.reject(new Error(msg.message));
        sentimentPending.delete(msg.id);
      }
    } else {
      // Init failed inside the worker — reject the waiter, drop the DOA worker
      // so the next request rebuilds (mirrors handleWorkerMsg).
      sentimentPendingInit?.reject(new Error(msg.message));
      sentimentPendingInit = null;
      terminateSentimentWorker(msg.message);
    }
  }
}

// ── sentiment worker lifecycle ────────────────────────────────────────────────

function ensureSentimentWorker(): Promise<'webgpu' | 'wasm'> {
  if (sentimentWorkerReady) return sentimentWorkerReady;

  sentimentWorkerReady = (async () => {
    const preferredDevice = await resolvePreferredDevice();

    const device = await new Promise<'webgpu' | 'wasm'>((resolve, reject) => {
      sentimentPendingInit = { resolve, reject };

      sentimentWorker = new Worker(new URL('../workers/sentiment.worker.ts', import.meta.url), {
        type: 'module',
      });
      sentimentWorker.onmessage = handleSentimentWorkerMsg;
      sentimentWorker.onerror = (ev) => {
        terminateSentimentWorker(
          ev.message ? `Worker crashed: ${ev.message}` : 'Worker crashed',
        );
      };

      const wasmPaths = chrome.runtime.getURL('wasm/');
      const modelBasePath = chrome.runtime.getURL('models/');
      sentimentWorker.postMessage({
        type: 'INIT',
        wasmPaths,
        modelBasePath,
        modelId: FINBERT_MODEL_ID,
        numThreads: ORT_NUM_THREADS,
        preferredDevice,
      } satisfies WorkerInitMsg);
    });

    if (device === 'webgpu') {
      try {
        await classifyBatch(['Revenue increased modestly.']);
      } catch (err) {
        debugLog('[offscreen] FinBERT warmup soft-failed:', err);
      }
    }

    return device;
  })().catch((err) => {
    sentimentWorkerReady = null;
    throw err;
  });

  return sentimentWorkerReady;
}

// ── classify helper ───────────────────────────────────────────────────────────

function classifyBatch(texts: string[]): Promise<{ labels: string[]; scores: number[] }> {
  if (!sentimentWorker) return Promise.reject(new Error('Sentiment worker not available'));
  const id = `c${++_classifyIdCounter}`;
  const ms = sentimentBatchDone ? WARM_BATCH_TIMEOUT_MS : COLD_BATCH_TIMEOUT_MS;
  const handle = settleWithDeadline<{ labels: string[]; scores: number[] }>({
    ms,
    timeoutError: () => new Error(`Sentiment batch timed out after ${Math.round(ms / 1000)}s`),
    onTimeout: () => {
      sentimentPending.delete(id);
      terminateSentimentWorker('FinBERT worker unresponsive');
    },
  });
  sentimentPending.set(id, { resolve: handle.resolve, reject: handle.reject });
  sentimentWorker.postMessage({ type: 'CLASSIFY', id, texts });
  return handle.promise;
}

/**
 * Classify an array of texts in mini-batches with CLASSIFY_CONCURRENCY. Calls
 * `onBatch` after each batch with its sentence count and wall-clock latency so the
 * caller can drive a document-level progress bar + rolling-average ETA that spans
 * every section (classifyAll is invoked once per section).
 */
async function classifyAll(
  texts: string[],
  onBatch?: (info: { count: number; ms: number }) => void,
): Promise<{ labels: string[]; scores: number[] }> {
  const allLabels: string[] = new Array(texts.length) as string[];
  const allScores: number[] = new Array(texts.length) as number[];
  const { classifyBatch: batchSize, classifyConcurrency } = sentimentTuning;

  const batches: Array<{ start: number; texts: string[] }> = [];
  for (let i = 0; i < texts.length; i += batchSize) {
    batches.push({ start: i, texts: texts.slice(i, i + batchSize) });
  }

  let batchIdx = 0;

  async function processNext(): Promise<void> {
    while (batchIdx < batches.length) {
      const b = batches[batchIdx++]!;
      const tBatch = performance.now();
      const { labels, scores } = await classifyBatch(b.texts);
      // Keep a long low-end WASM pass alive past the 5-minute idle unload.
      resetIdleTimer();
      const ms = performance.now() - tBatch;
      for (let j = 0; j < b.texts.length; j++) {
        allLabels[b.start + j] = labels[j] ?? 'neutral';
        allScores[b.start + j] = scores[j] ?? 0;
      }
      onBatch?.({ count: b.texts.length, ms });
    }
  }

  const workers = Array.from({ length: classifyConcurrency }, processNext);
  await Promise.all(workers);
  return { labels: allLabels, scores: allScores };
}

// ── sentiment progress broadcast ─────────────────────────────────────────────

function sendSentimentProgress(
  stage: SentimentProgressMsg['stage'],
  progress: number,
  detail?: string,
  indeterminate?: boolean,
): void {
  const msg: SentimentProgressMsg = {
    target: 'sidepanel',
    type: 'SENTIMENT_PROGRESS',
    stage,
    progress: Math.max(0, Math.min(1, progress)),
    ...(detail ? { detail } : {}),
    ...(indeterminate ? { indeterminate: true } : {}),
  };
  chrome.runtime.sendMessage(msg).catch(() => {});
}

/**
 * Human-readable classifying-stage detail with a remaining-time estimate, e.g.
 * "Scoring Risk Factors… about 40s left". `etaMs` is derived from a rolling
 * average of per-sentence latency (see analyzeSentiment); non-finite or ≤0 values
 * degrade gracefully to just the section name.
 */
function classifyingDetail(sectionLabel: string, etaMs: number): string {
  const base = `Scoring ${sectionLabel}`;
  if (!Number.isFinite(etaMs) || etaMs <= 0) return `${base}…`;
  const secs = Math.ceil(etaMs / 1000);
  if (secs <= 3) return `${base}… almost done`;
  if (secs < 90) return `${base}… about ${secs}s left`;
  return `${base}… about ${Math.round(secs / 60)} min left`;
}

// ── ANALYZE_SENTIMENT ─────────────────────────────────────────────────────────

/**
 * Run FinBERT sentiment classification for all sections of a filing.
 *
 * Algorithm:
 *   1. Check IDB cache (same rawTextHash + modelId → skip inference).
 *   2. splitSentences() on each section.text; filter out table-overlapping sentences.
 *   3. classifyAll() via the sentiment worker (CLASSIFY_BATCH=8 sentences/call).
 *   4. Lift section-space ranges → DOCUMENT-space (section.charRange[0] + offset).
 *   5. Emit SENTIMENT_SECTION_DONE to side panel (progressive highlighting).
 *   6. Persist full results to IDB.
 *
 * Table exclusion: section.tables contains DOCUMENT-space [start,end) ranges.
 * Each sentence's DOCUMENT-space position is checked against those ranges.
 */
async function analyzeSentiment(
  rawTextHash: string,
  sections: Section[],
): Promise<SentimentResponse> {
  resetIdleTimer();

  const t0 = performance.now();

  // ── 1. IDB cache check ──────────────────────────────────────────────────────
  const cached = await getSentimentCache(rawTextHash, FINBERT_MODEL_ID);
  if (cached) {
    const elapsed = Math.round(performance.now() - t0);
    debugLog(`[offscreen] sentiment cache hit for ${rawTextHash} (${cached.length} results)`);

    // Replay section-done events for progressive highlighting from cache.
    const bySectionId = new Map<string, SentenceSentiment[]>();
    for (const r of cached) {
      const arr = bySectionId.get(r.sectionId);
      if (arr) {
        arr.push(r);
      } else {
        bySectionId.set(r.sectionId, [r]);
      }
    }
    sections.forEach((sec, idx) => {
      const results = bySectionId.get(sec.id) ?? [];
      const doneMsg: SentimentSectionDoneMsg = {
        target: 'sidepanel',
        type: 'SENTIMENT_SECTION_DONE',
        sectionId: sec.id,
        sectionIdx: idx,
        totalSections: sections.length,
        results,
        elapsedMs: 0,
      };
      chrome.runtime.sendMessage(doneMsg).catch(() => {});
    });

    return {
      ok: true,
      rawTextHash,
      totalSentences: cached.length,
      elapsedMs: elapsed,
      fromCache: true,
    };
  }

  // ── 2. Load model ───────────────────────────────────────────────────────────
  sendSentimentProgress('model_load', 0, 'Loading FinBERT…');
  const tModel = performance.now();
  const device = await ensureSentimentWorker();
  debugLog(`[offscreen] FinBERT ready on ${device} in ${(performance.now() - tModel).toFixed(0)} ms`);
  sendSentimentProgress('model_load', 1);

  // Yield the encoder's WebGPU residency while FinBERT classifies so peak VRAM
  // stays bounded. Encoder rebuilds lazily on the next summary/redline request.
  if (
    sentimentWorkerDevice === 'webgpu' &&
    worker !== null &&
    workerDevice === 'webgpu'
  ) {
    debugLog('[offscreen] yielding encoder WebGPU to FinBERT');
    terminateEncoderWorker('Yielding GPU to FinBERT');
  }

  // ── 3. Prepare sentences for every section, in PRIORITY order ─────────────────
  // Score MD&A + Risk Factors first (the sections investors actually read, via the
  // analyst relevance ranking) so their highlights land within seconds while
  // boilerplate finishes in the background. Splitting up front also yields the
  // document-wide sentence count the ETA needs.
  const totalSections = sections.length;
  const prepared = [...sections]
    .sort((a, b) => sectionPriority(a) - sectionPriority(b))
    .map((section) => ({
      section,
      // Filter sentences overlapping table regions (DOCUMENT-space check), keeping
      // each survivor's index into the ORIGINAL sentence array so highlight offsets
      // don't drift on sections that contain tables.
      nonTableSentences: filterNonTableSentences(
        splitSentences(section.text),
        section.charRange[0],
        section.tables,
      ),
    }));
  const totalSentences = prepared.reduce((n, p) => n + p.nonTableSentences.length, 0);

  // ── 4. Classify in priority order — stream per-section results + a rolling ETA ─
  const allResults: SentenceSentiment[] = [];
  let doneSentences = 0;
  let msPerSentence = 0; // exponential moving average of per-sentence latency

  // Surface the first section immediately so the bar leaves "Loading FinBERT" even
  // while the (possibly cold) first threaded batch is still running.
  const firstLabel = prepared.find((p) => p.nonTableSentences.length > 0)?.section.label;
  sendSentimentProgress('classifying', 0, firstLabel ? `Scoring ${firstLabel}…` : 'Scoring…');

  for (let processed = 0; processed < prepared.length; processed++) {
    const { section, nonTableSentences } = prepared[processed]!;
    const tSection = performance.now();

    if (nonTableSentences.length === 0) {
      const doneMsg: SentimentSectionDoneMsg = {
        target: 'sidepanel',
        type: 'SENTIMENT_SECTION_DONE',
        sectionId: section.id,
        sectionIdx: processed,
        totalSections,
        results: [],
        elapsedMs: 0,
      };
      chrome.runtime.sendMessage(doneMsg).catch(() => {});
      continue;
    }

    const texts = nonTableSentences.map(({ sent }) => sent.text);
    const { labels, scores } = await classifyAll(texts, ({ count, ms }) => {
      doneSentences += count;
      const per = ms / Math.max(1, count);
      msPerSentence = msPerSentence === 0 ? per : msPerSentence * 0.7 + per * 0.3;
      const remaining = Math.max(0, totalSentences - doneSentences);
      sendSentimentProgress(
        'classifying',
        totalSentences === 0 ? 1 : doneSentences / totalSentences,
        classifyingDetail(section.label, remaining * msPerSentence),
      );
    });

    const sectionResults: SentenceSentiment[] = [];
    for (let i = 0; i < nonTableSentences.length; i++) {
      const { sent, origIdx } = nonTableSentences[i]!;
      const label = labels[i] ?? 'neutral';
      const score = scores[i] ?? 0;

      const docRange: [number, number] = [
        section.charRange[0] + sent.range[0],
        section.charRange[0] + sent.range[1],
      ];

      // Confidence-floor calibration: low-score positive/negative → neutral, so
      // boilerplate/legal prose isn't painted with confident sentiment colour.
      const sentimentLabel = calibrateSentimentLabel(label, score);

      sectionResults.push({
        sectionId: section.id,
        sentenceIdx: origIdx,
        label: sentimentLabel,
        score,
        range: docRange,
      });
    }

    allResults.push(...sectionResults);

    const sectionElapsed = Math.round(performance.now() - tSection);
    debugLog(
      `[offscreen] sentiment: ${section.id} — ${nonTableSentences.length} sentences in ${sectionElapsed} ms`,
    );

    const doneMsg: SentimentSectionDoneMsg = {
      target: 'sidepanel',
      type: 'SENTIMENT_SECTION_DONE',
      sectionId: section.id,
      sectionIdx: processed,
      totalSections,
      results: sectionResults,
      elapsedMs: sectionElapsed,
    };
    chrome.runtime.sendMessage(doneMsg).catch(() => {});
  }

  // ── 5. Persist to IDB ──────────────────────────────────────────────────────
  await putSentimentCache(rawTextHash, FINBERT_MODEL_ID, allResults);

  const elapsed = Math.round(performance.now() - t0);
  sendSentimentProgress('complete', 1);
  debugLog(
    `[offscreen] sentiment complete: ${allResults.length} sentences in ${elapsed} ms`,
  );

  return {
    ok: true,
    rawTextHash,
    totalSentences: allResults.length,
    elapsedMs: elapsed,
    fromCache: false,
  };
}

// ── progress broadcast ────────────────────────────────────────────────────────

function sendProgress(
  stage: EmbedProgressMsg['stage'],
  progress: number,
  detail?: string,
  indeterminate?: boolean,
): void {
  const msg: EmbedProgressMsg = {
    target: 'sidepanel',
    type: 'EMBED_PROGRESS',
    stage,
    progress: Math.max(0, Math.min(1, progress)),
    ...(detail ? { detail } : {}),
    ...(indeterminate ? { indeterminate: true } : {}),
  };
  chrome.runtime.sendMessage(msg).catch(() => {}); // ignore if side panel is closed
}

// ── EXTRACTIVE_SUMMARIZE ──────────────────────────────────────────────────────

/**
 * Sentence-centrality extractive summarization for one section.
 * The encoder worker init is idempotent and shared with the redline semantic pass.
 */
async function extractiveSummarize(
  sectionText: string,
  charStart = 0,
  tables?: ReadonlyArray<readonly [number, number]>,
): Promise<ExtractiveResponse> {
  resetIdleTimer();

  const spans = filterNonTableSentences(
    splitSentences(sectionText),
    charStart,
    tables,
  ).map(({ sent }) => sent);

  // Trivial cases — no embeddings needed.
  if (spans.length === 0) {
    const trimmed = sectionText.trim();
    if (!trimmed) return { ok: true, sentences: [] };
    return {
      ok: true,
      sentences: [{ text: trimmed, range: [0, trimmed.length], score: 1 }],
    };
  }
  if (spans.length === 1) {
    return { ok: true, sentences: [{ ...spans[0]!, score: 1 }] };
  }

  sendProgress('model_load', 0, 'Initializing encoder…');
  await ensureWorker();
  sendProgress('model_load', 1);

  sendProgress('embedding', 0, `Embedding ${spans.length} sentences…`);
  const texts = spans.map((s) => s.text);
  const embeddings = await embedAll(texts);
  sendProgress('embedding', 1);

  const ranked = rankByCentrality(spans, embeddings);
  const n = targetSentenceCount(sectionText.length);
  const top = selectTopN(ranked, n);

  return { ok: true, sentences: top };
}

// ── EMBED_TEXTS (Session E2 — semantic excerpt reranking) ────────────────────

/**
 * Embed an arbitrary batch of texts for a caller-side reranking blend (the
 * analyst pipeline's semantic excerpt selector). Shares the same encoder
 * worker/lifecycle as extractive summarization and the redline semantic pass.
 */
async function embedTexts(m: OffscreenEmbedMsg): Promise<EmbedTextsResponse> {
  resetIdleTimer();
  if (m.texts.length === 0) return { ok: true, vectors: [] };
  await ensureWorker();
  const vectors = await embedAll(m.texts);
  return { ok: true, vectors };
}

// ── COMPUTE_REDLINE (Session 6) ───────────────────────────────────────────────

function sendRedlineProgress(stage: RedlineStage, progress: number, detail?: string): void {
  const msg: RedlineProgressMsg = {
    target: 'sidepanel',
    type: 'REDLINE_PROGRESS',
    stage,
    progress: Math.max(0, Math.min(1, progress)),
    ...(detail ? { detail } : {}),
  };
  chrome.runtime.sendMessage(msg).catch(() => {});
}

/**
 * Diff one matched section with the embedding-backed SEMANTIC pass.
 * Textual structural diff first; if there are leftover added AND removed
 * sentences, embed both sides and pair by cosine similarity so cosmetic
 * rewordings drop out and meaning-changing rewordings surface as word-level spans.
 */
async function diffSectionSemantic(currentText: string, priorText: string): Promise<SectionDiffCore> {
  const td = structuralDiff(currentText, priorText);

  // Nothing to pair → the textual diff is already final (Jaccard wording pass only).
  if (td.addedIdx.length === 0 || td.removedIdx.length === 0) {
    return assembleSectionDiff(td);
  }

  await ensureWorker();

  const addedTexts = td.addedIdx.map((i) => td.currentSentences[i]!.text);
  const removedTexts = td.removedIdx.map((i) => td.priorSentences[i]!.text);
  const [addedEmb, removedEmb] = await Promise.all([embedAll(addedTexts), embedAll(removedTexts)]);

  const addedPos = new Map<number, number>();
  td.addedIdx.forEach((sentIdx, pos) => addedPos.set(sentIdx, pos));
  const removedPos = new Map<number, number>();
  td.removedIdx.forEach((sentIdx, pos) => removedPos.set(sentIdx, pos));

  const similarity: Similarity = (_a, _b, aIdx, rIdx) => {
    const ai = addedPos.get(aIdx);
    const ri = removedPos.get(rIdx);
    if (ai === undefined || ri === undefined) return 0;
    return cosineSim(addedEmb[ai]!, removedEmb[ri]!);
  };

  // cosine ≥ 0.97 → cosmetic (drop); 0.82..0.97 → reworded (word-level spans).
  return assembleSectionDiff(td, { similarity, rewordMin: 0.82, cosmeticMin: 0.97 });
}

async function computeRedline(m: OffscreenRedlineMsg): Promise<RedlineResponse> {
  resetIdleTimer();

  // 1. Parse the prior filing into a DocumentModel.
  sendRedlineProgress('parsing', 0.1, 'Parsing prior filing…');
  let priorModel: DocumentModel;
  try {
    priorModel = parsePriorFiling(m.priorHtml, m.priorUrl);
  } catch (e) {
    return { ok: false, error: `Prior filing parse failed: ${String(e)}` };
  }

  // 2. Align sections (all of them, for the alignment summary list). A bounded
  // token-Jaccard fallback re-pairs sections that were renumbered/renamed across
  // years (so they aren't read as added+removed → a misleading "no changes").
  sendRedlineProgress('aligning', 0.3, 'Aligning sections…');
  const SIM_SAMPLE = 4_000; // cap per-section text sampled for similarity
  const alignment = alignSections(m.doc.sections, priorModel.sections, {
    similarity: (c, p) => jaccardSimilarity(c.text.slice(0, SIM_SAMPLE), p.text.slice(0, SIM_SAMPLE)),
  });
  const alignmentSummary: AlignmentSummary[] = alignment.map((a) => ({
    id: a.id,
    label: a.label,
    status: a.status,
  }));

  // 3. Diff the focus sections (matched → semantic; added/removed → whole-section).
  const focusAligns = focusAlignments(alignment);

  // Fail loud, not empty: if this filing type produced ZERO focus-section matches,
  // the Changes tab has no coverage for it. Returning an empty diff here would read
  // to the user as "no changes" — a silent no-op (M1). Surface an explicit status
  // instead so the panel can say the form isn't supported yet. This guard protects
  // every current and future filing type, not just 20-F.
  if (focusAligns.length === 0) {
    sendRedlineProgress('complete', 1);
    return {
      ok: true,
      status: 'unsupported_form',
      diffs: [],
      stats: {},
      prior: m.priorInfo,
      alignment: alignmentSummary,
    };
  }

  const diffs: SectionDiff[] = [];
  const stats: Record<string, SectionDiffCore['stats']> = {};
  let core: SectionDiffCore;

  for (let i = 0; i < focusAligns.length; i++) {
    const a = focusAligns[i]!;
    sendRedlineProgress('diffing', 0.5 + 0.45 * (i / Math.max(1, focusAligns.length)), `Diffing ${a.label}…`);

    if (a.status === 'matched' && a.current && a.prior) {
      core = await diffSectionSemantic(a.current.text, a.prior.text);
    } else if (a.status === 'added' && a.current) {
      core = diffSection(a.current.text, ''); // entire section is new
    } else if (a.status === 'removed' && a.prior) {
      core = diffSection('', a.prior.text); // entire section was dropped
    } else {
      continue;
    }

    diffs.push({
      sectionId: a.id,
      added: core.added,
      removed: core.removed,
      magnitude: core.magnitude,
      summary: templatedChangeSummary(core.stats),
    });
    stats[a.id] = core.stats;
  }

  sendRedlineProgress('complete', 1);

  return {
    ok: true,
    status: 'computed',
    diffs,
    stats,
    prior: m.priorInfo,
    alignment: alignmentSummary,
  };
}

// ── message listener ──────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener(
  (
    rawMsg: unknown,
    _sender: chrome.runtime.MessageSender,
    sendResponse: (r: unknown) => void,
  ): boolean => {
    const msg = rawMsg as { target?: string; type?: string };
    if (msg.target !== 'offscreen') return false;

    if (msg.type === 'EXTRACTIVE_SUMMARIZE') {
      const m = msg as OffscreenExtractiveMsg;
      extractiveSummarize(m.sectionText, m.charStart ?? 0, m.tables)
        .then(sendResponse)
        .catch((err: unknown) => sendResponse({ ok: false, error: String(err) }));
      return true;
    }

    if (msg.type === 'ANALYZE_SENTIMENT') {
      const m = msg as OffscreenSentimentMsg;
      sentimentInFlight++;
      clearSentimentTeardownTimer();
      analyzeSentiment(m.rawTextHash, m.sections)
        .then(sendResponse)
        .catch((err: unknown) => sendResponse({ ok: false, error: String(err) }))
        .finally(() => {
          // Free FinBERT after the last sentiment request drains — results are
          // cached by content hash upstream, so a re-request re-initializes cheaply.
          // The encoder worker stays alive for summaries/redline. Devices with
          // memory headroom get a short keep-warm window first (see
          // scheduleSentimentTeardown); only tear down when nothing is in flight.
          if (--sentimentInFlight === 0) scheduleSentimentTeardown();
        });
      return true;
    }

    if (msg.type === 'COMPUTE_REDLINE') {
      const m = msg as OffscreenRedlineMsg;
      computeRedline(m)
        .then(sendResponse)
        .catch((err: unknown) => sendResponse({ ok: false, error: String(err) }));
      return true;
    }

    if (msg.type === 'EMBED_TEXTS') {
      const m = msg as OffscreenEmbedMsg;
      embedTexts(m)
        .then(sendResponse)
        .catch((err: unknown) => sendResponse({ ok: false, error: String(err) }));
      return true;
    }

    if (msg.type === 'PARSE_PDF') {
      const m = msg as OffscreenParsePdfMsg;
      parsePdf(base64ToBytes(m.bytesB64))
        .then(({ text, pages }) => sendResponse({ ok: true, text, pages } satisfies ParsePdfResponse))
        .catch((err: unknown) =>
          sendResponse({ ok: false, error: String(err) } satisfies ParsePdfResponse),
        );
      return true;
    }

    return false;
  },
);

debugLog('[Relic offscreen] ready — device will be selected on first embed request');
// Confirms threaded ORT actually engaged and which memory profile was chosen
// (used when benchmarking the WASM path / verifying low-end tuning).
debugLog(
  `[Relic offscreen] crossOriginIsolated=${self.crossOriginIsolated}, ORT threads=${ORT_NUM_THREADS}, ` +
    `deviceMemory=${DEVICE_MEMORY_GB}GB (lowMemory=${LOW_MEMORY}), ` +
    `default tuning EMBED ${encoderTuning.embedBatch}×${encoderTuning.embedConcurrency}, ` +
    `CLASSIFY ${sentimentTuning.classifyBatch}×${sentimentTuning.classifyConcurrency} (WASM until READY)`,
);
