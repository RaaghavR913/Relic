/**
 * FilingLens — Analyst pipeline tests.
 *
 * Covers the investor-analysis pipeline without a real Chrome Prompt API:
 * the LM factory seam returns canned JSON per stage (dispatched off the
 * `TASK: <stage>` header in each prompt).
 *
 * Invariants verified:
 *   1. Builtin tier assembles a FilingAnalysis across stages, in order.
 *   2. Evidence quotes are verified against source text: real quotes get a
 *      DOCUMENT-space evidenceRange; fabricated quotes are dropped and the
 *      insight confidence downgrades to 'Low'.
 *   3. Direct investment advice is scrubbed from model output.
 *   4. whatChanged comes from the redline engine (deterministic), not the LM.
 *   5. Extractive tier produces a degraded analysis with zero LM calls.
 *   6. A stage that returns invalid JSON fails soft — later stages still run.
 */

import { describe, it, expect, vi } from 'vitest';
import type { DocumentModel, Section, SectionDiff } from '@/types';
import {
  generateFilingAnalysis,
  type AnalystLMFactory,
  type AnalystLMSession,
} from '@/analyst/pipeline';
import type { RedlineEntry } from '@/redline/redlineStore';

// ── fixtures ──────────────────────────────────────────────────────────────────

function makeDoc(): DocumentModel {
  const mdnaText = [
    'Total revenue increased 15% to $4.2 billion for fiscal 2025, driven primarily by higher unit volume in the data-center segment.',
    'Revenue growth in the consumer segment decelerated to 3% as average selling prices declined during the second half of the year.',
    'Gross margin contracted to 41% from 46% in the prior year, reflecting elevated input costs and underutilization charges.',
    'Operating expenses grew 22%, outpacing revenue growth, as the company increased research and development expense for next-generation products.',
    'Net income declined to $310 million from $520 million in the prior year period.',
    'Cash flow from operating activities was $890 million, while capital expenditures of $1.1 billion resulted in negative free cash flow for the year.',
    'Cash and cash equivalents totaled $2.4 billion at year end, and total debt was $3.8 billion under the revolving credit facility and senior notes.',
    'Interest expense increased to $190 million, and the nearest debt maturities occur in fiscal 2027.',
    'The company repurchased $200 million of common stock and shares outstanding decreased 1% year over year.',
    'Stock-based compensation expense was $450 million, creating ongoing dilution pressure for shareholders.',
    'We believe demand remains strong across our core markets and we expect revenue growth to reaccelerate next year.',
    'We remain confident in our strategy and believe we are well-positioned to expand margins over the long term.',
  ].join(' ');

  const riskText = [
    'Our revenue is concentrated among a small number of customers, and the loss of any significant customer could materially reduce revenue.',
    'We face intense competition from larger competitors with greater resources, which could pressure pricing and margins.',
    'Pending litigation regarding patent infringement claims could result in material legal liability and unfavorable judgments.',
    'New tariffs and trade regulations could increase our input costs and adversely affect gross margin in future periods.',
  ].join(' ');

  const sections: Section[] = [];
  let offset = 0;
  for (const [id, label, text] of [
    ['item_7_mdna', 'Item 7. MD&A', mdnaText],
    ['item_1a_risk', 'Item 1A. Risk Factors', riskText],
  ] as const) {
    sections.push({
      id, label, order: sections.length, text,
      charRange: [offset, offset + text.length],
    });
    offset += text.length + 1;
  }

  return {
    source: { url: 'https://www.sec.gov/Archives/x.htm', host: 'edgar' },
    companyName: 'Example Corp',
    ticker: 'EXMP',
    filingType: '10-K',
    periodOfReport: '2025-12-31',
    sections,
    rawTextHash: 'test-hash',
  };
}

function makeRedline(): RedlineEntry {
  const diff: SectionDiff = {
    sectionId: 'item_1a_risk',
    added: [{ text: 'New tariff risk added.', range: [0, 20] }],
    removed: [],
    summary: '3 new sentences added; risk language strengthened around tariffs.',
    magnitude: 0.3,
  };
  return {
    rawTextHash: 'test-hash',
    status: 'computed',
    diffs: [diff],
    alignment: [],
    cachedAt: Date.now(),
  };
}

