// ============================================================
// Relic — FinBERT sentiment Web Worker (Session 4)
// ------------------------------------------------------------
// RULES (same as encoder.worker.ts):
//   - MUST NEVER reference chrome.* (plain Web Worker).
//   - All URLs / paths arrive via the INIT message from offscreen.
//   - Selects device:'webgpu' with try/catch fallback to device:'wasm'.
//
// Model: ProsusAI/finbert — Xenova ONNX export preferred.
//   text-classification → { label, score } per sentence.
//   Labels normalised to lowercase: 'positive'|'negative'|'neutral'.
//
// Performance targets (from spec):
//   - First sentiment overlay < 3 s (warm inference)
//   - Full 10-K sentiment pass < 30 s with WebGPU
// ============================================================

import { pipeline } from '@huggingface/transformers';
import type {
  SentimentWorkerOutbound,
  WorkerProgressMsg,
  SentimentWorkerClassifyResultMsg,
} from '@/messages/types';
import { configureBundledModelEnv } from '@/workers/transformersEnv';
import { createLoadProgressTracker } from '@/workers/modelSizes';
import { resolveBackendOrder, type InferenceDevice } from '@/workers/backendOrder';
import { isWebGpuFatalError, watchWebGpuDeviceLost } from '@/workers/webgpuLost';
import { debugLog } from '@/lib/debug';

// The text-classification pipeline is callable: (texts, opts) => Promise<result>.
// Transformers.js v4: array input with topk=1 returns Array<{label, score}>.
type SentimentItem = { label: string; score: number };
type ClassificationPipeline = (
  texts: string | string[],
  opts?: { topk?: number },
) => Promise<SentimentItem | SentimentItem[] | Array<SentimentItem[]>>;

// ── state ─────────────────────────────────────────────────────────────────────

let classifier: ClassificationPipeline | null = null;
let activeDevice: InferenceDevice = 'wasm';
// Remembered INIT params + one-shot shared guard for a mid-inference WebGPU
// failure → re-init once on WASM and retry (see tryWasmFallback below).
let initParams: {
  wasmPaths: string;
  modelBasePath: string;
  modelId: string;
  numThreads: number;
} | null = null;
let wasmFallback: Promise<boolean> | null = null;
let unwatchDeviceLost: (() => void) | null = null;

function post(msg: SentimentWorkerOutbound): void {
  self.postMessage(msg);
}

function clearDeviceLostWatch(): void {
  unwatchDeviceLost?.();
  unwatchDeviceLost = null;
}

/**
 * Recover from a mid-inference WebGPU failure by re-initializing once on WASM.
 * Shared promise so concurrent failing requests trigger a single re-init.
 */
function tryWasmFallback(): Promise<boolean> {
  if (activeDevice !== 'webgpu' || !initParams) return Promise.resolve(false);
  if (!wasmFallback) {
    const p = initParams;
    const prev = classifier;
    classifier = null;
    clearDeviceLostWatch();
    debugLog('[sentiment.worker] inference failed on WebGPU — re-initializing on WASM');
    wasmFallback = (async () => {
      try {
        const disposable = prev as unknown as { dispose?: () => Promise<void> | void };
        if (typeof disposable?.dispose === 'function') await disposable.dispose();
      } catch (err) {
        debugLog('[sentiment.worker] dispose before WASM fallback failed:', err);
      }
      await init(p.wasmPaths, p.modelBasePath, p.modelId, p.numThreads, true, 'wasm');
      return classifier !== null;
    })();
  }
  return wasmFallback;
}

// ── init ──────────────────────────────────────────────────────────────────────

