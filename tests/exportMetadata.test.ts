/**
 * Export metadata: the PDF Info dictionary and the XMP sidecar (metadata.ts).
 *
 * These assert a contract an outside reader codes against — Relic Desktop parses
 * `relic:payload` to recover a filing's identity and analysis without re-reading
 * the rendered prose — so the shape, the escaping and the size ceiling are all
 * pinned here, plus an end-to-end check that both layers survive into the actual
 * PDF bytes.
 */

import { describe, it, expect } from 'vitest';
import {
  MAX_SIDECAR_BYTES,
  RELIC_SIDECAR_SCHEMA,
  RELIC_XMP_NS,
  buildInfoProperties,
  buildSidecar,
  buildXmpPacket,
  escapeXml,
  serializeSidecar,
  type RelicSidecar,
} from '@/export/metadata';
import { buildFilingReportPdf } from '@/export/pdf';
import type { FilingExportData } from '@/export/report';
import type { DocumentModel, FilingAnalysis, FilingInsight, Section } from '@/types';

// ── fixtures ─────────────────────────────────────────────────────────────────

const BODY = 'Revenue rose sharply on AI-led memory demand across data center.';

function section(id: string, label: string, order: number, text: string, start: number): Section {
  return { id, label, order, text, charRange: [start, start + text.length] };
}

function doc(over: Partial<DocumentModel> = {}): DocumentModel {
  return {
    source: {
      url: 'https://www.sec.gov/Archives/edgar/data/723125/x-10q.htm',
      host: 'edgar',
      category: 'edgar_filing',
      cik: '0000723125',
      accessionNo: '0000723125-26-000042',
    },
    companyName: 'Micron Technology, Inc.',
    ticker: 'MU',
    filingType: '10-Q',
    filingTypeConfidence: 'high',
    periodOfReport: '2026-05-28',
    filedAt: '2026-07-01',
    sections: [
      section('item_2_mdna', "Management's Discussion", 2, BODY, 0),
      section('item_1a_risk', 'Risk Factors', 1, 'Markets are cyclical & volatile.', 100),
    ],
    rawTextHash: 'hash-mu',
    ...over,
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
    evidence: 'average selling prices increased sequentially',
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
    managementNarrativeCheck: [],
    bullCase: ['Pricing power in DRAM'],
    bearCase: ['Cyclical demand reversal'],
    netRead: 'Leans bullish but cyclicality caps conviction.',
    whatToWatchNext: [],
    stagesDone: ['snapshot'],
    degraded: false,
    generatedAt: 1_700_000_000_000,
    ...over,
  };
}

function data(over: Partial<FilingExportData> = {}): FilingExportData {
  return {
    doc: doc(),
    generatedAt: 1_700_000_000_000,
    appVersion: '3.1.7',
    analysis: analysis(),
    summaries: [],
    sentiment: null,
    redline: null,
    ...over,
  };
}

function parseXml(xml: string): Document {
  return new DOMParser().parseFromString(xml, 'application/xml');
}

/** The `relic:payload` object, straight out of a built packet. */
function payloadOf(d: FilingExportData): RelicSidecar {
  const el = parseXml(buildXmpPacket(d)).getElementsByTagNameNS(RELIC_XMP_NS, 'payload')[0];
  return JSON.parse(el!.textContent!) as RelicSidecar;
}

// ── Info dictionary ──────────────────────────────────────────────────────────

