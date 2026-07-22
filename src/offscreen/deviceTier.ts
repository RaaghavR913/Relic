// ============================================================
// Relic — device-tier inference preference (high-end vs low-end)
// ------------------------------------------------------------
// Product rule:
//   • Low-end  → WASM only (skip WebGPU even if an adapter exists)
//   • High-end → try WebGPU first; WASM only if GPU is unavailable
//                or INIT fails
//
// "Low-end" uses navigator.deviceMemory (Chrome caps at 8; absent ⇒
// treat as non-low so we don't degrade falsely). Same ≤4 GB cutover
// as the existing LOW_MEMORY batch/thread profile.
//
// INIT budgets are tiered: high-end gets a longer WebGPU pipeline
// create window; low-end stays on a short WASM-only budget so weak
// machines never sit on a doomed GPU path.
// ============================================================

import type { InferenceDevice } from '@/workers/backendOrder';

/** Chrome reports deviceMemory in GB; ≤ this is the low-end tier. */
export const LOW_END_DEVICE_MEMORY_GB = 4;

/** Absent deviceMemory → assume enough RAM (do not force low-end). */
export const DEFAULT_DEVICE_MEMORY_GB = 8;

/** High-end WebGPU (or fallback WASM) pipeline create budget. */
export const HIGH_END_INIT_TIMEOUT_MS = 60_000;

/** Low-end WASM-only INIT budget — no WebGPU wait. */
export const LOW_END_INIT_TIMEOUT_MS = 20_000;

export function readDeviceMemoryGb(
  nav: { deviceMemory?: number } = (
    globalThis as { navigator?: { deviceMemory?: number } }
  ).navigator ?? {},
): number {
  return nav.deviceMemory ?? DEFAULT_DEVICE_MEMORY_GB;
}

export function isLowEndDevice(deviceMemoryGb: number): boolean {
  return deviceMemoryGb <= LOW_END_DEVICE_MEMORY_GB;
}

export function initTimeoutForTier(lowEnd: boolean): number {
  return lowEnd ? LOW_END_INIT_TIMEOUT_MS : HIGH_END_INIT_TIMEOUT_MS;
}

/**
 * Preferred ONNX backend before worker INIT.
 *
 * Order of precedence:
 *   1. Session prefer-WASM (prior GPU failure / recycled offscreen URL)
 *   2. Low-end tier → WASM (skip WebGPU entirely)
 *   3. High-end + usable GPU device → WebGPU
 *   4. Otherwise → WASM
 */
export function preferredDeviceForTier(opts: {
  lowEnd: boolean;
  preferWasmSession: boolean;
  /** True when preflight got a working requestDevice(); ignored on low-end. */
  webgpuDeviceAvailable: boolean;
}): InferenceDevice {
  if (opts.preferWasmSession) return 'wasm';
  if (opts.lowEnd) return 'wasm';
  return opts.webgpuDeviceAvailable ? 'webgpu' : 'wasm';
}
