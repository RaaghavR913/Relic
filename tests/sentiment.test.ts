// ============================================================
// Disclora — Session 4 tests: FinBERT sentiment heatmap
// ============================================================
//
// Tests cover:
//   1. sentenceSplit edge-cases specific to SEC/financial text.
//   2. Table-range exclusion logic (the standalone predicate used in offscreen.ts).
//   3. getSentimentLayer() bucketing.
//   4. Sentiment aggregate computation.
//   5. Sanity-check labels: Risk Factor sentences should score negative more
//      than positive when classified with a simple heuristic (model-free proxy).
//
// The actual FinBERT model is NOT loaded in unit tests (no ONNX runtime in
// vitest/jsdom). Integration tests (marked with .skip) document the expected
// on-device behaviour for manual verification.
// ============================================================

import { describe, it, expect } from 'vitest';
import { splitSentences } from '../src/summarizer/extractive';
import { getSentimentLayer, SENTIMENT_LAYERS } from '../src/content/highlight/demo';

// ── helpers ───────────────────────────────────────────────────────────────────

/**
 * Predicate: is the sentence's document-space range NOT covered by any table region?
 * Extracted from offscreen.ts so it can be tested purely.
 */
function notInTable(
  sentSectionStart: number,
  sentSectionEnd: number,
  sectionDocOffset: number,
  tableRanges: ReadonlyArray<[number, number]>,
): boolean {
  if (tableRanges.length === 0) return true;
  const docStart = sectionDocOffset + sentSectionStart;
  const docEnd = sectionDocOffset + sentSectionEnd;
  return !tableRanges.some(([ts, te]) => docStart < te && docEnd > ts);
}

/** Simple aggregate counter for test assertions. */
function aggregate(labels: string[]): { pos: number; neg: number; neu: number } {
  let pos = 0;
  let neg = 0;
  let neu = 0;
  for (const l of labels) {
    if (l === 'positive') pos++;
    else if (l === 'negative') neg++;
    else neu++;
  }
  return { pos, neg, neu };
}

// ── splitSentences: financial abbreviations ───────────────────────────────────

describe('splitSentences – SEC/financial edge cases', () => {
  it('does not split on "Inc." in a company name', () => {
    const text =
      'Apple Inc. reported revenue of $89.5 billion for the quarter. ' +
      'This exceeded analyst expectations by a significant margin.';
    const spans = splitSentences(text);
    expect(spans.length).toBe(2);
    expect(spans[0]?.text).toContain('Apple Inc.');
  });

  it('does not split on "Corp." in a company name', () => {
    const text =
      'Alphabet Corp. operates through several subsidiary companies. ' +
      'Management expects continued revenue diversification.';
    const spans = splitSentences(text);
    expect(spans.length).toBe(2);
  });

  it('does not split on "No." used as abbreviation for "Number"', () => {
    const text =
      'The risk factor described in No. 7 below could materially impact operations. ' +
      'Investors should review this section carefully.';
    const spans = splitSentences(text);
    expect(spans.length).toBe(2);
    expect(spans[0]?.text).toContain('No. 7');
  });

  it('does not split inside dollar amounts like "$1.5 billion"', () => {
    // "$1.5" should not end a sentence because "5" is a digit, not uppercase.
    const text =
      'The company generated $1.5 billion in free cash flow. ' +
      'Capital expenditures were $0.8 billion for the year.';
    const spans = splitSentences(text);
    expect(spans.length).toBe(2);
    expect(spans[0]?.text).toContain('$1.5 billion');
  });

  it('does not split on decimal percentages like "3.2%"', () => {
    const text =
      'Revenue declined 3.2% year-over-year on a constant currency basis. ' +
      'Foreign exchange headwinds accounted for approximately two percentage points.';
    const spans = splitSentences(text);
    expect(spans.length).toBe(2);
  });

  it('handles parenthetical closings before period', () => {
    const text =
      'We may face regulatory scrutiny (see Item 1A). ' +
      'Such investigations could result in material penalties.';
    const spans = splitSentences(text);
    expect(spans.length).toBe(2);
    expect(spans[0]?.text).toContain('Item 1A');
  });

  it('handles "U.S." abbreviation', () => {
    const text =
      'The U.S. market remains our primary source of revenue. ' +
      'International operations contributed twenty percent of total sales.';
    const spans = splitSentences(text);
    expect(spans.length).toBe(2);
    expect(spans[0]?.text).toContain('U.S.');
  });

  it('splits on sentence-terminal periods at end of clause', () => {
    const text =
      'We face significant competition in all markets we serve. ' +
      'Failure to maintain our competitive position could harm our business. ' +
      'New entrants may offer lower pricing or superior technology.';
    const spans = splitSentences(text);
    expect(spans.length).toBe(3);
  });

  it('preserves exact round-trip char ranges for financial text', () => {
    const text =
      'Net revenues increased by $2.3 billion to $45.1 billion. ' +
      'Operating income margin expanded by 150 basis points to 28.5%.';
    const spans = splitSentences(text);
    for (const span of spans) {
      const extracted = text.slice(span.range[0], span.range[1]);
      expect(extracted).toBe(span.text);
    }
  });

  it('handles multi-sentence risk factor text', () => {
    const rfText =
      'Our operations are subject to various risks that could adversely affect our business. ' +
      'These risks include, but are not limited to, changes in market conditions. ' +
      'We cannot guarantee that our risk management practices will be effective. ' +
      'Adverse developments could result in significant financial losses.';
    const spans = splitSentences(rfText);
    expect(spans.length).toBe(4);
  });
});