describe('buildInfoProperties', () => {
  it('produces a human title and a machine-parseable keyword list', () => {
    expect(buildInfoProperties(data())).toEqual({
      title: 'Micron Technology, Inc. (MU) - 10-Q - 2026-05-28',
      subject: 'Relic on-device analysis of 10-Q',
      author: 'Relic',
      keywords:
        'relic;ticker=MU;form=10-Q;period=2026-05-28;cik=0000723125;accession=0000723125-26-000042',
      creator: 'Relic v3.1.7',
    });
  });

  it('omits the fields a filing does not carry', () => {
    // Built out rather than overridden: `exactOptionalPropertyTypes` means an
    // absent field and a field set to undefined are not the same thing.
    const bare = data({
      doc: {
        source: { url: 'https://example.com/ir/report.htm', host: 'ir' },
        filingType: '10-Q',
        sections: [],
        rawTextHash: 'hash-bare',
      },
    });
    const info = buildInfoProperties(bare);
    expect(info.title).toBe('Filing - 10-Q');
    expect(info.keywords).toBe('relic;form=10-Q');
  });

  it('folds unicode punctuation, which the Info dictionary cannot encode', () => {
    const info = buildInfoProperties(data({ doc: doc({ companyName: 'Acme — “Holdings”' }) }));
    expect(info.title).toBe('Acme - "Holdings" (MU) - 10-Q - 2026-05-28');
  });
});

// ── payload ──────────────────────────────────────────────────────────────────

describe('buildSidecar', () => {
  it('carries identity, the section index and the full analysis', () => {
    const s = buildSidecar(data());
    expect(s.schema).toBe(RELIC_SIDECAR_SCHEMA);
    expect(s.appVersion).toBe('3.1.7');
    expect(s.doc.ticker).toBe('MU');
    expect(s.doc.source.cik).toBe('0000723125');
    expect(s.doc.rawTextHash).toBe('hash-mu');
    expect(s.doc.sections).toEqual([
      { id: 'item_2_mdna', label: "Management's Discussion", order: 2, charRange: [0, BODY.length], chars: BODY.length },
      { id: 'item_1a_risk', label: 'Risk Factors', order: 1, charRange: [100, 132], chars: 32 },
    ]);
    expect(s.analysis?.overallRead).toBe('Bullish');
    expect(s.analysis?.topTakeaways[0]?.evidence).toBe('average selling prices increased sequentially');
  });

  it('never embeds section text — the PDF already carries the filing once', () => {
    expect(JSON.stringify(buildSidecar(data()))).not.toContain(BODY);
  });

  it('carries deterministic XBRL facts, which no reader can recompute from prose', () => {
    const withXbrl = data({
      doc: doc({
        xbrl: {
          facts: [{ concept: 'us-gaap:Revenues', label: 'Revenue', unit: 'USD', currentValue: 9_300_000_000 }],
          metrics: [],
          periodEnd: '2026-05-28',
          fiscalYearFocus: 2026,
        },
      }),
    });
    expect(buildSidecar(withXbrl).doc.xbrl?.facts[0]?.currentValue).toBe(9_300_000_000);
  });

  it('holds a null analysis when none was cached', () => {
    expect(buildSidecar(data({ analysis: null })).analysis).toBeNull();
  });
});

describe('serializeSidecar', () => {
  it('keeps a normal payload whole', () => {
    const json = serializeSidecar(buildSidecar(data()));
    expect(JSON.parse(json).omitted).toBeUndefined();
    expect(new TextEncoder().encode(json).length).toBeLessThan(MAX_SIDECAR_BYTES);
  });

  it('drops the analysis rather than bloating the PDF, and says so', () => {
    const huge = analysis({ bullCase: ['x'.repeat(MAX_SIDECAR_BYTES + 1)] });
    const json = serializeSidecar(buildSidecar(data({ analysis: huge })));
    const parsed = JSON.parse(json) as RelicSidecar;
    expect(parsed.omitted).toBe('analysis');
    expect(parsed.analysis).toBeNull();
    expect(parsed.doc.ticker).toBe('MU'); // identity always survives
    expect(new TextEncoder().encode(json).length).toBeLessThan(MAX_SIDECAR_BYTES);
  });
});

// ── XMP packet ───────────────────────────────────────────────────────────────

describe('escapeXml', () => {
  it('escapes the five entities', () => {
    expect(escapeXml(`<a href="x" & 'y'>`)).toBe('&lt;a href=&quot;x&quot; &amp; &apos;y&apos;&gt;');
  });
});

