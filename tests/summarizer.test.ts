// ============================================================
// Relic — Session 3 tests: extractive algorithm
// ============================================================

import { describe, it, expect } from 'vitest';
import {
  splitSentences,
  rankByCentrality,
  selectTopN,
  targetSentenceCount,
  cosineSim,
  type SentenceSpan,
} from '../src/summarizer/extractive';

// ── helpers ───────────────────────────────────────────────────────────────────

/** Make a fake unit-length embedding from a simple seed (not random). */
function fakeEmbed(seed: number, dim = 8): Float32Array {
  const v = new Float32Array(dim);
  for (let i = 0; i < dim; i++) {
    v[i] = Math.sin(seed * (i + 1));
  }
  // Normalize
  let norm = 0;
  for (const x of v) norm += x * x;
  norm = Math.sqrt(norm);
  for (let i = 0; i < dim; i++) v[i] = (v[i] ?? 0) / norm;
  return v;
}

// ── splitSentences ────────────────────────────────────────────────────────────

describe('splitSentences', () => {
  it('splits simple prose into sentences', () => {
    // All three sentences are >= 20 chars (the default minLen).
    const text =
      'Revenue grew approximately twelve percent year-over-year. ' +
      'Net income increased by five hundred million dollars. ' +
      'The company expects continued growth across all segments.';
    const spans = splitSentences(text);
    expect(spans.length).toBe(3);
    expect(spans[0]?.text).toContain('Revenue grew');
    expect(spans[1]?.text).toContain('Net income');
    expect(spans[2]?.text).toContain('expects continued');
  });

  it('preserves exact char ranges (round-trip)', () => {
    const text = 'First sentence here. Second sentence follows. Third and final.';
    const spans = splitSentences(text);
    for (const span of spans) {
      const extracted = text.slice(span.range[0], span.range[1]);
      expect(extracted).toBe(span.text);
    }
  });

  it('does not split on abbreviations like Corp. or Inc.', () => {
    const text = 'Acme Corp. reported a 10% rise. Acme Inc. beat estimates. Net income grew.';
    const spans = splitSentences(text);
    // "Corp." and "Inc." should not trigger splits when followed by lowercase or continuation.
    // Expect 2-3 sentences, not 4-5.
    expect(spans.length).toBeLessThanOrEqual(3);
  });

  it('does not split on decimal numbers like $1.2 billion', () => {
    const text = 'The company earned $1.2 billion in revenue. Operating margins improved to 18.5%. Analysts expected 17%.';
    const spans = splitSentences(text);
    // $1.2 and 18.5 should NOT trigger splits
    for (const span of spans) {
      expect(span.text).not.toMatch(/^\d+/); // no span should start with a raw digit from inside a number
    }
    expect(spans.length).toBeLessThanOrEqual(3);
  });

  it('handles text with no sentence boundaries as a single span', () => {
    const text = 'The company had strong performance across all segments and regions during the fiscal year ended December 31';
    const spans = splitSentences(text);
    expect(spans.length).toBe(1);
    expect(spans[0]?.text).toBe(text);
  });

  it('produces non-overlapping, sorted ranges', () => {
    const text = 'Alpha was strong. Beta performed well. Gamma exceeded targets. Delta showed promise.';
    const spans = splitSentences(text);
    for (let i = 1; i < spans.length; i++) {
      expect(spans[i]!.range[0]).toBeGreaterThanOrEqual(spans[i - 1]!.range[1]);
    }
  });

  it('respects minLen and skips very short fragments', () => {
    const text = 'OK. Revenue grew significantly over the prior year period and exceeded analyst expectations.';
    const spans = splitSentences(text, 20);
    // "OK." (2 chars) should be excluded
    expect(spans.every((s) => s.text.length >= 20)).toBe(true);
  });

  it('handles empty and whitespace-only text', () => {
    expect(splitSentences('')).toEqual([]);
    expect(splitSentences('   \n  ')).toEqual([]);
  });

  it('handles exclamation and question marks', () => {
    const text = 'Earnings beat expectations! Will growth continue? Analysts remain optimistic about the outlook.';
    const spans = splitSentences(text);
    expect(spans.length).toBe(3);
  });

  it('does not split on U.S. or e.g. abbreviations', () => {
    const text = 'U.S. revenues grew by 12%. E.g. the mid-market segment saw strong gains. Total sales increased.';
    const spans = splitSentences(text);
    // "U.S." and "E.g." should not split
    expect(spans.length).toBeLessThanOrEqual(3);
  });
});

// ── cosineSim ─────────────────────────────────────────────────────────────────

describe('cosineSim', () => {
  it('returns 1 for identical unit vectors', () => {
    const v = fakeEmbed(1);
    expect(cosineSim(v, v)).toBeCloseTo(1, 5);
  });

  it('returns 0 for orthogonal vectors', () => {
    const a = new Float32Array([1, 0, 0]);
    const b = new Float32Array([0, 1, 0]);
    expect(cosineSim(a, b)).toBeCloseTo(0, 5);
  });

  it('clamps to [-1, 1]', () => {
    const a = fakeEmbed(5);
    const b = fakeEmbed(6);
    const sim = cosineSim(a, b);
    expect(sim).toBeGreaterThanOrEqual(-1);
    expect(sim).toBeLessThanOrEqual(1);
  });
});

// ── rankByCentrality ──────────────────────────────────────────────────────────