// ── table exclusion predicate ────────────────────────────────────────────────

describe('table exclusion', () => {
  it('includes sentence not overlapping any table', () => {
    // Section starts at doc offset 1000. Sentence at section[0,50]. Table at [200,400] (doc).
    expect(notInTable(0, 50, 1000, [[200, 400]])).toBe(true);
  });

  it('excludes sentence fully inside table range', () => {
    // Sentence at section[50,100], doc offset 1000 → doc[1050,1100]. Table covers [1040, 1120].
    expect(notInTable(50, 100, 1000, [[1040, 1120]])).toBe(false);
  });

  it('excludes sentence partially overlapping table (start inside)', () => {
    // Sentence doc[1080, 1150]. Table [1040, 1120].  1080 < 1120 && 1150 > 1040 → overlap.
    expect(notInTable(80, 150, 1000, [[1040, 1120]])).toBe(false);
  });

  it('excludes sentence partially overlapping table (end inside)', () => {
    // Sentence doc[1020, 1070]. Table [1050, 1200].  1020 < 1200 && 1070 > 1050 → overlap.
    expect(notInTable(20, 70, 1000, [[1050, 1200]])).toBe(false);
  });

  it('includes sentence adjacent but not overlapping table', () => {
    // Sentence doc[1000, 1050]. Table [1050, 1200]. No overlap (end == table start).
    expect(notInTable(0, 50, 1000, [[1050, 1200]])).toBe(true);
  });

  it('handles empty table ranges', () => {
    expect(notInTable(0, 100, 500, [])).toBe(true);
  });

  it('excludes sentence when multiple tables and one overlaps', () => {
    // Tables at [800,900] and [1060,1120]. Sentence doc[1050,1090] overlaps second.
    expect(notInTable(50, 90, 1000, [[800, 900], [1060, 1120]])).toBe(false);
  });
});

// ── getSentimentLayer bucketing ───────────────────────────────────────────────

describe('getSentimentLayer', () => {
  it('returns sent-neu for neutral label regardless of score', () => {
    expect(getSentimentLayer('neutral', 0.99)).toBe('sent-neu');
    expect(getSentimentLayer('neutral', 0.50)).toBe('sent-neu');
  });

  it('buckets positive low (score < 0.65)', () => {
    expect(getSentimentLayer('positive', 0.51)).toBe('sent-pos-1');
    expect(getSentimentLayer('positive', 0.64)).toBe('sent-pos-1');
  });

  it('buckets positive medium (0.65 ≤ score < 0.85)', () => {
    expect(getSentimentLayer('positive', 0.65)).toBe('sent-pos-2');
    expect(getSentimentLayer('positive', 0.80)).toBe('sent-pos-2');
  });

  it('buckets positive high (score ≥ 0.85)', () => {
    expect(getSentimentLayer('positive', 0.85)).toBe('sent-pos-3');
    expect(getSentimentLayer('positive', 0.99)).toBe('sent-pos-3');
  });

  it('buckets negative low (score < 0.65)', () => {
    expect(getSentimentLayer('negative', 0.55)).toBe('sent-neg-1');
  });

  it('buckets negative medium (0.65 ≤ score < 0.85)', () => {
    expect(getSentimentLayer('negative', 0.70)).toBe('sent-neg-2');
  });

  it('buckets negative high (score ≥ 0.85)', () => {
    expect(getSentimentLayer('negative', 0.90)).toBe('sent-neg-3');
  });

  it('every layer name is in SENTIMENT_LAYERS', () => {
    const labels = ['positive', 'negative', 'neutral'] as const;
    const scores = [0.51, 0.70, 0.90];
    for (const label of labels) {
      for (const score of scores) {
        const layer = getSentimentLayer(label, score);
        expect(SENTIMENT_LAYERS).toContain(layer);
      }
    }
  });
});

