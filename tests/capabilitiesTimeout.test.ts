import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  getCapabilities,
  clearCapabilitiesCache,
  BUILTIN_PROBE_TIMEOUT_MS,
} from '../src/runtime/capabilities';

// Regression guard for a hang observed in a real browser (Chrome for Testing 151):
// Summarizer/LanguageModel exist, but availability() never settles. The side panel
// renders nothing until getCapabilities() resolves, so an unbounded await there
// froze the entire UI on "Detecting on-device capabilities…" — no error, no recovery.
// getCapabilities() must always settle and fall back to the extractive tier.

describe('getCapabilities — never hangs on a stalled availability()', () => {
  beforeEach(() => {
    clearCapabilitiesCache();
    vi.useFakeTimers();
    // No navigator.gpu → the WebGPU probe resolves immediately.
    vi.stubGlobal('navigator', {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    clearCapabilitiesCache();
  });

  it('falls back to extractive when availability() never settles', async () => {
    const neverSettles = () => new Promise<string>(() => {});
    vi.stubGlobal('Summarizer', { availability: vi.fn(neverSettles) });
    vi.stubGlobal('LanguageModel', { availability: vi.fn(neverSettles) });

    const promise = getCapabilities(true);
    await vi.advanceTimersByTimeAsync(BUILTIN_PROBE_TIMEOUT_MS + 100);
    const caps = await promise;

    expect(caps.summarizer).toBe('unavailable');
    expect(caps.promptApi).toBe('unavailable');
    expect(caps.generationTier).toBe('extractive');
    expect(caps.needsModelDownload).toBe(false);
  });

  it('still reports a fast, genuine availability answer', async () => {
    vi.stubGlobal('Summarizer', { availability: vi.fn(async () => 'downloadable') });
    vi.stubGlobal('LanguageModel', { availability: vi.fn(async () => 'available') });

    const promise = getCapabilities(true);
    await vi.advanceTimersByTimeAsync(10);
    const caps = await promise;

    expect(caps.summarizer).toBe('downloadable');
    expect(caps.promptApi).toBe('available');
    expect(caps.generationTier).toBe('builtin');
    expect(caps.needsModelDownload).toBe(true);
  });

  it('one stalled API does not mask the other that answers', async () => {
    vi.stubGlobal('Summarizer', { availability: vi.fn(() => new Promise<string>(() => {})) });
    vi.stubGlobal('LanguageModel', { availability: vi.fn(async () => 'available') });

    const promise = getCapabilities(true);
    await vi.advanceTimersByTimeAsync(BUILTIN_PROBE_TIMEOUT_MS + 100);
    const caps = await promise;

    expect(caps.summarizer).toBe('unavailable');
    expect(caps.promptApi).toBe('available');
    // A single working generative API is still enough for the builtin tier.
    expect(caps.generationTier).toBe('builtin');
  });

  it('treats a rejecting availability() as unavailable', async () => {
    vi.stubGlobal('Summarizer', {
      availability: vi.fn(async () => {
        throw new Error('boom');
      }),
    });
    vi.stubGlobal('LanguageModel', { availability: vi.fn(async () => 'unavailable') });

    const promise = getCapabilities(true);
    await vi.advanceTimersByTimeAsync(10);
    const caps = await promise;

    expect(caps.summarizer).toBe('unavailable');
    expect(caps.generationTier).toBe('extractive');
  });
});
