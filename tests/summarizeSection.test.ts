// ============================================================
// Relic — summarizeSection stall/fallback tests (the 69% bug)
// ------------------------------------------------------------
// The builtin (Gemini Nano) path must degrade to the WASM extractive path when
// the one-time model download stalls, must never poison the builtin cache slot
// with a degraded result, and must respect user aborts.
// ============================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Section, DocumentModel } from '../src/types';

vi.mock('../src/summarizer/summaryStore', () => ({
  getCachedSummary: vi.fn(async () => null),
  putSummary: vi.fn(async () => {}),
}));

import { getCachedSummary, putSummary } from '../src/summarizer/summaryStore';
import { summarizeSection, getCachedSummaryWithFallback } from '../src/summarizer/summarize';

// ── fixtures ──────────────────────────────────────────────────────────────────

const section = {
  id: 'document_body',
  label: 'Document',
  text: 'Revenue grew twelve percent year over year. Margins improved to forty percent overall.',
  charRange: [0, 86] as [number, number],
  order: 0,
} as unknown as Section;

const doc = { rawTextHash: 'hash123' } as unknown as DocumentModel;

const EXTRACTIVE_RESPONSE = {
  ok: true,
  sentences: [{ text: 'Revenue grew twelve percent year over year.', range: [0, 43], score: 1 }],
};

/**
 * Fake LanguageModel whose create() emits downloadprogress events on a timer.
 * - repeatSameLoaded: re-emits the SAME fraction forever (a stalled download
 *   that Chrome keeps reporting) and never resolves.
 * - otherwise: emits `ticks` increasing fractions then resolves a session.
 */
function stubLM(opts: { ticks?: number; intervalMs?: number; repeatSameLoaded?: boolean } = {}) {
  const { ticks = 3, intervalMs = 40_000, repeatSameLoaded = false } = opts;
  const prompt = vi.fn(async () => 'Analyst note.');
  const destroy = vi.fn();
  const create = vi.fn(
    (createOpts: {
      monitor?: (m: {
        addEventListener: (t: string, cb: (e: { loaded: number }) => void) => void;
      }) => void;
      signal?: AbortSignal;
    }) => {
      const listeners: Array<(e: { loaded: number }) => void> = [];
      createOpts.monitor?.({ addEventListener: (_t, cb) => listeners.push(cb) });
      return new Promise<{ prompt: typeof prompt; destroy: typeof destroy }>((resolve, reject) => {
        createOpts.signal?.addEventListener('abort', () =>
          reject(new DOMException('aborted', 'AbortError')),
        );
        let tick = 0;
        const step = () => {
          tick++;
          const loaded = repeatSameLoaded ? 0.69 : tick / ticks;
          listeners.forEach((cb) => cb({ loaded }));
          if (!repeatSameLoaded && tick >= ticks) {
            resolve({ prompt, destroy });
          } else {
            setTimeout(step, intervalMs);
          }
        };
        setTimeout(step, intervalMs);
      });
    },
  );
  vi.stubGlobal('LanguageModel', { create });
  return { create, prompt, destroy };
}

