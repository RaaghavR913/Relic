// ============================================================
// Relic — WebGPU device-lost / fatal-error helpers for workers
// ------------------------------------------------------------
// Layered on top of try/catch + offscreen deadlines. Best-effort
// attachment to ORT's WebGPU device when exposed; never throws.
// ============================================================

import { env } from '@huggingface/transformers';
import { debugLog } from '@/lib/debug';

const FATAL_RE = /device lost|GPUDevice|WebGPU|Failed to execute.*GPU/i;

/** True when an inference/init error looks like a WebGPU device death. */
export function isWebGpuFatalError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return FATAL_RE.test(msg);
}

type LostableDevice = {
  lost?: Promise<{ reason?: string; message?: string }>;
  addEventListener?(type: 'uncapturederror', listener: (ev: Event) => void): void;
};

/**
 * Best-effort: if onnxruntime / transformers exposes the active WebGPU
 * device, watch `lost` (and uncapturederror) and invoke `onLost` once.
 * Returns an unsubscribe no-op when nothing is attachable.
 */
export function watchWebGpuDeviceLost(onLost: (reason: string) => void): () => void {
  let fired = false;
  const fire = (reason: string) => {
    if (fired) return;
    fired = true;
    debugLog('[webgpuLost]', reason);
    onLost(reason);
  };

  try {
    const backends = env.backends?.onnx as Record<string, unknown> | undefined;
    const webgpu = backends?.webgpu as Record<string, unknown> | undefined;
    const device = (webgpu?.device ?? webgpu?.gpuDevice) as LostableDevice | undefined;
    if (!device) return () => {};

    if (device.lost && typeof device.lost.then === 'function') {
      void device.lost.then((info) => {
        fire(`device.lost: ${info?.message ?? info?.reason ?? 'unknown'}`);
      });
    }
    if (typeof device.addEventListener === 'function') {
      const handler = (ev: Event) => {
        fire(`uncapturederror: ${String((ev as { error?: unknown }).error ?? ev)}`);
      };
      device.addEventListener('uncapturederror', handler);
    }
  } catch (err) {
    debugLog('[webgpuLost] attach failed:', err);
  }

  return () => {
    fired = true; // suppress late callbacks after teardown
  };
}