describe('rankByCentrality', () => {
  it('returns [] for empty input', () => {
    expect(rankByCentrality([], [])).toEqual([]);
  });

  it('returns score 1 for single sentence', () => {
    const span: SentenceSpan = { text: 'hello', range: [0, 5] };
    const emb = fakeEmbed(1);
    const ranked = rankByCentrality([span], [emb]);
    expect(ranked.length).toBe(1);
    expect(ranked[0]?.score).toBe(1);
  });

  it('produces scores in [0, 1] for multiple sentences', () => {
    const spans: SentenceSpan[] = [
      { text: 'Alpha sentence.', range: [0, 15] },
      { text: 'Beta sentence.', range: [16, 30] },
      { text: 'Gamma sentence.', range: [31, 46] },
    ];
    const embeddings = [fakeEmbed(1), fakeEmbed(2), fakeEmbed(3)];
    const ranked = rankByCentrality(spans, embeddings);
    expect(ranked.length).toBe(3);
    for (const r of ranked) {
      expect(r.score).toBeGreaterThanOrEqual(0);
      expect(r.score).toBeLessThanOrEqual(1);
    }
  });

  it('gives higher centrality to the sentence most similar to others', () => {
    // Make two nearly identical embeddings and one very different one.
    // The similar pair should both score higher than the outlier.
    const similar1 = fakeEmbed(1);
    const similar2 = fakeEmbed(1); // same seed → identical
    const outlier = fakeEmbed(100);

    const spans: SentenceSpan[] = [
      { text: 'A', range: [0, 1] },
      { text: 'B', range: [2, 3] },
      { text: 'C', range: [4, 5] },
    ];
    const ranked = rankByCentrality(spans, [similar1, similar2, outlier]);
    const outlierEntry = ranked.find((r) => r.text === 'C');
    const similarEntry = ranked.find((r) => r.text === 'A');
    expect(similarEntry!.score).toBeGreaterThan(outlierEntry!.score);
  });
});

// ── selectTopN ────────────────────────────────────────────────────────────────

describe('selectTopN', () => {
  it('selects top N by score and re-sorts by position', () => {
    const ranked = [
      { text: 'A', range: [0, 10] as [number, number], score: 0.9 },
      { text: 'B', range: [20, 30] as [number, number], score: 0.5 },
      { text: 'C', range: [40, 50] as [number, number], score: 0.8 },
      { text: 'D', range: [60, 70] as [number, number], score: 0.3 },
    ];
    const top = selectTopN(ranked, 2);
    // Should pick A (0.9) and C (0.8), then sort by position → A then C
    expect(top.length).toBe(2);
    expect(top[0]?.text).toBe('A');
    expect(top[1]?.text).toBe('C');
  });

  it('clamps N to at least 1', () => {
    const ranked = [{ text: 'X', range: [0, 5] as [number, number], score: 0.5 }];
    expect(selectTopN(ranked, 0).length).toBe(1);
    expect(selectTopN(ranked, -5).length).toBe(1);
  });

  it('handles N > array length gracefully', () => {
    const ranked = [
      { text: 'A', range: [0, 1] as [number, number], score: 1 },
      { text: 'B', range: [2, 3] as [number, number], score: 0.5 },
    ];
    expect(selectTopN(ranked, 10).length).toBe(2);
  });
});

// ── targetSentenceCount ───────────────────────────────────────────────────────

describe('targetSentenceCount', () => {
  it('returns small counts for short sections', () => {
    expect(targetSentenceCount(100)).toBeLessThanOrEqual(3);
  });

  it('returns larger counts for long sections', () => {
    expect(targetSentenceCount(50_000)).toBeGreaterThanOrEqual(7);
  });

  it('is monotonically non-decreasing', () => {
    const lengths = [0, 200, 500, 1_000, 2_000, 5_000, 10_000, 20_000, 50_000];
    let prev = 0;
    for (const l of lengths) {
      const n = targetSentenceCount(l);
      expect(n).toBeGreaterThanOrEqual(prev);
      prev = n;
    }
  });
});

// ── end-to-end extractive pipeline (no worker) ────────────────────────────────

describe('extractive pipeline (unit)', () => {
  it('produces reading-order selected sentences from a paragraph', () => {
    const text = [
      'Revenue increased by 12% year-over-year driven by strong product sales.',
      'Gross margin improved to 42% from 38% in the prior period.',
      'Operating expenses remained flat as the company maintained cost discipline.',
      'Net income attributable to common shareholders was $450 million.',
      'The company repurchased $200 million of shares during the quarter.',
      'Management reaffirmed full-year guidance of $1.8 billion in revenue.',
    ].join(' ');

    const spans = splitSentences(text);
    expect(spans.length).toBeGreaterThanOrEqual(4);

    // Fake embeddings — different per sentence
    const embeddings = spans.map((_, i) => fakeEmbed(i + 1));

    const ranked = rankByCentrality(spans, embeddings);
    const n = targetSentenceCount(text.length);
    const top = selectTopN(ranked, n);

    // Selected sentences must be in original order
    for (let i = 1; i < top.length; i++) {
      expect(top[i]!.range[0]).toBeGreaterThan(top[i - 1]!.range[0]);
    }

    // All selected text must be substrings of original
    for (const s of top) {
      expect(text.slice(s.range[0], s.range[1])).toBe(s.text);
    }
  });
});
