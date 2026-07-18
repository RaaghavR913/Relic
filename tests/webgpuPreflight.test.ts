import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resolveBackendOrder } from '../src/workers/backendOrder';
import { probeWebGpuAdapter } from '../src/offscreen/webgpuPreflight';
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
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: originalNav,
    });
  });

  it('returns unsupported when navigator.gpu is missing', async () => {
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: {},
    });
    await expect(probeWebGpuAdapter()).resolves.toEqual({ supported: false, adapter: false });
  });

  it('requests high-performance adapter when gpu exists', async () => {
    const requestAdapter = vi.fn().mockResolvedValue({ name: 'fake' });
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: { gpu: { requestAdapter } },
    });
    await expect(probeWebGpuAdapter()).resolves.toEqual({ supported: true, adapter: true });
    expect(requestAdapter).toHaveBeenCalledWith({ powerPreference: 'high-performance' });
  });

  it('reports adapter false when requestAdapter returns null', async () => {
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: { gpu: { requestAdapter: vi.fn().mockResolvedValue(null) } },
    });
    await expect(probeWebGpuAdapter()).resolves.toEqual({ supported: true, adapter: false });
  });
});

describe('isWebGpuFatalError', () => {
  beforeEach(() => {});

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
