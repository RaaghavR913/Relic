/**
 * Deterministic (no-Gemini-Nano) Analyst tier.
 *
 * The extractive tier must produce REAL investor cards from on-device signals —
 * not an empty shell behind a "needs Gemini Nano" banner. These tests pin that
 * the deterministic path synthesizes takeaways, risk signals, and per-dimension
 * cards from sentiment + flags + redline, using the filing's own words, and that
 * a sparse document yields honest empties (no fabricated cards).
 */

import { describe, it, expect } from 'vitest';
import { generateFilingAnalysis } from '@/analyst/pipeline';
import type { AuxSignals } from '@/analyst/deterministic';
import type {
  DocumentModel,
  LanguageFlag,
  Section,
  SentenceSentiment,
} from '@/types';
import type { RedlineEntry } from '@/redline/redlineStore';

function section(id: string, label: string, order: number, text: string, start: number): Section {
  return { id, label, order, text, charRange: [start, start + text.length] };
}

const MDNA_TEXT =
  'Revenue increased 12% to $1.2 billion driven by strong customer demand. ' +
  'Gross margin expanded to 45% on improved operating leverage and pricing. ' +
  'Operating cash flow was $300 million for the full fiscal year. ' +
  'We repurchased $50 million of common shares and increased the quarterly dividend.';

const RISK_TEXT =
  'Our business faces significant litigation and regulatory risk across our markets. ' +
  'Adverse macroeconomic conditions could materially harm our results of operations. ' +
  'We depend on a concentrated group of customers for a majority of our revenue.';

function richDoc(): DocumentModel {
  return {
    source: { url: 'https://www.sec.gov/Archives/edgar/data/1/x-10k.htm', host: 'edgar', category: 'edgar_filing' },
    companyName: 'Acme Industries, Inc.',
    ticker: 'ACME',
    filingType: '10-K',
    filingTypeConfidence: 'high',
    sections: [
      section('item_7_mdna', "Management's Discussion and Analysis", 90, MDNA_TEXT, 0),
      section('item_1a_risk_factors', 'Risk Factors', 20, RISK_TEXT, 1000),
    ],
    rawTextHash: 'hash-rich',
  };
}

function makeSentiments(): SentenceSentiment[] {
  const out: SentenceSentiment[] = [];
  // MD&A: mostly positive.
  for (let i = 0; i < 10; i++) {
    out.push({ sectionId: 'item_7_mdna', sentenceIdx: i, label: i < 7 ? 'positive' : 'neutral', score: 0.8, range: [i, i + 1] });
  }
  // Risk: mostly negative.
  for (let i = 0; i < 6; i++) {
    out.push({ sectionId: 'item_1a_risk_factors', sentenceIdx: i, label: i < 5 ? 'negative' : 'neutral', score: 0.8, range: [1000 + i, 1001 + i] });
  }
  return out;
}

function makeFlags(): LanguageFlag[] {
  const types: LanguageFlag['type'][] = ['litigious', 'litigious', 'uncertainty', 'uncertainty', 'negative', 'negative', 'negative', 'weak_modal', 'litigious', 'negative'];
  return types.map((type, i) => ({
    type,
    range: [1000 + i, 1005 + i] as [number, number],
    sectionId: 'item_1a_risk_factors',
    term: 'risk',
    note: 'flagged',
  }));
}

const REDLINE: RedlineEntry = {
  rawTextHash: 'hash-rich',
  status: 'computed',
  diffs: [
    { sectionId: 'item_1a_risk_factors', added: [], removed: [], magnitude: 0.3, summary: 'Risk Factors substantially rewritten vs the prior year.' },
  ],
  alignment: [],
  cachedAt: Date.now(),
};