// ── setup ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(getCachedSummary).mockReset().mockResolvedValue(null);
  vi.mocked(putSummary).mockReset().mockResolvedValue(undefined);
  vi.stubGlobal('chrome', {
    runtime: { sendMessage: vi.fn(async () => EXTRACTIVE_RESPONSE) },
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

// ── tests ─────────────────────────────────────────────────────────────────────

describe('summarizeSection — builtin stall handling', () => {
  it('falls back to extractive when LM.create never settles (45s stall)', async () => {
    vi.stubGlobal('LanguageModel', { create: vi.fn(() => new Promise(() => {})) });

    const p = summarizeSection(section, doc, { effectiveTier: 'builtin' });
    const resolved = p.then((r) => r);
    await vi.advanceTimersByTimeAsync(45_000);
    const result = await resolved;

    expect(result.register).toBe('extractive');
    expect(result.analystAvailable).toBe(false);
    expect(result.summary).toContain('Revenue grew');
  });

  it('caches a degraded run under the extractive register (poisoning regression)', async () => {
    vi.stubGlobal('LanguageModel', { create: vi.fn(() => new Promise(() => {})) });

    const p = summarizeSection(section, doc, { effectiveTier: 'builtin' });
    await vi.advanceTimersByTimeAsync(45_000);
    await p;

    expect(putSummary).toHaveBeenCalledTimes(1);
    expect(vi.mocked(putSummary).mock.calls[0]![0]).toMatchObject({ register: 'extractive' });
  });

  it('completes builtin when the download progresses steadily (multi-minute run)', async () => {
    const { prompt, destroy } = stubLM({ ticks: 4, intervalMs: 40_000 });
    const seen: number[] = [];

    const p = summarizeSection(section, doc, {
      effectiveTier: 'builtin',
      onDownloadProgress: (v) => seen.push(v),
    });
    // 4 × 40s = 160s total — far beyond a fixed 45s budget, but every gap is
    // under the stall threshold, so the run must complete on the builtin tier.
    await vi.advanceTimersByTimeAsync(160_000);
    const result = await p;

    expect(result.register).toBe('builtin');
    expect(result.analystAvailable).toBe(true);
    expect(result.summary).toBe('Analyst note.');
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(seen).toEqual([0.25, 0.5, 0.75, 1]);
    expect(vi.mocked(putSummary).mock.calls[0]![0]).toMatchObject({ register: 'builtin' });
  });

  it('treats a re-emitted identical fraction as a stall (the frozen-69% case)', async () => {
    const { create } = stubLM({ repeatSameLoaded: true, intervalMs: 20_000 });

    const p = summarizeSection(section, doc, { effectiveTier: 'builtin' });
    // First emit at t=20s bumps once (0.69 is new); every later emit repeats
    // 0.69 and must NOT extend the guard → stall fires 45s after the bump.
    await vi.advanceTimersByTimeAsync(20_000 + 45_000);
    const result = await p;

    expect(create).toHaveBeenCalledTimes(1);
    expect(result.register).toBe('extractive');
  });

  it('propagates a user abort without falling back or caching', async () => {
    stubLM({ repeatSameLoaded: true, intervalMs: 20_000 });
    const ac = new AbortController();

    const p = summarizeSection(section, doc, { effectiveTier: 'builtin', signal: ac.signal });
    const assertion = expect(p).rejects.toMatchObject({ name: 'AbortError' });
    ac.abort();
    await assertion;
    expect(putSummary).not.toHaveBeenCalled();
  });
});

describe('getCachedSummaryWithFallback', () => {
  const degradedEntry = {
    key: 'hash123:document_body:extractive',
    rawTextHash: 'hash123',
    sectionId: 'document_body',
    register: 'extractive',
    plain: 'Cached key sentence.',
    analyst: 'Cached key sentence.',
    plainAnchors: [[0, 20]] as Array<[number, number]>,
    cachedAt: 1,
  };

  it('serves a degraded extractive entry for a builtin-tier request', async () => {
    vi.mocked(getCachedSummary).mockImplementation(async (_h, _s, register) =>
      register === 'extractive' ? degradedEntry : null,
    );
    const lm = stubLM();

    const result = await summarizeSection(section, doc, { effectiveTier: 'builtin' });

    expect(result.fromCache).toBe(true);
    expect(result.register).toBe('extractive');
    expect(result.analystAvailable).toBe(false);
    expect(result.summary).toBe('Cached key sentence.');
    expect(lm.create).not.toHaveBeenCalled();
    expect(putSummary).not.toHaveBeenCalled();
  });

  it('does not fall back across tiers for an extractive request', async () => {
    vi.mocked(getCachedSummary).mockResolvedValue(null);
    const entry = await getCachedSummaryWithFallback('hash123', 'document_body', 'extractive');
    expect(entry).toBeNull();
    // Only the extractive key was consulted — no builtin lookup.
    expect(vi.mocked(getCachedSummary).mock.calls.map((c) => c[2])).toEqual(['extractive']);
  });

  it('prefers a real builtin entry when both exist', async () => {
    const builtinEntry = { ...degradedEntry, register: 'builtin', analyst: 'Real analyst note.' };
    vi.mocked(getCachedSummary).mockImplementation(async (_h, _s, register) =>
      register === 'builtin' ? builtinEntry : degradedEntry,
    );
    const result = await summarizeSection(section, doc, { effectiveTier: 'builtin' });
    expect(result.summary).toBe('Real analyst note.');
    expect(result.analystAvailable).toBe(true);
  });
});