// Canned per-stage model output. The evidence on the first takeaway is a real
// quote from the MD&A; the evidence on the revenue insight is fabricated.
const REAL_QUOTE = 'Gross margin contracted to 41% from 46% in the prior year';
const STAGE_RESPONSES: Record<string, string> = {
  snapshot: JSON.stringify({
    documentType: '10-K',
    overallRead: 'Mixed',
    confidence: 'Medium',
    oneSentenceSummary: 'Revenue grew 15% but margins compressed sharply, so growth is not translating into profit.',
    mainFinancialTheme: 'Growth without operating leverage',
    timeHorizon: 'Medium-term',
    mostImportantInvestorQuestion: 'Can the company restore margins while sustaining growth?',
  }),
  takeaways: JSON.stringify([
    {
      label: 'Mixed', category: 'Margins',
      title: 'Margins compressed despite revenue growth',
      summary: 'Gross margin fell five points while revenue grew 15%. You should sell the stock immediately.',
      whyItMatters: 'Profitability did not scale with growth.',
      investorMeaning: 'This may weigh on investor sentiment because operating leverage is absent.',
      evidence: REAL_QUOTE,
      severity: 'Medium', timeHorizon: 'Medium-term', confidence: 'High',
    },
  ]),
  revenue: JSON.stringify([
    {
      label: 'Bullish', category: 'Revenue',
      title: 'Data-center demand drives growth',
      summary: 'Revenue rose 15% on data-center volume.',
      whyItMatters: 'Volume-driven growth is higher quality than price-driven growth.',
      investorMeaning: 'May be viewed positively by investors because the growth engine is intact.',
      evidence: 'Quarterly revenue reached $99 trillion according to management.',
      severity: 'Low', timeHorizon: 'Short-term', confidence: 'High',
    },
  ]),
  margins: JSON.stringify([
    {
      label: 'Bearish', category: 'Margins',
      title: 'Structural margin pressure',
      summary: 'Opex grew faster than revenue and gross margin fell.',
      whyItMatters: 'Indicates negative operating leverage.',
      investorMeaning: 'Could pressure shares if the trend persists.',
      severity: 'High', timeHorizon: 'Medium-term', confidence: 'Medium',
    },
  ]),
  cashflow: JSON.stringify([
    {
      label: 'Weakness Signal', category: 'Cash Flow',
      title: 'Negative free cash flow',
      summary: 'Capex of $1.1B exceeded operating cash flow of $890M.',
      whyItMatters: 'The strategy currently consumes cash.',
      investorMeaning: 'Liquidity is adequate today but bears watching.',
      severity: 'Medium', timeHorizon: 'Medium-term', confidence: 'High',
    },
    {
      label: 'Neutral', category: 'Balance Sheet',
      title: 'Manageable debt maturities',
      summary: 'Total debt of $3.8B with nearest maturities in fiscal 2027.',
      whyItMatters: 'No near-term refinancing wall.',
      investorMeaning: 'Balance sheet risk appears contained near term.',
      severity: 'Low', timeHorizon: 'Long-term', confidence: 'Medium',
    },
  ]),
  shares: JSON.stringify([]),
  risks: JSON.stringify([
    {
      label: 'Red Flag', category: 'Risk',
      title: 'Worsened: customer concentration',
      summary: 'Revenue remains concentrated among few customers.',
      whyItMatters: 'A single loss could materially reduce revenue.',
      investorMeaning: 'Concentration amplifies downside scenarios.',
      severity: 'High', timeHorizon: 'Near-term', confidence: 'Medium',
    },
  ]),
  narrative: JSON.stringify([
    {
      claim: 'Demand remains strong across our core markets.',
      evidence: 'Revenue grew, but consumer segment decelerated and ASPs declined.',
      assessment: 'Partially Supported',
      investorMeaning: 'Headline demand claims mask segment-level softness.',
    },
  ]),
  synthesis: JSON.stringify({
    bullCase: ['Revenue growth of 15% with intact data-center demand.'],
    bearCase: ['Five points of gross margin compression.', 'Negative free cash flow.'],
    netRead: 'The document leans mixed-to-cautious: growth is real but profitability is moving the wrong way.',
    whatToWatchNext: [
      { item: 'Gross margin recovery', whyItMatters: 'Confirms whether pressure is temporary or structural.', relatedMetric: 'Gross margin %' },
    ],
    plainEnglishExplanation: 'The company is selling more but keeping less of each dollar. That is why this report reads mixed.',
    scores: {
      revenueStrength: 4, marginQuality: 2, cashFlowQuality: 2, balanceSheetStrength: 3,
      riskLevel: 4, managementCredibility: 3, shareholderFriendliness: 3,
    },
  }),
};

