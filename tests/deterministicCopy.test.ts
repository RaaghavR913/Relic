/**
 * Session E1 — deterministic-tier copy variety.
 *
 * The extractive Analyst tier used to title every card by its section label and
 * repeat one canned "Investor view" line. These tests pin the replacement:
 *   • the lead card of a dimension is titled by its exact XBRL fact;
 *   • cards without a fact fall back to a numeric phrase, then the section label;
 *   • no two visible cards share an identical "Investor view" line.
 */

import { describe, it, expect } from 'vitest';
import { deterministicAnalysis, numericPhraseTitle } from '@/analyst/deterministic';
import type { DocumentModel, LanguageFlag } from '@/types';

const MDNA = [
  'Total revenue increased 12% to $94.9 billion, driven by strong demand across our core markets.',
  'Gross margin expanded to 44% from 41% as supply chain costs normalized during the year.',
  'Operating cash flow declined to $110 billion as working capital rose during the year.',
  'Operating expenses grew as we increased research and development expense for next-generation products.',
  'We repurchased $5 billion of common stock and shares outstanding decreased over the period.',
].join(' ');

const RISK = [
  'Litigation and regulatory actions could materially harm our business and reputation.',
  'We face intense competition that could pressure our pricing and our margins.',
  'New tariffs and trade regulations could adversely affect our results in future periods.',
].join(' ');

function makeDoc(): DocumentModel {
  return {
    source: { url: 'https://www.sec.gov/Archives/x.htm', host: 'edgar' },
    companyName: 'Example Corp',
    ticker: 'EXMP',
    filingType: '10-K',
    periodOfReport: '2025-12-31',
    sections: [
      { id: 'item_7_mdna', label: "Management's Discussion and Analysis", order: 90,
        text: MDNA, charRange: [0, MDNA.length] },
      { id: 'item_1a_risk_factors', label: 'Risk Factors', order: 20,
        text: RISK, charRange: [MDNA.length + 1, MDNA.length + 1 + RISK.length] },
    ],
    xbrl: {
      periodEnd: '2025-12-31',
      priorPeriodEnd: '2024-12-31',
      facts: [
        { concept: 'us-gaap:Revenues', label: 'Revenue', unit: 'USD',
          currentValue: 94_900_000_000, priorValue: 84_100_000_000, yoyPct: 0.128 },
        { concept: 'us-gaap:OperatingIncomeLoss', label: 'Operating income', unit: 'USD',
          currentValue: 30_000_000_000, priorValue: 28_000_000_000, yoyPct: 0.0714 },
        { concept: 'us-gaap:NetCashProvidedByUsedInOperatingActivities', label: 'Operating cash flow',
          unit: 'USD', currentValue: 110_000_000_000, priorValue: 122_000_000_000, yoyPct: -0.0984 },
      ],
      metrics: [],
    },
    rawTextHash: 'copy-test-hash',
  };
}

// Four non-boilerplate cautionary flags in the risk section (drives the flag-density
// "Investor view" line; below the 8-flag threshold so no separate density card).
const RISK_FLAGS: LanguageFlag[] = [
  { type: 'litigious', range: [0, 10], sectionId: 'item_1a_risk_factors', term: 'Litigation', note: '' },
  { type: 'litigious', range: [15, 25], sectionId: 'item_1a_risk_factors', term: 'regulatory', note: '' },
  { type: 'uncertainty', range: [30, 40], sectionId: 'item_1a_risk_factors', term: 'could', note: '' },
  { type: 'negative', range: [45, 55], sectionId: 'item_1a_risk_factors', term: 'harm', note: '' },
];

describe('numericPhraseTitle', () => {
  it('pulls the first figure-bearing clause and keeps decimals intact', () => {
    expect(numericPhraseTitle('Total revenue increased 12% to $94.9 billion, driven by strong demand.'))
      .toBe('Total revenue increased 12% to $94.9 billion');
  });

  it('capitalizes a lowercase lead', () => {
    expect(numericPhraseTitle('we grew revenue 12% this year')).toBe('We grew revenue 12% this year');
  });

  it('returns null when the sentence carries no figure', () => {
    expect(numericPhraseTitle('We remain committed to our strategy and our people.')).toBeNull();
  });
});

describe('deterministicAnalysis — card copy variety', () => {
  const analysis = deterministicAnalysis(makeDoc(), { flags: RISK_FLAGS });

  it('titles the lead revenue card by its exact XBRL fact', () => {
    expect(analysis.revenueImpact[0]?.title).toBe('Revenue +12.8% YoY to $94.90B');
  });

  it('titles the lead operating-cash-flow card with a negative YoY delta', () => {
    expect(analysis.cashFlowImpact[0]?.title).toBe('Operating cash flow -9.8% YoY to $110.00B');
  });

  it('falls back to the section label for a risk card with no fact or figure', () => {
    expect(analysis.riskSignals.some((c) => c.title === 'Risk Factors')).toBe(true);
  });

  it('never repeats an "Investor view" line across the whole panel', () => {
    const meanings = [
      ...analysis.topTakeaways, ...analysis.whatChanged, ...analysis.revenueImpact,
      ...analysis.marginImpact, ...analysis.cashFlowImpact, ...analysis.balanceSheetHealth,
      ...analysis.shareImpact, ...analysis.riskSignals,
    ].map((c) => c.investorMeaning).filter(Boolean);
    expect(new Set(meanings).size).toBe(meanings.length);
  });

  it('grounds a revenue "Investor view" line in the XBRL delta, not canned prose', () => {
    // The line lands on whichever revenue card renders first (a takeaway here); the
    // dedup pass blanks the duplicate on the revenueImpact card. Search all cards.
    const allLines = [
      ...analysis.topTakeaways, ...analysis.revenueImpact, ...analysis.marginImpact,
      ...analysis.cashFlowImpact, ...analysis.shareImpact,
    ].map((c) => c.investorMeaning);
    const revLine = allLines.find((l) => /Revenue moved higher year over year/.test(l));
    expect(revLine).toBeDefined();
    expect(revLine).toContain("filing's own XBRL");
  });
});
