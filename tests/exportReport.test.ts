/**
 * Export pipeline: the pure data helpers (report.ts) and the jsPDF renderer
 * (pdf.ts). The helpers are asserted directly; the renderer is smoke-tested —
 * it must emit a valid multi-page PDF without throwing, including when only some
 * artifacts are cached and when text carries unicode punctuation.
 */

import { describe, it, expect } from 'vitest';
import {
  hasExportableData,
  reportFilename,
  labelText,
  summaryItems,
  aggregateSentiment,
  sentimentConsensus,
  type FilingExportData,
} from '@/export/report';
import { buildFilingReportPdf } from '@/export/pdf';
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

function pdfHeader(data: FilingExportData): { head: string; pages: number; size: number } {
  const pdf = buildFilingReportPdf(data);
  const bytes = new Uint8Array(pdf.output('arraybuffer'));
  return {
    head: String.fromCharCode(...bytes.slice(0, 5)),
    pages: pdf.getNumberOfPages(),
    size: bytes.length,
  };
}

describe('buildFilingReportPdf', () => {
  it('emits a valid, non-trivial PDF from full data', () => {
    const { head, pages, size } = pdfHeader(fullData());
    expect(head).toBe('%PDF-');
    expect(pages).toBeGreaterThanOrEqual(1);
    expect(size).toBeGreaterThan(1500);
  });

  it('renders without throwing when only some artifacts are cached', () => {
    expect(() => buildFilingReportPdf(fullData({ analysis: null, sentiment: null, redline: null }))).not.toThrow();
    expect(() => buildFilingReportPdf(fullData({ summaries: [], sentiment: [], redline: null }))).not.toThrow();
  });

  it('renders unicode punctuation and degraded mode without throwing', () => {
    const data = fullData({
      analysis: analysis({
        degraded: true,
        oneSentenceSummary: 'Risk “smart quotes” — em dash • bullet & ampersand',
      }),
    });
    expect(pdfHeader(data).head).toBe('%PDF-');
  });

  it('handles a no-prior redline status', () => {
    const redline: RedlineEntry = { rawTextHash: 'hash-mu', status: 'no_prior', diffs: [], alignment: [], cachedAt: 1 };
    expect(pdfHeader(fullData({ redline })).head).toBe('%PDF-');
  });
});

describe('hasExportableData', () => {
  it('is true when any artifact exists', () => {
    expect(hasExportableData(fullData())).toBe(true);
    expect(hasExportableData(fullData({ analysis: analysis(), summaries: [], sentiment: null, redline: null }))).toBe(true);
  });

  it('is false when nothing is cached', () => {
    expect(hasExportableData(fullData({ analysis: null, summaries: [], sentiment: null, redline: null }))).toBe(false);
    expect(hasExportableData(fullData({ analysis: null, summaries: [], sentiment: [], redline: null }))).toBe(false);
  });
});

describe('reportFilename', () => {
  it('builds a safe .pdf name from ticker + type + period', () => {
    expect(reportFilename(fullData())).toBe('Relic-MU-10-Q-2026-05-28.pdf');
  });

  it('falls back to company name and strips unsafe characters', () => {
    const { ticker: _ticker, ...rest } = doc();
    const d: DocumentModel = { ...rest, companyName: 'Acme/Co: Inc.' };
    const name = reportFilename({ ...fullData(), doc: d });
    expect(name).toMatch(/^Relic-Acme-Co-Inc\.-10-Q-2026-05-28\.pdf$/);
    expect(name).not.toMatch(/[/:]/);
  });
});

describe('report helpers', () => {
  it('labelText maps the internal Neutral label to Info', () => {
    expect(labelText('Neutral')).toBe('Info');
    expect(labelText('Bullish')).toBe('Bullish');
  });

  it('summaryItems flattens a builtin analyst note into bullets + paragraphs', () => {
    const entry = summaryEntry('s', '- First point\nA closing paragraph.', 'builtin');
    const items = summaryItems(doc().sections[0]!, entry);
    expect(items[0]).toEqual({ bullet: true, text: 'First point' });
    expect(items[1]).toEqual({ bullet: false, text: 'A closing paragraph.' });
  });

  it('summaryItems slices key sentences for the extractive register', () => {
    const sec = section('s', 'S', 0, 'Hello world from a filing.', 0);
    const entry: SummaryEntry = { ...summaryEntry('s', '', 'extractive'), plainAnchors: [[0, 5]] };
    expect(summaryItems(sec, entry)).toEqual([{ bullet: true, text: 'Hello' }]);
  });

  it('aggregateSentiment + sentimentConsensus describe the tone', () => {
    const agg = aggregateSentiment([
      { sectionId: 's', sentenceIdx: 0, label: 'negative', score: 1, range: [0, 1] },
      { sectionId: 's', sentenceIdx: 1, label: 'negative', score: 1, range: [0, 1] },
      { sectionId: 's', sentenceIdx: 2, label: 'positive', score: 1, range: [0, 1] },
    ]);
    expect(agg).toEqual({ positive: 1, negative: 2, neutral: 0, total: 3 });
    expect(sentimentConsensus(agg)).toContain('cautious');
  });
});