describe('buildXmpPacket', () => {
  it('is well-formed XML in Relic’s namespace', () => {
    const xml = buildXmpPacket(data());
    const parsed = parseXml(xml);
    expect(parsed.getElementsByTagName('parsererror')).toHaveLength(0);
    expect(xml.startsWith('<?xpacket begin=')).toBe(true);
    expect(xml.endsWith('<?xpacket end="r"?>')).toBe(true);
    expect(parsed.getElementsByTagNameNS(RELIC_XMP_NS, 'ticker')[0]?.textContent).toBe('MU');
    expect(parsed.getElementsByTagNameNS(RELIC_XMP_NS, 'filing-type')[0]?.textContent).toBe('10-Q');
    expect(parsed.getElementsByTagNameNS(RELIC_XMP_NS, 'overall-read')[0]?.textContent).toBe('Bullish');
    expect(parsed.getElementsByTagNameNS(RELIC_XMP_NS, 'source-url')[0]?.textContent)
      .toBe('https://www.sec.gov/Archives/edgar/data/723125/x-10q.htm');
  });

  it('names every scalar in lowercase, which is how PDF.js hands them back', () => {
    const names = Array.from(buildXmpPacket(data()).matchAll(/<relic:([a-z0-9-]+)>/gi), (m) => m[1]!);
    expect(names.length).toBeGreaterThan(10);
    expect(names.filter((n) => n !== n.toLowerCase())).toEqual([]);
  });

  it('round-trips the payload through one layer of escaping', () => {
    const payload = payloadOf(data());
    expect(payload.schema).toBe(RELIC_SIDECAR_SCHEMA);
    expect(payload.doc.companyName).toBe('Micron Technology, Inc.');
    expect(payload.analysis?.netRead).toBe('Leans bullish but cyclicality caps conviction.');
  });

  it('survives filing text that is hostile to XML, verbatim', () => {
    const hostile = 'Q3 margins <fell> 5% & "compressed" — see ‘note 7’ </relic:payload>';
    const payload = payloadOf(data({ analysis: analysis({ netRead: hostile }) }));
    expect(payload.analysis?.netRead).toBe(hostile);
  });

  it('omits the analysis scalars when no analysis was cached', () => {
    const parsed = parseXml(buildXmpPacket(data({ analysis: null })));
    expect(parsed.getElementsByTagName('parsererror')).toHaveLength(0);
    expect(parsed.getElementsByTagNameNS(RELIC_XMP_NS, 'overall-read')).toHaveLength(0);
    expect(payloadOf(data({ analysis: null })).analysis).toBeNull();
  });
});

// ── end to end, in the real bytes ────────────────────────────────────────────

describe('buildFilingReportPdf metadata', () => {
  const bytes = new Uint8Array(buildFilingReportPdf(data()).output('arraybuffer'));
  const latin1 = new TextDecoder('latin1').decode(bytes);

  it('writes the Info dictionary entries', () => {
    expect(latin1).toContain('/Title (Micron Technology, Inc. \\(MU\\) - 10-Q - 2026-05-28)');
    expect(latin1).toContain('/Author (Relic)');
    expect(latin1).toContain('/Creator (Relic v3.1.7)');
    expect(latin1).toContain('/Keywords (relic;ticker=MU;form=10-Q');
  });

  it('links an XMP metadata stream from the catalog', () => {
    expect(latin1).toMatch(/\/Type \/Metadata\s*\/Subtype \/XML/);
    expect(latin1).toMatch(/\/Metadata \d+ 0 R/);
  });

  it('carries a payload a reader can lift straight out of the file', () => {
    const start = latin1.indexOf('<?xpacket begin=');
    const end = latin1.indexOf('<?xpacket end="r"?>') + '<?xpacket end="r"?>'.length;
    expect(start).toBeGreaterThan(-1);
    const xml = new TextDecoder('utf-8').decode(bytes.slice(start, end));
    const el = parseXml(xml).getElementsByTagNameNS(RELIC_XMP_NS, 'payload')[0];
    const payload = JSON.parse(el!.textContent!) as RelicSidecar;
    expect(payload.doc.ticker).toBe('MU');
    expect(payload.doc.source.accessionNo).toBe('0000723125-26-000042');
    expect(payload.analysis?.riskSignals[0]?.title).toBe('Cyclicality');
  });
});
