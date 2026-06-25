/**
 * Export report builder.
 *
 * buildFilingReportHtml is a pure renderer over the artifacts gathered from the
 * on-device caches. These tests pin that it emits a complete self-contained HTML
 * document, includes each available analysis surface, HTML-escapes all dynamic
 * text (filing prose can contain <, >, &), and that the data-presence and
 * filename helpers behave.
 */

import { describe, it, expect } from 'vitest';
import {
  buildFilingReportHtml,
  hasExportableData,
  reportFilename,
  type FilingExportData,
} from '@/export/report';
import type {
  DocumentModel,
  FilingAnalysis,
  FilingInsight,
  Section,
  SentenceSentiment,
} from '@/types';
import type { SummaryEntry } from '@/summarizer/summaryStore';
import type { RedlineEntry } from '@/redline/redlineStore';

function section(id: string, label: string, order: number, text: string, start: number): Section {
  return { id, label, order, text, charRange: [start, start + text.length] };
}

function doc(): DocumentModel {
  return {
    source: { url: 'https://www.sec.gov/Archives/edgar/data/1/x-10q.htm', host: 'edgar', category: 'edgar_filing' },
    companyName: 'Micron Technology, Inc.',
    ticker: 'MU',
    filingType: '10-Q',
    periodOfReport: '2026-05-28',
    sections: [
      section('item_2_mdna', "Management's Discussion", 2, 'Revenue rose sharply on AI demand.', 0),
      section('item_1a_risk', 'Risk Factors', 1, 'Markets are cyclical & volatile.', 100),
    ],
    rawTextHash: 'hash-mu',
  };
}

function insight(over: Partial<FilingInsight> = {}): FilingInsight {
  return {
    label: 'Bullish',
    category: 'Revenue',
    title: 'Revenue accelerated',
    summary: 'Revenue grew on strong demand.',
    whyItMatters: 'Signals durable top-line momentum.',
    investorMeaning: 'Supports a constructive thesis.',
    severity: 'Medium',
    timeHorizon: 'Short-term',
    confidence: 'High',
    ...over,
  };
}

function analysis(over: Partial<FilingAnalysis> = {}): FilingAnalysis {
  return {
    documentType: '10-Q',
    overallRead: 'Bullish',
    confidence: 'High',
    oneSentenceSummary: 'A strong quarter driven by AI-led memory demand.',
    investorSnapshot: {
      mainFinancialTheme: 'Memory upcycle',
      timeHorizon: 'Short-term',
      mostImportantInvestorQuestion: 'Can pricing strength persist?',
    },
    topTakeaways: [insight()],
    whatChanged: [],
    revenueImpact: [insight()],
    marginImpact: [],
    cashFlowImpact: [],
    balanceSheetHealth: [],
    shareImpact: [],
    riskSignals: [insight({ label: 'Red Flag', category: 'Risk', title: 'Cyclicality' })],
    managementNarrativeCheck: [
      { claim: 'Demand is broad-based', evidence: 'Data center led growth.', assessment: 'Supported', investorMeaning: 'Lower concentration risk.' },
    ],
    bullCase: ['Pricing power in DRAM'],
    bearCase: ['Cyclical demand reversal'],
    netRead: 'Leans bullish but cyclicality caps conviction.',
    whatToWatchNext: [{ item: 'Next-quarter pricing', whyItMatters: 'Drives margins', relatedMetric: 'ASP' }],
    scores: {
      revenueStrength: 5, marginQuality: 4, cashFlowQuality: 4, balanceSheetStrength: 4,
      riskLevel: 3, managementCredibility: 4, shareholderFriendliness: 3,
    },
    stagesDone: ['snapshot', 'takeaways', 'synthesis'],
    degraded: false,
    generatedAt: 1_700_000_000_000,
    ...over,
  };
}

function summaryEntry(sectionId: string, analyst: string, register = 'builtin'): SummaryEntry {
  return {
    key: `hash-mu:${sectionId}:${register}`,
    rawTextHash: 'hash-mu',
    sectionId,
    register,
    plain: analyst,
    analyst,
    plainAnchors: [[0, 10]],
    cachedAt: 1,
  };
}