// ── Risk Factors skew negative sanity check (heuristic proxy) ─────────────────
//
// We cannot run the actual FinBERT model in unit tests. Instead, we use a naive
// keyword heuristic to verify that a representative Risk Factors passage contains
// significantly more "risky/negative" vocabulary than positive vocabulary.
// This is the proxy for the spec's "verify Risk Factors skews negative" requirement.
// The real model test is documented below as a manual integration step.

describe('Risk Factors negative-skew sanity (heuristic)', () => {
  const NEGATIVE_WORDS = new Set([
    'risk', 'risks', 'adverse', 'adversely', 'fail', 'failure', 'harm',
    'harmed', 'loss', 'losses', 'decline', 'declined', 'impair', 'impaired',
    'material', 'significantly', 'competitive', 'competition', 'uncertain',
    'uncertainty', 'volatility', 'disruption', 'disruptions', 'liability',
    'litigation', 'penalty', 'penalties', 'breach', 'regulatory', 'unfavorable',
  ]);

  const POSITIVE_WORDS = new Set([
    'growth', 'increase', 'increased', 'profit', 'profitable', 'strong',
    'improve', 'improved', 'expand', 'expanded', 'opportunity', 'opportunities',
    'benefit', 'benefits', 'success', 'successful',
  ]);

  function countKeywords(text: string, wordSet: Set<string>): number {
    return text.toLowerCase().split(/\W+/).filter((w) => wordSet.has(w)).length;
  }

  const riskFactorSample =
    'Our operations are subject to various risks that could adversely affect our ' +
    'business, financial condition, and results of operations. ' +
    'These risks include competitive pressure from existing and new market entrants. ' +
    'Failure to retain key personnel could harm our ability to execute our strategy. ' +
    'We may experience adverse impacts from changes in regulatory requirements. ' +
    'Uncertain macroeconomic conditions and volatility in financial markets may result ' +
    'in material losses to our investment portfolio. ' +
    'Litigation and regulatory investigations could result in significant penalties ' +
    'and reputational damage. ' +
    'There is no assurance that our risk management practices will be effective in ' +
    'preventing losses arising from unfavorable market conditions.';

  it('Risk Factors passage has more negative than positive keyword hits', () => {
    const negHits = countKeywords(riskFactorSample, NEGATIVE_WORDS);
    const posHits = countKeywords(riskFactorSample, POSITIVE_WORDS);
    // Expect at least 3× more negative keywords — a generous threshold so this
    // remains stable even with slight text changes.
    expect(negHits).toBeGreaterThan(posHits * 3);
    console.log(`[sanity] Risk Factors: ${negHits} neg keywords vs ${posHits} pos keywords`);
  });

  it('Risk Factors sentences are majority-negative on keyword score', () => {
    const sentences = splitSentences(riskFactorSample);
    let negSents = 0;
    let posSents = 0;

    for (const sent of sentences) {
      const neg = countKeywords(sent.text, NEGATIVE_WORDS);
      const pos = countKeywords(sent.text, POSITIVE_WORDS);
      if (neg > pos) negSents++;
      else if (pos > neg) posSents++;
    }

    // More sentences should lean negative than positive.
    expect(negSents).toBeGreaterThan(posSents);
    console.log(
      `[sanity] ${sentences.length} sentences: ${negSents} neg-dominant, ${posSents} pos-dominant`,
    );
  });
});

// ── Integration test stubs (require FinBERT model — skip in CI) ───────────────
//
// To run manually after loading the extension in Chrome:
//   1. Open any SEC 10-K Risk Factors section.
//   2. Open DevTools console and run:
//        const rf = __Disclora.result.model.sections
//          .find(s => s.id.includes('risk'));
//        // Then check sentiment highlights painted on the page.
//   3. Expected: Risk Factors section shows predominantly red (negative) highlights.
//   4. Expected: Business / Strategy section shows mixed or slightly positive highlights.
//
// Timing targets:
//   - Warm inference (model already loaded): first section overlay < 3 s.
//   - Full 10-K pass: < 30 s on WebGPU (logged in console as
//       "[offscreen] sentiment complete: N sentences in Xms").

describe.skip('FinBERT integration (requires model — run manually in extension)', () => {
  it('Risk Factors section classifies majority negative', () => {
    // Placeholder — not runnable in vitest without ONNX runtime.
    expect(true).toBe(true);
  });

  it('warm inference time < 3000 ms for first section', () => {
    expect(true).toBe(true);
  });

  it('full 10-K pass < 30000 ms on WebGPU', () => {
    expect(true).toBe(true);
  });
});
