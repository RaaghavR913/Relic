// ============================================================
// Disclora — shared Transformers.js env for extension Web Workers
// ------------------------------------------------------------
// Models and ORT WASM glue load from chrome.runtime.getURL(...) paths.
// Transformers.js defaults to env.useBrowserCache=true, which calls
// Cache.put() on those fetches — but the Cache API only supports
// http/https, so chrome-extension:// URLs throw and log warnings.
// We bundle weights in the extension, so browser caching is unnecessary.
// ============================================================

import { env } from '@huggingface/transformers';

export function configureBundledModelEnv(
  wasmPaths: string,
  modelBasePath: string,
  numThreads: number,
): void {
  (env.backends.onnx.wasm as Record<string, unknown>).wasmPaths = wasmPaths;
  (env.backends.onnx.wasm as Record<string, unknown>).numThreads = numThreads;

  env.allowRemoteModels = false;
  env.allowLocalModels = true;
  env.localModelPath = modelBasePath;

  // chrome-extension:// is not a supported Cache API scheme.
  env.useBrowserCache = false;
  // ORT WASM pre-load also routes through the same cache layer.
  env.useWasmCache = false;
}
