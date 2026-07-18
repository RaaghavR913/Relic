// ============================================================
// Relic — offscreen WebGPU adapter preflight
// ------------------------------------------------------------
// Runs in the offscreen document (has navigator.gpu) before INIT
// so workers can skip a doomed WebGPU pipeline create when no
// adapter exists. Prefers the discrete GPU on dual-GPU laptops.
// ============================================================

export type WebGpuProbe = { supported: boolean; adapter: boolean };

type GpuNavigator = {
  gpu?: {
    requestAdapter(opts?: { powerPreference?: 'high-performance' | 'low-power' }): Promise<unknown>;
  };
};

/**
 * Probe for a usable WebGPU adapter. Existence of navigator.gpu alone is
 * not enough — requestAdapter may return null.
 */
export async function probeWebGpuAdapter(): Promise<WebGpuProbe> {
  const gpu = (globalThis as { navigator?: GpuNavigator }).navigator?.gpu;
  if (!gpu) return { supported: false, adapter: false };
  try {
    const adapter = await gpu.requestAdapter({ powerPreference: 'high-performance' });
    return { supported: true, adapter: Boolean(adapter) };
  } catch {
    return { supported: true, adapter: false };
  }
}