function makeFactory(
  overrides: Partial<Record<string, string>> = {},
): { factory: AnalystLMFactory; calls: string[] } {
  const calls: string[] = [];
  const factory: AnalystLMFactory = async () => {
    const session: AnalystLMSession = {
      prompt: vi.fn().mockImplementation(async (text: string) => {
        const stage = /^TASK: (\w+)/.exec(text)?.[1] ?? 'unknown';
        calls.push(stage);
        const resp = overrides[stage] ?? STAGE_RESPONSES[stage];
        if (resp === undefined) throw new Error(`no canned response for ${stage}`);
        return resp;
      }),
      destroy: vi.fn(),
    };
    return session;
  };
  return { factory, calls };
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe('generateFilingAnalysis — builtin tier', () => {
  it('assembles the analysis across stages in order', async () => {
    const { factory, calls } = makeFactory();
    const stages: string[] = [];
    const analysis = await generateFilingAnalysis(makeDoc(), {
      tier: 'builtin',
      aux: { redline: makeRedline() },
      lmFactory: factory,
      onStage: (s) => stages.push(s),
    });

    expect(analysis.degraded).toBe(false);
    expect(analysis.overallRead).toBe('Mixed');
    expect(analysis.documentType).toBe('10-K');
    expect(analysis.investorSnapshot.mostImportantInvestorQuestion).toMatch(/restore margins/);
    expect(analysis.topTakeaways).toHaveLength(1);
    expect(analysis.marginImpact[0]?.label).toBe('Bearish');
    expect(analysis.cashFlowImpact).toHaveLength(1);
    expect(analysis.balanceSheetHealth).toHaveLength(1);
    expect(analysis.riskSignals[0]?.severity).toBe('High');
    expect(analysis.managementNarrativeCheck[0]?.assessment).toBe('Partially Supported');
    expect(analysis.bullCase.length).toBeGreaterThan(0);
    expect(analysis.bearCase.length).toBeGreaterThan(0);
    expect(analysis.netRead).toMatch(/mixed/i);
    expect(analysis.scores?.riskLevel).toBe(4);
    expect(analysis.plainEnglishExplanation.length).toBeGreaterThan(0);

    // LM stage order (whatChanged is deterministic — never an LM call).
    expect(calls).toEqual([
      'snapshot', 'takeaways', 'revenue', 'margins', 'cashflow', 'shares', 'risks', 'narrative', 'synthesis',
    ]);
    expect(stages).toContain('whatChanged');
    expect(analysis.stagesDone).toContain('synthesis');
  });

  it('verifies real evidence (DOCUMENT-space range) and drops fabricated quotes', async () => {
    const { factory } = makeFactory();
    const doc = makeDoc();
    const analysis = await generateFilingAnalysis(doc, {
      tier: 'builtin', lmFactory: factory,
    });

    // Real quote → kept, with a document-space range pointing into MD&A.
    const takeaway = analysis.topTakeaways[0]!;
    expect(takeaway.evidence).toBe(REAL_QUOTE);
    expect(takeaway.evidenceRange).toBeDefined();
    const [start, end] = takeaway.evidenceRange!;
    const mdna = doc.sections[0]!;
    expect(doc.sections.map((s) => s.text).join(' ').length).toBeGreaterThan(0);
    expect(mdna.text.slice(start - mdna.charRange[0], end - mdna.charRange[0])).toBe(REAL_QUOTE);

    // Fabricated quote → evidence dropped, confidence downgraded.
    const revenue = analysis.revenueImpact[0]!;
    expect(revenue.evidence).toBeUndefined();
    expect(revenue.evidenceRange).toBeUndefined();
    expect(revenue.confidence).toBe('Low');
  });

  it('scrubs direct investment advice from model output', async () => {
    const { factory } = makeFactory();
    const analysis = await generateFilingAnalysis(makeDoc(), {
      tier: 'builtin', lmFactory: factory,
    });
    const takeaway = analysis.topTakeaways[0]!;
    expect(takeaway.summary).not.toMatch(/sell the stock/i);
    expect(takeaway.summary).toMatch(/Gross margin fell/);
    // Careful analyst language passes through untouched.
    expect(takeaway.investorMeaning).toMatch(/may weigh on investor sentiment/);
    // "selling more" in plain English is not advice and survives.
    expect(analysis.plainEnglishExplanation).toMatch(/selling more/);
  });

  it('builds whatChanged from the redline engine', async () => {
    const { factory } = makeFactory();
    const analysis = await generateFilingAnalysis(makeDoc(), {
      tier: 'builtin',
      aux: { redline: makeRedline() },
      lmFactory: factory,
    });
    expect(analysis.whatChanged).toHaveLength(1);
    const change = analysis.whatChanged[0]!;
    expect(change.label).toBe('Watch Item'); // magnitude 0.3 ≥ 0.25
    expect(change.category).toBe('Risk');
    expect(change.summary).toMatch(/tariffs/);
    expect(change.confidence).toBe('High');
  });

  it('fails soft when a stage returns invalid JSON', async () => {
    const { factory, calls } = makeFactory({ takeaways: 'not json at all' });
    const analysis = await generateFilingAnalysis(makeDoc(), {
      tier: 'builtin', lmFactory: factory,
    });
    expect(analysis.topTakeaways).toHaveLength(0);
    expect(analysis.stagesDone).not.toContain('takeaways');
    // Later stages still ran.
    expect(calls).toContain('risks');
    expect(analysis.riskSignals.length).toBeGreaterThan(0);
  });

  it('skips dimension stages on sparse documents (no relevant text)', async () => {
    const { factory, calls } = makeFactory();
    const doc = makeDoc();
    // A Form-4-like doc: one short section with no investor-dimension keywords.
    const sparse: DocumentModel = {
      ...doc,
      filingType: 'UNKNOWN',
      sections: [{
        id: 'document', label: 'Document', order: 0,
        text: 'Statement of changes in beneficial ownership. Signature of reporting person provided herein.',
        charRange: [0, 93],
      }],
    };
    const analysis = await generateFilingAnalysis(sparse, {
      tier: 'builtin', lmFactory: factory,
    });
    // Snapshot/takeaways still attempted (overview text exists), but no
    // dimension stage had ≥200 relevant chars, so none called the LM.
    expect(calls).not.toContain('revenue');
    expect(calls).not.toContain('cashflow');
    expect(analysis.revenueImpact).toHaveLength(0);
    // Stages are still marked done so the UI can render "Not enough information".
    expect(analysis.stagesDone).toContain('revenue');
  });
});

describe('generateFilingAnalysis — extractive tier', () => {
  it('produces a degraded deterministic analysis with zero LM calls', async () => {
    const { factory, calls } = makeFactory();
    const analysis = await generateFilingAnalysis(makeDoc(), {
      tier: 'extractive',
      aux: { redline: makeRedline() },
      lmFactory: factory,
    });
    expect(calls).toHaveLength(0);
    expect(analysis.degraded).toBe(true);
    expect(analysis.confidence).toBe('Low');
    expect(analysis.whatChanged).toHaveLength(1); // redline still works without LM
    // The deterministic tier now synthesizes real cards from on-device signals
    // (no LM): takeaways come from the document's highest-signal sentences.
    expect(analysis.topTakeaways.length).toBeGreaterThan(0);
    expect(analysis.documentType).toBe('10-K');
  });
});