describe('deterministic Analyst tier (extractive)', () => {
  const aux: AuxSignals = { sentiments: makeSentiments(), flags: makeFlags(), redline: REDLINE };

  it('is marked degraded but populates real cards', async () => {
    const a = await generateFilingAnalysis(richDoc(), { tier: 'extractive', aux });
    expect(a.degraded).toBe(true);
    expect(a.topTakeaways.length).toBeGreaterThan(0);
    expect(a.riskSignals.length).toBeGreaterThan(0);
    expect(a.revenueImpact.length).toBeGreaterThan(0);
    expect(a.marginImpact.length).toBeGreaterThan(0);
    expect(a.whatChanged.length).toBeGreaterThan(0); // from the redline
  });

  it("uses the filing's own words (no fabrication) and grounds the one-liner in signals", async () => {
    const a = await generateFilingAnalysis(richDoc(), { tier: 'extractive', aux });
    const allText = a.topTakeaways.concat(a.revenueImpact).map((i) => i.summary).join(' ');
    expect(allText).toMatch(/Revenue increased 12%|Gross margin expanded/);
    expect(a.oneSentenceSummary).toMatch(/sentiment .*positive|cautionary-language flag|changed vs the prior filing/);
  });

  it('flags dense cautionary language as a risk signal', async () => {
    const a = await generateFilingAnalysis(richDoc(), { tier: 'extractive', aux });
    expect(a.riskSignals.some((r) => /cautionary language density/i.test(r.title))).toBe(true);
  });

  it('derives a non-Neutral read + labeled cards from flags & positive language when FinBERT sentiment is absent (gap #4)', async () => {
    // The auto-run analyst reads sentiment from cache, but FinBERT is a manual
    // pass — so on first view there are no sentiments. The lexicon tone proxy must
    // still produce a real read and skew labels rather than a flat Neutral.
    const a = await generateFilingAnalysis(richDoc(), {
      tier: 'extractive',
      aux: { flags: makeFlags(), redline: REDLINE }, // NO sentiments
    });
    expect(a.overallRead).not.toBe('Neutral');
    // MD&A's positive language → a bullish revenue/margin card.
    const positiveCards = [...a.revenueImpact, ...a.marginImpact];
    expect(positiveCards.some((c) => c.label === 'Bullish')).toBe(true);
  });

  it('leaves genuinely LM-only sections empty', async () => {
    const a = await generateFilingAnalysis(richDoc(), { tier: 'extractive', aux });
    expect(a.bullCase).toEqual([]);
    expect(a.bearCase).toEqual([]);
    expect(a.managementNarrativeCheck).toEqual([]);
    expect(a.whatToWatchNext).toEqual([]);
  });

  it('produces honest empties on a sparse document (no fabricated cards)', async () => {
    const sparse: DocumentModel = {
      source: { url: 'https://x.com', host: 'ir', category: 'ir_or_financial' },
      filingType: 'UNKNOWN',
      filingTypeConfidence: 'low',
      sections: [section('document_body', 'Document', 1, 'A brief cover note with no financial content here.', 0)],
      rawTextHash: 'hash-sparse',
    };
    const a = await generateFilingAnalysis(sparse, { tier: 'extractive', aux: {} });
    expect(a.degraded).toBe(true);
    expect(a.topTakeaways).toEqual([]);
    expect(a.revenueImpact).toEqual([]);
    expect(a.riskSignals).toEqual([]);
  });

  it('uses sentence-specific titles — never the MD&A section label on every card', async () => {
    const a = await generateFilingAnalysis(richDoc(), { tier: 'extractive', aux });
    expect(a.topTakeaways.length).toBeGreaterThan(1);
    for (const t of a.topTakeaways) {
      expect(t.title).not.toBe("Management's Discussion and Analysis");
      expect(t.title).not.toBe('Risk Factors');
    }
    const titles = a.topTakeaways.map((t) => t.title.toLowerCase());
    expect(new Set(titles).size).toBe(titles.length);
  });

  it('titles are topic labels, not truncated copies of the summary sentence', async () => {
    const a = await generateFilingAnalysis(richDoc(), { tier: 'extractive', aux });
    const cards = [...a.topTakeaways, ...a.revenueImpact, ...a.riskSignals];
    expect(cards.length).toBeGreaterThan(0);
    for (const c of cards) {
      const titleStem = c.title.replace(/…$/, '').replace(/\s+/g, ' ').trim().toLowerCase();
      const summary = c.summary.replace(/\s+/g, ' ').trim().toLowerCase();
      // A real headline labels the topic; it must not be a prefix of the body quote.
      expect(summary.startsWith(titleStem)).toBe(false);
    }
  });

  it('varies Investor view across takeaways (no shared section-sentiment template)', async () => {
    const a = await generateFilingAnalysis(richDoc(), { tier: 'extractive', aux });
    const views = a.topTakeaways.map((t) => t.investorMeaning.trim()).filter(Boolean);
    expect(views.length).toBeGreaterThan(0);
    // No canned "On-device sentiment reads the … language as net-…" template.
    for (const v of views) {
      expect(v).not.toMatch(/^On-device sentiment reads the .+ language as net-/);
    }
    // Non-empty views must be unique across cards.
    expect(new Set(views.map((v) => v.toLowerCase())).size).toBe(views.length);
  });
});
