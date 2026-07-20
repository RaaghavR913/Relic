// ============================================================
// Relic — offscreen WebGPU adapter + device preflight
// ------------------------------------------------------------
// Runs in the offscreen document (has navigator.gpu) before INIT
// so workers can skip a doomed WebGPU pipeline create when no
// adapter/device exists. Prefers the discrete GPU on dual-GPU
// laptops. Fail-soft: timeouts and errors never reject — callers
// treat a non-usable probe as "prefer WASM".
// ============================================================

export type WebGpuProbeReason =
  | 'no_gpu'
  | 'no_adapter'
  | 'no_device'
  | 'timeout'
  | 'error';

export type WebGpuProbe = {
  supported: boolean;
  adapter: boolean;
  /** True when adapter.requestDevice() succeeded (device is destroyed immediately). */
  device: boolean;
  reason?: WebGpuProbeReason;
};

/** Per-step budget for requestAdapter / requestDevice. */
export const WEBGPU_PROBE_TIMEOUT_MS = 800;

type GpuDevice = {
  destroy?: () => void;
};

type GpuAdapter = {
  requestDevice(opts?: unknown): Promise<GpuDevice | null>;
};

type GpuNavigator = {
  gpu?: {
    requestAdapter(opts?: {
      powerPreference?: 'high-performance' | 'low-power';
    }): Promise<GpuAdapter | null>;
  };
};

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('webgpu-probe-timeout')), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

function destroyDevice(device: GpuDevice | null | undefined): void {
  try {
    device?.destroy?.();
  } catch {
    // best-effort cleanup before ORT creates its own device
  }
}

/**
 * Probe for a usable WebGPU adapter + device. Existence of navigator.gpu alone
 * is not enough — requestAdapter may return null, and requestDevice may fail.
 * Never throws; timeouts/errors become an unusable probe with a reason.
 */
export async function probeWebGpuAdapter(): Promise<WebGpuProbe> {
  const gpu = (globalThis as { navigator?: GpuNavigator }).navigator?.gpu;
  if (!gpu) {
    return { supported: false, adapter: false, device: false, reason: 'no_gpu' };
  }

  try {
    let adapter: GpuAdapter | null;
    try {
      adapter = await withTimeout(
        gpu.requestAdapter({ powerPreference: 'high-performance' }),
        WEBGPU_PROBE_TIMEOUT_MS,
      );
    } catch (err) {
      const timedOut =
        err instanceof Error && err.message === 'webgpu-probe-timeout';
      return {
        supported: true,
        adapter: false,
        device: false,
        reason: timedOut ? 'timeout' : 'error',
      };
    }

    if (!adapter) {
      return { supported: true, adapter: false, device: false, reason: 'no_adapter' };
    }

    let device: GpuDevice | null;
    try {
      device = await withTimeout(adapter.requestDevice(), WEBGPU_PROBE_TIMEOUT_MS);
    } catch (err) {
      const timedOut =
        err instanceof Error && err.message === 'webgpu-probe-timeout';
      return {
        supported: true,
        adapter: true,
        device: false,
        reason: timedOut ? 'timeout' : 'error',
      };
    }

    if (!device) {
      return { supported: true, adapter: true, device: false, reason: 'no_device' };
    }

    destroyDevice(device);
    return { supported: true, adapter: true, device: true };
  } catch {
    return { supported: true, adapter: false, device: false, reason: 'error' };
  }
}
