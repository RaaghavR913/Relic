/**
 * Relic — Phase 2.5: LM session pooling tests.
 *
 * Covers the session-lifecycle contracts in changeSummary.ts without requiring a
 * real Chrome Prompt API — every LM call is replaced with a lightweight in-memory
 * stub.
 *
 * Invariants verified:
 *   1. When a pre-created session is supplied, generateChangeSummary uses it
 *      directly and does NOT call destroy() on it (caller owns the lifecycle).
 *   2. When no session is supplied the function creates one and destroys it on
 *      completion (original one-session-per-call behaviour preserved).
 */

import { describe, it, expect, vi } from 'vitest';
import { generateChangeSummary, type LMSession } from '@/redline/changeSummary';
import type { SectionDiff } from '@/types';
import type { DiffStats } from '@/redline/diff';

// ── helpers ───────────────────────────────────────────────────────────────────

function makeMockSession(answer = 'mock answer'): LMSession & { destroyCount: number } {
  const session = {
    destroyCount: 0,
    prompt: vi.fn().mockResolvedValue(answer),
    promptStreaming: vi.fn().mockImplementation(() => {
      // Return a minimal ReadableStream that emits one chunk then ends.
      return new ReadableStream<string>({
        start(controller) {
          controller.enqueue(answer);
          controller.close();
        },
      });
    }),
    destroy: vi.fn().mockImplementation(function (this: typeof session) {
      this.destroyCount++;
    }),
  };
  return session;
}

function makeMinimalDiff(): SectionDiff {
  return {
    sectionId: 'risk_factors',
    magnitude: 0.25,
    summary: 'Template summary.',
    added: [{ range: [0, 50] as [number, number], text: 'New risk was added to the document.' }],
    removed: [],
  };
}

function makeStats(): DiffStats {
  return {
    addedSentences: 1,
    removedSentences: 0,
    rewordedSentences: 0,
    cosmeticDropped: 0,
    addedChars: 40,
    removedChars: 0,
    pctChanged: 10,
    longestAdded: 'New risk was added',
  };
}

// ── generateChangeSummary pooling ─────────────────────────────────────────────

describe('generateChangeSummary — pooled session', () => {
  it('uses the supplied session and does NOT destroy it', async () => {
    const session = makeMockSession('Supply chain language strengthened.');

    // Install a stub LanguageModel that should never be called when session is passed.
    const createSpy = vi.fn();
    (globalThis as Record<string, unknown>)['LanguageModel'] = { create: createSpy };

    const result = await generateChangeSummary('Risk Factors', makeMinimalDiff(), makeStats(), {
      tier: 'builtin',
      session,
    });

    expect(createSpy).not.toHaveBeenCalled();
    expect(session.prompt).toHaveBeenCalledOnce();
    expect(session.destroyCount).toBe(0); // caller owns the session
    expect(result).toBe('Supply chain language strengthened.');
  });

  it('creates and destroys a session when none is supplied', async () => {
    const session = makeMockSession('Standalone answer.');
    const createSpy = vi.fn().mockResolvedValue(session);
    (globalThis as Record<string, unknown>)['LanguageModel'] = { create: createSpy };

    await generateChangeSummary('Risk Factors', makeMinimalDiff(), makeStats(), {
      tier: 'builtin',
    });

    expect(createSpy).toHaveBeenCalledOnce();
    expect(session.destroyCount).toBe(1); // function-owned session is destroyed
  });

  it('passes LanguageModel language attestation when creating a session', async () => {
    const session = makeMockSession('Standalone answer.');
    const createSpy = vi.fn().mockResolvedValue(session);
    (globalThis as Record<string, unknown>)['LanguageModel'] = { create: createSpy };

    const { hasLanguageModelOutputAttestation } = await import('@/runtime/capabilities');

    await generateChangeSummary('Risk Factors', makeMinimalDiff(), makeStats(), {
      tier: 'builtin',
    });

    expect(createSpy).toHaveBeenCalledOnce();
    expect(hasLanguageModelOutputAttestation(createSpy.mock.calls[0]![0])).toBe(true);
  });

  it('returns the templated summary on the extractive tier without touching the session', async () => {
    const session = makeMockSession('should not be called');
    const result = await generateChangeSummary('Risk Factors', makeMinimalDiff(), makeStats(), {
      tier: 'extractive',
      session,
    });

    expect(session.prompt).not.toHaveBeenCalled();
    expect(session.destroyCount).toBe(0);
    // Result should be the templated string produced by templatedChangeSummary.
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
  });

  it('returns the templated summary when all diff counts are zero', async () => {
    const session = makeMockSession('should not be called');
    const zeroStats: DiffStats = {
      addedSentences: 0,
      removedSentences: 0,
      rewordedSentences: 0,
      cosmeticDropped: 0,
      addedChars: 0,
      removedChars: 0,
      pctChanged: 0,
      longestAdded: '',
    };
    const result = await generateChangeSummary('MD&A', makeMinimalDiff(), zeroStats, {
      tier: 'builtin',
      session,
    });

    expect(session.prompt).not.toHaveBeenCalled();
    expect(session.destroyCount).toBe(0);
    expect(typeof result).toBe('string');
  });
});
