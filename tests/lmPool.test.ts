/**
 * FilingLens — Phase 2.5: LM session pooling tests.
 *
 * Covers the session-lifecycle contracts introduced in changeSummary.ts and
 * synthesize.ts without requiring a real Chrome Prompt API — every LM call is
 * replaced with a lightweight in-memory stub.
 *
 * Invariants verified:
 *   1. When a pre-created session is supplied, generateChangeSummary / streamAnswer
 *      use it directly and do NOT call destroy() on it (caller owns the lifecycle).
 *   2. When no session is supplied the functions create one and destroy it on completion
 *      (original one-session-per-call behaviour preserved).
 *   3. Filing-change disposal: separate sessions created for two different filings
 *      do not share state (verified via separate destroy call counts).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { generateChangeSummary } from '@/redline/changeSummary';
import { streamAnswer, buildQaPrompt } from '@/sidepanel/qa/synthesize';
import type { LMSession } from '@/sidepanel/qa/synthesize';
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

function makePassage(n: number) {
  return {
    chunkId: `c${n}`,
    sectionId: `item_${n}`,
    sectionLabel: 'Risk Factors',
    charRange: [n * 100, n * 100 + 40] as [number, number],
    text: 'Supply chain disruptions may adversely affect operations.',
    score: 0.9,
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

// ── streamAnswer pooling ───────────────────────────────────────────────────────

describe('streamAnswer — pooled session', () => {
  beforeEach(() => {
    delete (globalThis as Record<string, unknown>)['LanguageModel'];
  });

  it('uses the supplied session and does NOT destroy it', async () => {
    const session = makeMockSession('Revenue grew 12%.');
    const passages = [makePassage(1), makePassage(2)];
    const tokens: string[] = [];

    const result = await streamAnswer('How did revenue change?', passages, {
      session,
      onToken: (t) => tokens.push(t),
    });

    expect(session.promptStreaming).toHaveBeenCalledOnce();
    expect(session.destroyCount).toBe(0); // caller owns the session
    expect(result).toBe('Revenue grew 12%.');
    expect(tokens).toContain('Revenue grew 12%.');
  });

  it('throws when no session and no LanguageModel is present', async () => {
    const passages = [makePassage(1)];
    await expect(
      streamAnswer('Any question', passages, { onToken: () => {} }),
    ).rejects.toThrow(/unavailable/i);
  });

  it('creates and destroys a session when none is supplied', async () => {
    const session = makeMockSession('Created inline.');
    const createSpy = vi.fn().mockResolvedValue(session);
    (globalThis as Record<string, unknown>)['LanguageModel'] = { create: createSpy };

    await streamAnswer('What are the risk factors?', [makePassage(1)], {
      onToken: () => {},
    });

    expect(createSpy).toHaveBeenCalledOnce();
    expect(session.destroyCount).toBe(1);
  });
});

// ── session reuse across sequential Q&A calls ────────────────────────────────

describe('sequential Q&A reuse within a filing session', () => {
  it('a single pooled session can handle multiple prompt calls', async () => {
    const session = makeMockSession('Answer for all questions.');
    const passages = [makePassage(1)];

    for (const q of ['Q1?', 'Q2?', 'Q3?']) {
      const result = await streamAnswer(q, passages, { session, onToken: () => {} });
      expect(result).toBe('Answer for all questions.');
    }

    // Three calls, zero destroys — the pool owner controls the session lifecycle.
    expect(session.promptStreaming).toHaveBeenCalledTimes(3);
    expect(session.destroyCount).toBe(0);
  });
});

// ── cross-filing isolation ────────────────────────────────────────────────────

describe('cross-filing isolation', () => {
  it('separate sessions for separate filings are destroyed independently', async () => {
    const sessionA = makeMockSession('Filing A answer.');
    const sessionB = makeMockSession('Filing B answer.');
    const passages = [makePassage(1)];

    // Simulate filing A: use sessionA for one question.
    await streamAnswer('Revenue?', passages, { session: sessionA, onToken: () => {} });
    expect(sessionA.destroyCount).toBe(0);

    // Filing changes: caller destroys sessionA.
    sessionA.destroy();
    expect(sessionA.destroyCount).toBe(1);

    // Simulate filing B: use sessionB — sessionA's state is gone.
    await streamAnswer('Risks?', passages, { session: sessionB, onToken: () => {} });
    expect(sessionB.promptStreaming).toHaveBeenCalledOnce();
    expect(sessionA.promptStreaming).toHaveBeenCalledOnce(); // sessionA not reused
    expect(sessionB.destroyCount).toBe(0);
  });
});

// ── buildQaPrompt (pure, no session needed) ───────────────────────────────────

describe('buildQaPrompt — sanity check', () => {
  it('produces a prompt containing the question and passage labels', () => {
    const p = makePassage(1);
    const prompt = buildQaPrompt('What are the main risks?', [p]);
    expect(prompt).toContain('What are the main risks?');
    expect(prompt).toContain('[1] (Risk Factors)');
  });
});
