/**
 * Relic — SemanticExcerptSelector tests.
 *
 * Verifies the embedding-reranked excerpt selection blends cosine similarity
 * with the existing keyword score, and — critically — falls back cleanly to
 * pure keyword ranking (selectRelevantText) whenever the injected embedder
 * seam is unavailable, errors, or only partially answers.
 */

import { describe, it, expect, vi } from 'vitest';
import type { DocumentModel, Section } from '@/types';
import { SemanticExcerptSelector, type Embedder } from '@/analyst/semanticRerank';
import { selectRelevantText } from '@/analyst/relevance';

// ── fixtures ──────────────────────────────────────────────────────────────────

// Both sentences match KEYWORDS.revenue equally ("revenue growth") and carry
// no numeric bonus, so keyword scoring alone ties them and the tiebreak falls
// to document order — S1 (first) wins on keyword score alone.
const S1 = 'Revenue growth remained steady during the period under review for investors.';
const S2 = 'Revenue growth accelerated meaningfully compared to the prior fiscal year period.';

function makeDoc(): DocumentModel {
  const text = `${S1} ${S2}`;
  const section: Section = {
    id: 'item_7_mdna',
    label: 'Item 7. MD&A',
    order: 0,
    text,
    charRange: [0, text.length],
  };
  return {
    source: { url: 'https://www.sec.gov/Archives/x.htm', host: 'edgar' },
    filingType: '10-K',
    sections: [section],
    rawTextHash: 'test-hash',
  };
}

/** Unit vectors: S2 is aligned with every query text; S1 is orthogonal to it. */
function alignedEmbedder(calls?: string[][]): Embedder {
  return async (texts) => {
    calls?.push(texts);
    return texts.map((t) => (t === S1 ? new Float32Array([0, 1]) : new Float32Array([1, 0])));
  };
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe('SemanticExcerptSelector', () => {
  it('falls back to keyword-only ranking when the embedder resolves null', async () => {
    const nullEmbedder: Embedder = async () => null;
    const selector = new SemanticExcerptSelector(nullEmbedder);
    const doc = makeDoc();

    const got = await selector.select(doc, ['revenue'], 90);
    const want = selectRelevantText(doc, ['revenue'], 90);
    expect(got).toBe(want);
    expect(got).toContain(S1); // keyword tie → document order picks S1 first
  });

  it('falls back to keyword-only ranking when the embedder throws', async () => {
    const throwingEmbedder: Embedder = async () => {
      throw new Error('offscreen unavailable');
    };
    const selector = new SemanticExcerptSelector(throwingEmbedder);
    const doc = makeDoc();

    const got = await selector.select(doc, ['revenue'], 90);
    expect(got).toBe(selectRelevantText(doc, ['revenue'], 90));
  });

  it('falls back when the embedder returns the wrong vector count', async () => {
    const shortEmbedder: Embedder = async (texts) => texts.slice(1).map(() => new Float32Array([1, 0]));
    const selector = new SemanticExcerptSelector(shortEmbedder);
    const doc = makeDoc();

    const got = await selector.select(doc, ['revenue'], 90);
    expect(got).toBe(selectRelevantText(doc, ['revenue'], 90));
  });

  it('reranks a keyword tie by embedding similarity to the dimension query', async () => {
    const selector = new SemanticExcerptSelector(alignedEmbedder());
    const doc = makeDoc();

    // Budget fits exactly one sentence — keyword-only would pick S1 (doc order
    // tiebreak); the semantic blend should surface S2 instead, since it's the
    // one aligned with the (mocked) revenue query embedding.
    const got = await selector.select(doc, ['revenue'], 90);
    expect(got).toContain(S2);
    expect(got).not.toContain(S1);
  });

  it('embeds the candidate pool and each dimension query at most once per instance', async () => {
    const calls: string[][] = [];
    const selector = new SemanticExcerptSelector(alignedEmbedder(calls));
    const doc = makeDoc();

    await selector.select(doc, ['revenue'], 200);
    await selector.select(doc, ['revenue'], 200); // same dimension again
    await selector.select(doc, ['margins'], 200); // a different dimension

    // 1 call for the shared candidate pool + 1 per distinct dimension query
    // (revenue, margins) = 3, regardless of how many times select() is called.
    expect(calls.length).toBe(3);
  });

  it('returns empty when no candidate matches the requested dimension', async () => {
    const selector = new SemanticExcerptSelector(alignedEmbedder());
    const text = 'The weather was pleasant and unrelated to any financial topic whatsoever.';
    const doc: DocumentModel = {
      source: { url: 'https://www.sec.gov/Archives/x.htm', host: 'edgar' },
      filingType: '10-K',
      sections: [{ id: 'item_1_business', label: 'Item 1', order: 0, text, charRange: [0, text.length] }],
      rawTextHash: 'test-hash-2',
    };
    const got = await selector.select(doc, ['revenue'], 200);
    expect(got).toBe('');
  });

  it('a fresh instance re-embeds independently (no cross-instance cache leakage)', async () => {
    const fn = vi.fn(alignedEmbedder());
    const a = new SemanticExcerptSelector(fn);
    const b = new SemanticExcerptSelector(fn);
    const doc = makeDoc();

    await a.select(doc, ['revenue'], 200);
    const afterA = fn.mock.calls.length;
    await b.select(doc, ['revenue'], 200);
    expect(fn.mock.calls.length).toBeGreaterThan(afterA);
  });
});
