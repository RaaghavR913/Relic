// ============================================================
// Relic — encoder Web Worker (Session 2)
// ------------------------------------------------------------
// RULES:
//   - MUST NEVER reference chrome.* (this is a plain Web Worker).
//   - All URLs / paths arrive via the INIT message from the offscreen main thread.
//   - Selects device:'webgpu' with try/catch fallback to device:'wasm'.
//   - Vectors are returned as transferable ArrayBuffers (zero-copy).
//
// Pipeline: mixedbread-ai/mxbai-embed-xsmall-v1
//   pooling:'mean', normalize:true → unit-length 384-dim Float32Arrays
//   → stored dot-product is equivalent to cosine similarity.
// ============================================================

import { pipeline } from '@huggingface/transformers';
import type { WorkerOutbound, WorkerProgressMsg } from '@/messages/types';
import { configureBundledModelEnv } from '@/workers/transformersEnv';
import { createLoadProgressTracker } from '@/workers/modelSizes';
import { resolveBackendOrder, type InferenceDevice } from '@/workers/backendOrder';
import { isWebGpuFatalError, watchWebGpuDeviceLost } from '@/workers/webgpuLost';
import { debugLog } from '@/lib/debug';

// The feature-extraction pipeline is callable: (texts, opts) => Tensor. The broad union
// type returned by pipeline() is not directly callable, so we model the call signature.
type FeatureExtractor = (
  texts: string | string[],
  opts?: { pooling?: 'mean' | 'cls' | 'none'; normalize?: boolean },
) => Promise<{ data: Float32Array }>;

// State -----------------------------------------------------------------------
let extractor: FeatureExtractor | null = null;
let activeDevice: InferenceDevice = 'wasm';
// Remembered INIT params + a one-shot shared guard so a mid-inference WebGPU
// failure (driver crash / OOM after a clean init) re-initializes once on WASM and
// retries, instead of failing the whole embedding pass.
let initParams: {
  wasmPaths: string;
  modelBasePath: string;
  modelId: string;
  numThreads: number;
} | null = null;
let wasmFallback: Promise<boolean> | null = null;
let unwatchDeviceLost: (() => void) | null = null;

function post(msg: WorkerOutbound, transfer?: Transferable[]): void {
  if (transfer && transfer.length > 0) {
    self.postMessage(msg, { transfer });
  } else {
    self.postMessage(msg);
  }
}

function clearDeviceLostWatch(): void {
  unwatchDeviceLost?.();
  unwatchDeviceLost = null;
}

// Init ------------------------------------------------------------------------

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

  // Bundled chrome-extension:// responses carry no Content-Length, so the raw
  // event's `progress` field pegs to ~100% immediately. Derive a REAL fraction
  // from `loaded` bytes against the build-time size manifest instead.
  const progressCallback = createLoadProgressTracker(modelId, (e) => {
    const msg: WorkerProgressMsg = { type: 'PROGRESS', progress: e.progress };
    if (e.file !== undefined) msg.file = e.file;
    if (e.indeterminate) msg.indeterminate = true;
    post(msg);
  });

  // Deterministic backend order with per-attempt diagnostics (mirrors sentiment.worker).
  const order = resolveBackendOrder(forceWasm, preferredDevice);
  const attempts: string[] = [];

  for (const device of order) {
    try {
      extractor = (await pipeline('feature-extraction', modelId, {
        device,
        // Quantized int8 weights are what ship bundled (see scripts/fetch-models.mjs).
        dtype: 'q8',
        progress_callback: progressCallback,
      })) as unknown as FeatureExtractor;
      activeDevice = device;
      attempts.push(`${device}: ok`);
      break;
    } catch (err) {
      attempts.push(`${device}: ${String(err)}`);
      debugLog(`[encoder.worker] ${device} backend failed:`, err);
      if (isWebGpuFatalError(err)) {
        debugLog('[encoder.worker] WebGPU fatal during init — continuing to next backend');
      }
    }
  }

  if (!extractor) {
    post({ type: 'ERROR', message: `Failed to load pipeline: ${attempts.join(' | ')}` });
    return;
  }

  if (activeDevice === 'webgpu') {
    unwatchDeviceLost = watchWebGpuDeviceLost(() => {
      void tryWasmFallback();
    });
  }

  post({ type: 'READY', device: activeDevice, diag: { wasmPaths, attempts } });
}

/**
 * Recover from a mid-inference WebGPU failure by re-initializing once on WASM.
 * Shared promise so concurrent failing requests trigger a single re-init, then
 * each retries. Resolves false once already on WASM (or with no INIT params).
 */
function tryWasmFallback(): Promise<boolean> {
  if (activeDevice !== 'webgpu' || !initParams) return Promise.resolve(false);
  if (!wasmFallback) {
    const p = initParams;
    const prev = extractor;
    extractor = null;
    clearDeviceLostWatch();
    debugLog('[encoder.worker] inference failed on WebGPU — re-initializing on WASM');
    wasmFallback = (async () => {
      try {
        const disposable = prev as unknown as { dispose?: () => Promise<void> | void };
        if (typeof disposable?.dispose === 'function') await disposable.dispose();
      } catch (err) {
        debugLog('[encoder.worker] dispose before WASM fallback failed:', err);
      }
      await init(p.wasmPaths, p.modelBasePath, p.modelId, p.numThreads, true, 'wasm');
      return extractor !== null;
    })();
  }
  return wasmFallback;
}

// Embed -----------------------------------------------------------------------

async function embed(id: string, texts: string[]): Promise<void> {
  if (!extractor) {
    post({ type: 'ERROR', id, message: 'Pipeline not initialised — send INIT first.' });
    return;
  }

  try {
    // Transformers.js v4: calling the pipeline with an array returns a Tensor of shape
    // [n, hidden_dim]. With pooling:'mean' and normalize:true the vectors are unit-length.
    const output = await extractor(texts, { pooling: 'mean', normalize: true });

    const flat = output.data as Float32Array;
    const n = texts.length;
    const dim = flat.length / n;

    // Split the flat buffer into per-text Float32Arrays and transfer their buffers.
    const buffers: ArrayBuffer[] = [];
    for (let i = 0; i < n; i++) {
      // .slice() returns a new Float32Array (new underlying buffer — safe to transfer).
      const vec = flat.slice(i * dim, (i + 1) * dim);
      buffers.push(vec.buffer);
    }

    post({ type: 'EMBED_RESULT', id, buffers, dim }, buffers);
  } catch (err) {
    // WebGPU can die mid-pass; transparently fall back to WASM and retry once.
    if (isWebGpuFatalError(err)) {
      debugLog('[encoder.worker] WebGPU fatal during embed:', err);
    }
    if (await tryWasmFallback()) {
      await embed(id, texts);
      return;
    }
    post({ type: 'ERROR', id, message: String(err) });
  }
}

// Message handler -------------------------------------------------------------

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
  } else if (msg.type === 'EMBED') {
    void embed(msg.id as string, msg.texts as string[]);
  }
};
