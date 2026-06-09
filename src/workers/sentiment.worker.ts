// ============================================================
// FilingLens — FinBERT sentiment Web Worker (Session 4)
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

import { pipeline, env } from '@huggingface/transformers';
import type {
  SentimentWorkerOutbound,
  WorkerProgressMsg,
  SentimentWorkerClassifyResultMsg,
} from '@/messages/types';

// The text-classification pipeline is callable: (texts, opts) => Promise<result>.
// Transformers.js v4: array input with topk=1 returns Array<{label, score}>.
type SentimentItem = { label: string; score: number };
type ClassificationPipeline = (
  texts: string | string[],
  opts?: { topk?: number },
) => Promise<SentimentItem | SentimentItem[] | Array<SentimentItem[]>>;

// ── state ─────────────────────────────────────────────────────────────────────

let classifier: ClassificationPipeline | null = null;
let activeDevice: 'webgpu' | 'wasm' = 'wasm';

function post(msg: SentimentWorkerOutbound): void {
  self.postMessage(msg);
}

// ── init ──────────────────────────────────────────────────────────────────────

async function init(
  wasmPaths: string,
  modelBasePath: string,
  modelId: string,
  numThreads: number,
): Promise<void> {
  // Configure ONNX Runtime WASM paths — must be set before any pipeline is created.
  (env.backends.onnx.wasm as Record<string, unknown>).wasmPaths = wasmPaths;
  (env.backends.onnx.wasm as Record<string, unknown>).numThreads = numThreads;

  // Zero-egress: load weights ONLY from the bundled extension files — never the
  // Hugging Face Hub. `modelBasePath` = chrome.runtime.getURL('models/'); the
  // FinBERT weights live at `${modelBasePath}${modelId}/`.
  env.allowRemoteModels = false;
  env.allowLocalModels = true;
  env.localModelPath = modelBasePath;

  const t0 = performance.now();

  const progressCallback = (progress: unknown) => {
    const p = progress as { status?: string; progress?: number; file?: string };
    if (p.status === 'progress' && typeof p.progress === 'number') {
      const msg: WorkerProgressMsg = { type: 'PROGRESS', progress: p.progress / 100 };
      if (typeof p.file === 'string') msg.file = p.file;
      post(msg);
    }
  };

  // Try WebGPU first; fall back to WASM.
  for (const device of ['webgpu', 'wasm'] as const) {
    try {
      classifier = (await pipeline('text-classification', modelId, {
        device,
        // Quantized int8 weights are what ship bundled (see scripts/fetch-models.mjs).
        dtype: 'q8',
        progress_callback: progressCallback,
      })) as unknown as ClassificationPipeline;
      activeDevice = device;
      const elapsed = (performance.now() - t0).toFixed(0);
      console.debug(`[sentiment.worker] FinBERT loaded on ${device} in ${elapsed} ms`);
      break;
    } catch (err) {
      if (device === 'webgpu') {
        console.debug('[sentiment.worker] WebGPU unavailable, falling back to WASM:', err);
      } else {
        post({ type: 'ERROR', message: `Failed to load FinBERT: ${String(err)}` });
        return;
      }
    }
  }

  post({ type: 'READY', device: activeDevice });
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
    console.debug(
      `[sentiment.worker] classified ${texts.length} sentences on ${activeDevice} in ${elapsed} ms`,
    );

    // Normalise labels to lowercase; clamp scores to [0, 1].
    const labels = items.map((r) => (r.label ?? 'neutral').toLowerCase());
    const scores = items.map((r) => Math.max(0, Math.min(1, r.score ?? 0)));

    const msg: SentimentWorkerClassifyResultMsg = { type: 'CLASSIFY_RESULT', id, labels, scores };
    post(msg);
  } catch (err) {
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
    );
  } else if (msg.type === 'CLASSIFY') {
    void classify(msg.id as string, msg.texts as string[]);
  }
};