async function init(
  wasmPaths: string,
  modelBasePath: string,
  modelId: string,
  numThreads: number,
  forceWasm = false,
  preferredDevice?: InferenceDevice,
): Promise<void> {
  initParams = { wasmPaths, modelBasePath, modelId, numThreads };
  configureBundledModelEnv(wasmPaths, modelBasePath, numThreads);
  clearDeviceLostWatch();

  const t0 = performance.now();

  // Bundled chrome-extension:// responses carry no Content-Length, so the raw
  // event's `progress` field pegs to ~100% immediately. Derive a REAL fraction
  // from `loaded` bytes against the build-time size manifest instead.
  const progressCallback = createLoadProgressTracker(modelId, (e) => {
    const msg: WorkerProgressMsg = { type: 'PROGRESS', progress: e.progress };
    if (e.file !== undefined) msg.file = e.file;
    if (e.indeterminate) msg.indeterminate = true;
    post(msg);
  });

  // Deterministic backend order: WebGPU first (fast), then WASM. `forceWasm` /
  // preferredDevice:'wasm' skips straight to WASM.
  const order = resolveBackendOrder(forceWasm, preferredDevice);
  const attempts: string[] = [];

  for (const device of order) {
    try {
      classifier = (await pipeline('text-classification', modelId, {
        device,
        // Quantized int8 weights are what ship bundled (see scripts/fetch-models.mjs).
        dtype: 'q8',
        progress_callback: progressCallback,
      })) as unknown as ClassificationPipeline;
      activeDevice = device;
      attempts.push(`${device}: ok`);
      const elapsed = (performance.now() - t0).toFixed(0);
      debugLog(`[sentiment.worker] FinBERT loaded on ${device} in ${elapsed} ms`);
      break;
    } catch (err) {
      attempts.push(`${device}: ${String(err)}`);
      debugLog(`[sentiment.worker] ${device} backend failed:`, err);
      if (isWebGpuFatalError(err)) {
        debugLog('[sentiment.worker] WebGPU fatal during init — continuing to next backend');
      }
    }
  }

  if (!classifier) {
    // Surface every backend's failure — the WebGPU error carries the missing-module
    // URL that the old code hid behind a console.debug. (Q9.)
    post({ type: 'ERROR', message: `Failed to load FinBERT: ${attempts.join(' | ')}` });
    return;
  }

  if (activeDevice === 'webgpu') {
    unwatchDeviceLost = watchWebGpuDeviceLost(() => {
      void tryWasmFallback();
    });
  }

  post({ type: 'READY', device: activeDevice, diag: { wasmPaths, attempts } });
}

// ── classify ──────────────────────────────────────────────────────────────────

/**
 * Normalise Transformers.js v4 text-classification output to a flat array.
 * The pipeline returns different shapes depending on single vs. array input,
 * topk, and model configuration — this handles all variants defensively.
 */
function normaliseOutput(
  raw: SentimentItem | SentimentItem[] | Array<SentimentItem[]>,
  expected: number,
): SentimentItem[] {
  // Nested array: [[{label, score}], [{label, score}], ...] (topk per text)
  if (Array.isArray(raw) && Array.isArray(raw[0])) {
    return (raw as Array<SentimentItem[]>).map((inner) => {
      const first = inner[0];
      return first ?? { label: 'neutral', score: 0 };
    });
  }

  // Flat array: [{label, score}, {label, score}, ...] (one per text)
  if (Array.isArray(raw)) {
    const flat = raw as SentimentItem[];
    if (flat.length === expected) return flat;
    // Single-element array wrapping one result
    const first = flat[0];
    return first ? [first] : [{ label: 'neutral', score: 0 }];
  }

  // Single object: {label, score} (when called with a single string)
  return [raw as SentimentItem];
}

async function classify(id: string, texts: string[]): Promise<void> {
  if (!classifier) {
    post({ type: 'ERROR', id, message: 'Classifier not initialised — send INIT first.' });
    return;
  }

  try {
    const t0 = performance.now();

    // topk:1 → we want only the winning label per sentence.
    const raw = await classifier(texts, { topk: 1 });

    const items = normaliseOutput(
      raw as SentimentItem | SentimentItem[] | Array<SentimentItem[]>,
      texts.length,
    );

    const elapsed = (performance.now() - t0).toFixed(0);
    debugLog(
      `[sentiment.worker] classified ${texts.length} sentences on ${activeDevice} in ${elapsed} ms`,
    );

    // Normalise labels to lowercase; clamp scores to [0, 1].
    const labels = items.map((r) => (r.label ?? 'neutral').toLowerCase());
    const scores = items.map((r) => Math.max(0, Math.min(1, r.score ?? 0)));

    const msg: SentimentWorkerClassifyResultMsg = { type: 'CLASSIFY_RESULT', id, labels, scores };
    post(msg);
  } catch (err) {
    // WebGPU can die mid-pass; transparently fall back to WASM and retry once.
    if (isWebGpuFatalError(err)) {
      debugLog('[sentiment.worker] WebGPU fatal during classify:', err);
    }
    if (await tryWasmFallback()) {
      await classify(id, texts);
      return;
    }
    post({ type: 'ERROR', id, message: String(err) });
  }
}

// ── message handler ───────────────────────────────────────────────────────────

self.onmessage = (e: MessageEvent) => {
  const msg = e.data as { type: string; [k: string]: unknown };

  if (msg.type === 'INIT') {
    void init(
      msg.wasmPaths as string,
      msg.modelBasePath as string,
      msg.modelId as string,
      (msg.numThreads as number | undefined) ?? 1,
      (msg.forceWasm as boolean | undefined) ?? false,
      msg.preferredDevice as InferenceDevice | undefined,
    );
  } else if (msg.type === 'CLASSIFY') {
    void classify(msg.id as string, msg.texts as string[]);
  }
};
