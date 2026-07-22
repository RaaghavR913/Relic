import { describe, it, expect } from 'vitest';
import {
  DEFAULT_DEVICE_MEMORY_GB,
  HIGH_END_INIT_TIMEOUT_MS,
  LOW_END_DEVICE_MEMORY_GB,
  LOW_END_INIT_TIMEOUT_MS,
  initTimeoutForTier,
  isLowEndDevice,
  preferredDeviceForTier,
  readDeviceMemoryGb,
} from '../src/offscreen/deviceTier';

describe('isLowEndDevice / readDeviceMemoryGb', () => {
  it(`treats ≤${LOW_END_DEVICE_MEMORY_GB} GB as low-end`, () => {
    expect(isLowEndDevice(2)).toBe(true);
    expect(isLowEndDevice(4)).toBe(true);
    expect(isLowEndDevice(4.0)).toBe(true);
  });

  it('treats >4 GB as high-end', () => {
    expect(isLowEndDevice(5)).toBe(false);
    expect(isLowEndDevice(8)).toBe(false);
  });

  it('defaults missing deviceMemory to non-low-end assumption', () => {
    expect(readDeviceMemoryGb({})).toBe(DEFAULT_DEVICE_MEMORY_GB);
    expect(isLowEndDevice(readDeviceMemoryGb({}))).toBe(false);
  });

  it('reads explicit deviceMemory', () => {
    expect(readDeviceMemoryGb({ deviceMemory: 4 })).toBe(4);
    expect(readDeviceMemoryGb({ deviceMemory: 8 })).toBe(8);
  });
});

describe('initTimeoutForTier', () => {
  it('gives high-end 60s for WebGPU pipeline create', () => {
    expect(initTimeoutForTier(false)).toBe(HIGH_END_INIT_TIMEOUT_MS);
    expect(HIGH_END_INIT_TIMEOUT_MS).toBe(60_000);
  });

  it('gives low-end 20s (WASM-only path)', () => {
    expect(initTimeoutForTier(true)).toBe(LOW_END_INIT_TIMEOUT_MS);
    expect(LOW_END_INIT_TIMEOUT_MS).toBe(20_000);
  });
});

describe('preferredDeviceForTier', () => {
  it('session prefer-WASM wins over high-end GPU', () => {
    expect(
      preferredDeviceForTier({
        lowEnd: false,
        preferWasmSession: true,
        webgpuDeviceAvailable: true,
      }),
    ).toBe('wasm');
  });

  it('low-end always prefers WASM even when GPU device exists', () => {
    expect(
      preferredDeviceForTier({
        lowEnd: true,
        preferWasmSession: false,
        webgpuDeviceAvailable: true,
      }),
    ).toBe('wasm');
    expect(
      preferredDeviceForTier({
        lowEnd: true,
        preferWasmSession: false,
        webgpuDeviceAvailable: false,
      }),
    ).toBe('wasm');
  });

  it('high-end prefers WebGPU when preflight got a device', () => {
    expect(
      preferredDeviceForTier({
        lowEnd: false,
        preferWasmSession: false,
        webgpuDeviceAvailable: true,
      }),
    ).toBe('webgpu');
  });

  it('high-end falls to WASM when no usable GPU device', () => {
    expect(
      preferredDeviceForTier({
        lowEnd: false,
        preferWasmSession: false,
        webgpuDeviceAvailable: false,
      }),
    ).toBe('wasm');
  });

  it('session prefer-WASM also wins on low-end', () => {
    expect(
      preferredDeviceForTier({
        lowEnd: true,
        preferWasmSession: true,
        webgpuDeviceAvailable: false,
      }),
    ).toBe('wasm');
  });
});
