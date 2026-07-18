// ============================================================
// Relic — embed / classify batch tuning by device + memory
// ------------------------------------------------------------
// WASM profiles preserve the pre-hardening defaults exactly so
// no-WebGPU machines do not regress. WebGPU profiles use larger
// batches (and dual classify lanes on normal memory) after READY.
// ============================================================

import type { InferenceDevice } from '@/workers/backendOrder';

export interface BackendTuning {
  embedBatch: number;
  embedConcurrency: number;
  classifyBatch: number;
  classifyConcurrency: number;
}

/**
 * Batch / concurrency table keyed by (lowMemory, device).
 * WASM rows MUST stay at historical defaults (16×1/32×2 embed, 4|8×1 classify).
 */
export function getBackendTuning(lowMemory: boolean, device: InferenceDevice): BackendTuning {
  if (device === 'wasm') {
    return lowMemory
      ? { embedBatch: 16, embedConcurrency: 1, classifyBatch: 4, classifyConcurrency: 1 }
      : { embedBatch: 32, embedConcurrency: 2, classifyBatch: 8, classifyConcurrency: 1 };
  }
  // webgpu
  return lowMemory
    ? { embedBatch: 32, embedConcurrency: 1, classifyBatch: 8, classifyConcurrency: 1 }
    : { embedBatch: 48, embedConcurrency: 2, classifyBatch: 16, classifyConcurrency: 2 };
}
