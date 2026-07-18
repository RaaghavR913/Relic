// ============================================================
// Relic — ONNX backend selection order (WebGPU → WASM)
// ------------------------------------------------------------
// Pure helper shared by encoder/sentiment workers and unit tests.
// forceWasm (dev/diagnostic) always wins; preferredDevice:'wasm'
// skips a doomed WebGPU attempt after offscreen preflight / prior
// session fallback. Otherwise try WebGPU first, then WASM.
// ============================================================

export type InferenceDevice = 'webgpu' | 'wasm';

/**
 * Resolve the ordered list of backends to attempt when loading a pipeline.
 * Never returns an empty list — WASM is always a candidate unless forceWasm
 * already selected it alone (still includes wasm).
 */
export function resolveBackendOrder(
  forceWasm: boolean | undefined,
  preferredDevice: InferenceDevice | undefined,
): ReadonlyArray<InferenceDevice> {
  if (forceWasm || preferredDevice === 'wasm') return ['wasm'];
  return ['webgpu', 'wasm'];
}
