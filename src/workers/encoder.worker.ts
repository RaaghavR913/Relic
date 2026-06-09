// ============================================================
// FilingLens — encoder Web Worker (Session 2)
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

import { pipeline, env } from '@huggingface/transformers';
import type { WorkerOutbound, WorkerProgressMsg } from '@/messages/types';

// The feature-extraction pipeline is callable: (texts, opts) => Tensor. The broad union
// type returned by pipeline() is not directly callable, so we model the call signature.
type FeatureExtractor = (
  texts: string | string[],
  opts?: { pooling?: 'mean' | 'cls' | 'none'; normalize?: boolean },
) => Promise<{ data: Float32Array }>;

// State -----------------------------------------------------------------------
let extractor: FeatureExtractor | null = null;
let activeDevice: 'webgpu' | 'wasm' = 'wasm';

function post(msg: WorkerOutbound, transfer?: Transferable[]): void {
  if (transfer && transfer.length > 0) {
    self.postMessage(msg, { transfer });
  } else {
    self.postMessage(msg);
  }
}

// Init ------------------------------------------------------------------------

async function init(
  wasmPaths: string,
  modelBasePath: string,
  modelId: string,
  numThreads: number,
): Promise<void> {
  // Configure ONNX Runtime WASM paths — must be set before any pipeline is created.
  // wasmPaths comes from the offscreen main thread (computed via chrome.runtime.getURL).
  (env.backends.onnx.wasm as Record<string, unknown>).wasmPaths = wasmPaths;
  (env.backends.onnx.wasm as Record<string, unknown>).numThreads = numThreads;

  // Zero-egress: load weights ONLY from the bundled extension files. Never reach
  // out to the Hugging Face Hub at runtime. `modelBasePath` is the extension URL
  // chrome.runtime.getURL('models/'); weights live at `${modelBasePath}${modelId}/`.
  env.allowRemoteModels = false;
  env.allowLocalModels = true;
  env.localModelPath = modelBasePath;

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
      extractor = (await pipeline('feature-extraction', modelId, {
        device,
        // Quantized int8 weights are what ship bundled (see scripts/fetch-models.mjs).
        dtype: 'q8',
        progress_callback: progressCallback,
      })) as unknown as FeatureExtractor;
      activeDevice = device;
      break;
    } catch (err) {
      if (device === 'webgpu') {
        // Expected on devices without GPU adapter; continue to WASM.
        console.debug('[encoder.worker] WebGPU unavailable, falling back to WASM:', err);
      } else {
        post({ type: 'ERROR', message: `Failed to load pipeline: ${String(err)}` });
        return;
      }
    }
  }

  post({ type: 'READY', device: activeDevice });
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
    );
  } else if (msg.type === 'EMBED') {
    void embed(msg.id as string, msg.texts as string[]);
  }
};
