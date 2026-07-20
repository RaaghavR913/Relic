import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  getPreferWasm,
  setPreferWasm,
  offscreenUrlWithPref,
  preferWasmFromLocation,
  PREFER_WASM_PARAM,
  INFERENCE_PREF_KEY,
} from '../src/offscreen/inferencePref';

// NOTE: getPreferWasm/setPreferWasm are SERVICE-WORKER-side only. The offscreen
// document has no chrome.storage at all (its API surface is essentially
// chrome.runtime), which is why the preference travels to it through the
// creation URL instead. An earlier version of this file stubbed chrome.storage
// and "passed" while the production path was dead — the URL seam below is the
// part that actually runs in the offscreen document, so it is tested directly.

describe('inferencePref — URL seam (offscreen side, no chrome.* needed)', () => {
  it('omits the param when no preference is set', () => {
    expect(offscreenUrlWithPref('chrome-extension://abc/off.html', false)).toBe(
      'chrome-extension://abc/off.html',
    );
  });

  it('round-trips a prefer-WASM preference through the URL', () => {
    const url = offscreenUrlWithPref('chrome-extension://abc/off.html', true);
    expect(url).toContain(`${PREFER_WASM_PARAM}=1`);
    expect(preferWasmFromLocation(url)).toBe(true);
  });

  it('appends with & when the base URL already has a query', () => {
    const url = offscreenUrlWithPref('chrome-extension://abc/off.html?x=1', true);
    expect(url).toBe(`chrome-extension://abc/off.html?x=1&${PREFER_WASM_PARAM}=1`);
    expect(preferWasmFromLocation(url)).toBe(true);
  });

  it('reads a bare location.search string', () => {
    expect(preferWasmFromLocation(`?${PREFER_WASM_PARAM}=1`)).toBe(true);
    expect(preferWasmFromLocation(`${PREFER_WASM_PARAM}=1`)).toBe(true);
  });

  it('treats absent, empty, or non-1 values as no preference', () => {
    expect(preferWasmFromLocation('')).toBe(false);
    expect(preferWasmFromLocation('?other=1')).toBe(false);
    expect(preferWasmFromLocation(`?${PREFER_WASM_PARAM}=0`)).toBe(false);
    expect(preferWasmFromLocation(`?${PREFER_WASM_PARAM}=true`)).toBe(false);
    expect(preferWasmFromLocation('chrome-extension://abc/off.html')).toBe(false);
  });
});

describe('inferencePref — storage seam (service-worker side)', () => {
  const store = new Map<string, unknown>();

  beforeEach(() => {
    store.clear();
    vi.stubGlobal('chrome', {
      storage: {
        session: {
          get: vi.fn(async (key: string) =>
            store.has(key) ? { [key]: store.get(key) } : {},
          ),
          set: vi.fn(async (obj: Record<string, unknown>) => {
            for (const [k, v] of Object.entries(obj)) store.set(k, v);
          }),
          remove: vi.fn(async (key: string) => {
            store.delete(key);
          }),
        },
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('defaults to false when unset', async () => {
    await expect(getPreferWasm()).resolves.toBe(false);
  });

  it('persists preferWasm true under the session key', async () => {
    await setPreferWasm(true);
    expect(store.get(INFERENCE_PREF_KEY)).toBe(true);
    await expect(getPreferWasm()).resolves.toBe(true);
  });

  it('clears the key when setPreferWasm(false)', async () => {
    await setPreferWasm(true);
    await setPreferWasm(false);
    expect(store.has(INFERENCE_PREF_KEY)).toBe(false);
    await expect(getPreferWasm()).resolves.toBe(false);
  });

  it('fail-softs to false when storage throws', async () => {
    vi.stubGlobal('chrome', {
      storage: {
        session: {
          get: vi.fn(async () => {
            throw new Error('no storage');
          }),
          set: vi.fn(async () => {
            throw new Error('no storage');
          }),
          remove: vi.fn(async () => {
            throw new Error('no storage');
          }),
        },
      },
    });
    await expect(getPreferWasm()).resolves.toBe(false);
    await expect(setPreferWasm(true)).resolves.toBeUndefined();
  });

  it('fail-softs when chrome.storage is entirely absent (the offscreen case)', async () => {
    vi.stubGlobal('chrome', {});
    await expect(getPreferWasm()).resolves.toBe(false);
    await expect(setPreferWasm(true)).resolves.toBeUndefined();
  });
});
