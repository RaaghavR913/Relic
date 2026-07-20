import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  probeWebGpuAdapter,
  WEBGPU_PROBE_TIMEOUT_MS,
} from '../src/offscreen/webgpuPreflight';
import { resolveBackendOrder } from '../src/workers/backendOrder';
import { isWebGpuFatalError } from '../src/workers/webgpuLost';

describe('resolveBackendOrder', () => {
  it('forceWasm alone selects wasm', () => {
    expect(resolveBackendOrder(true, undefined)).toEqual(['wasm']);
    expect(resolveBackendOrder(true, 'webgpu')).toEqual(['wasm']);
  });

  it('preferredDevice wasm skips webgpu', () => {
    expect(resolveBackendOrder(false, 'wasm')).toEqual(['wasm']);
    expect(resolveBackendOrder(undefined, 'wasm')).toEqual(['wasm']);
  });

  it('default and preferred webgpu try webgpu then wasm', () => {
    expect(resolveBackendOrder(false, 'webgpu')).toEqual(['webgpu', 'wasm']);
    expect(resolveBackendOrder(false, undefined)).toEqual(['webgpu', 'wasm']);
    expect(resolveBackendOrder(undefined, undefined)).toEqual(['webgpu', 'wasm']);
  });
});

describe('probeWebGpuAdapter', () => {
  const originalNav = globalThis.navigator;

  afterEach(() => {
    vi.useRealTimers();
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: originalNav,
    });
  });

  it('returns no_gpu when navigator.gpu is missing', async () => {
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: {},
    });
    await expect(probeWebGpuAdapter()).resolves.toEqual({
      supported: false,
      adapter: false,
      device: false,
      reason: 'no_gpu',
    });
  });

  it('requests high-performance adapter and device when gpu exists', async () => {
    const destroy = vi.fn();
    const requestDevice = vi.fn().mockResolvedValue({ destroy });
    const requestAdapter = vi.fn().mockResolvedValue({ requestDevice });
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: { gpu: { requestAdapter } },
    });
    await expect(probeWebGpuAdapter()).resolves.toEqual({
      supported: true,
      adapter: true,
      device: true,
    });
    expect(requestAdapter).toHaveBeenCalledWith({ powerPreference: 'high-performance' });
    expect(requestDevice).toHaveBeenCalled();
    expect(destroy).toHaveBeenCalled();
  });

  it('reports no_adapter when requestAdapter returns null', async () => {
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: { gpu: { requestAdapter: vi.fn().mockResolvedValue(null) } },
    });
    await expect(probeWebGpuAdapter()).resolves.toEqual({
      supported: true,
      adapter: false,
      device: false,
      reason: 'no_adapter',
    });
  });

  it('reports no_device when requestDevice returns null', async () => {
    const requestDevice = vi.fn().mockResolvedValue(null);
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: {
        gpu: { requestAdapter: vi.fn().mockResolvedValue({ requestDevice }) },
      },
    });
    await expect(probeWebGpuAdapter()).resolves.toEqual({
      supported: true,
      adapter: true,
      device: false,
      reason: 'no_device',
    });
  });

  it('reports error when requestDevice throws', async () => {
    const requestDevice = vi.fn().mockRejectedValue(new Error('device create failed'));
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: {
        gpu: { requestAdapter: vi.fn().mockResolvedValue({ requestDevice }) },
      },
    });
    await expect(probeWebGpuAdapter()).resolves.toEqual({
      supported: true,
      adapter: true,
      device: false,
      reason: 'error',
    });
  });

  it('reports timeout when requestAdapter hangs', async () => {
    vi.useFakeTimers();
    const requestAdapter = vi.fn().mockReturnValue(new Promise(() => {}));
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: { gpu: { requestAdapter } },
    });
    const pending = probeWebGpuAdapter();
    await vi.advanceTimersByTimeAsync(WEBGPU_PROBE_TIMEOUT_MS);
    await expect(pending).resolves.toEqual({
      supported: true,
      adapter: false,
      device: false,
      reason: 'timeout',
    });
  });
});

describe('isWebGpuFatalError', () => {
  it('matches device-lost style messages', () => {
    expect(isWebGpuFatalError(new Error('GPUDevice lost'))).toBe(true);
    expect(isWebGpuFatalError('device lost')).toBe(true);
    expect(isWebGpuFatalError('WebGPU validation error')).toBe(true);
  });

  it('ignores unrelated errors', () => {
    expect(isWebGpuFatalError(new Error('network timeout'))).toBe(false);
    expect(isWebGpuFatalError('Failed to load pipeline')).toBe(false);
  });
});