function fullData(over: Partial<FilingExportData> = {}): FilingExportData {
  const d = doc();
  const sentiment: SentenceSentiment[] = [
    { sectionId: 'item_2_mdna', sentenceIdx: 0, label: 'positive', score: 0.9, range: [0, 5] },
    { sectionId: 'item_1a_risk', sentenceIdx: 0, label: 'negative', score: 0.8, range: [0, 5] },
  ];
  const redline: RedlineEntry = {
    rawTextHash: 'hash-mu',
    status: 'computed',
    diffs: [{ sectionId: 'item_1a_risk', added: [{ text: 'New supply-chain risk added.', range: [0, 10] }], removed: [], summary: 'Risk section expanded.', magnitude: 0.2 }],
    alignment: [{ id: 'item_1a_risk', label: 'Risk Factors', status: 'matched' }],
    prior: { form: '10-Q', reportDate: '2025-05-29', filingDate: '2025-07-01', url: 'https://sec.gov/prior', accessionNo: '000-1' },
    cachedAt: 1,
  };
  return {
    doc: d,
    generatedAt: 1_700_000_000_000,
    appVersion: '1.2.7',
    analysis: analysis(),
    summaries: [{ section: d.sections[1]!, entry: summaryEntry('item_1a_risk', 'Risk factors remain cyclical.') }],
    sentiment,
    redline,
    ...over,
  };
}

describe('buildFilingReportHtml', () => {
  it('emits a complete, self-contained HTML document', () => {
    const html = buildFilingReportHtml(fullData());
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('<style>'); // CSS is inlined (no external assets)
    expect(html).not.toContain('http://'); // no remote scripts/styles pulled in
    expect(html).toContain('Micron Technology, Inc.');
    expect(html).toContain('MU');
  });

  it('includes every cached analysis surface', () => {
    const html = buildFilingReportHtml(fullData());
    expect(html).toContain('Investor snapshot');
    expect(html).toContain('A strong quarter driven by AI-led memory demand.');
    expect(html).toContain('Top investor takeaways');
    expect(html).toContain('Risk signals');
    expect(html).toContain('Management narrative check');
    expect(html).toContain('Bull case vs bear case');
    expect(html).toContain('What to watch next');
    expect(html).toContain('Section summaries');
    expect(html).toContain('Risk factors remain cyclical.');
    expect(html).toContain('Sentiment analysis');
    expect(html).toContain('Year-over-year changes');
    expect(html).toContain('New supply-chain risk added.');
  });

  it('HTML-escapes dynamic text to prevent broken/injected markup', () => {
    const data = fullData({
      analysis: analysis({ oneSentenceSummary: 'Risk <script>alert(1)</script> & danger' }),
    });
    const html = buildFilingReportHtml(data);
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt; &amp; danger');
  });

  it('renders gracefully when only some artifacts are cached', () => {
    const data = fullData({ analysis: null, sentiment: null, redline: null });
    const html = buildFilingReportHtml(data);
    expect(html).toContain('No investor analysis is cached');
    expect(html).toContain('Section summaries'); // the one present surface still renders
    expect(html).not.toContain('Sentiment analysis');
    expect(html).not.toContain('Year-over-year changes');
  });

  it('notes extractive (degraded) mode', () => {
    const data = fullData({ analysis: analysis({ degraded: true }) });
    expect(buildFilingReportHtml(data)).toContain('extractive mode');
  });
});

describe('hasExportableData', () => {
  it('is true when any artifact exists', () => {
    expect(hasExportableData(fullData())).toBe(true);
    expect(hasExportableData(fullData({ analysis: analysis(), summaries: [], sentiment: null, redline: null }))).toBe(true);
  });

  it('is false when nothing is cached', () => {
    expect(
      hasExportableData(fullData({ analysis: null, summaries: [], sentiment: null, redline: null })),
    ).toBe(false);
    expect(
      hasExportableData(fullData({ analysis: null, summaries: [], sentiment: [], redline: null })),
    ).toBe(false);
  });
});

describe('reportFilename', () => {
  it('builds a safe, descriptive name from ticker + type + period', () => {
    expect(reportFilename(fullData())).toBe('Disclora-MU-10-Q-2026-05-28.html');
  });

  it('falls back to company name and strips unsafe characters', () => {
    const { ticker: _ticker, ...rest } = doc();
    const d: DocumentModel = { ...rest, companyName: 'Acme/Co: Inc.' };
    const name = reportFilename({ ...fullData(), doc: d });
    expect(name).toMatch(/^Disclora-Acme-Co-Inc\.-10-Q-2026-05-28\.html$/);
    expect(name).not.toMatch(/[/:]/);
  });
});
