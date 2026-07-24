/**
 * General-financial middle tier (non-SEC pages that are NOT filings).
 *
 * Pins the three contracts:
 *   1. Heading-fallback ingestion — an off-SEC financial page whose form
 *      segmentation collapses gets report_* sections rebuilt from DOM headings,
 *      marked sectionSource: 'headings'.
 *   2. Honesty — the marker keeps isLowConfidenceGeneric true (a press release
 *      mentioning "Form 10-K" never masquerades as a filing), the analysis
 *      labels it 'Other', and LM prompts frame it as a web page.
 *   3. Inertness — EDGAR pages and off-SEC pages that parse as real filings
 *      are byte-identically unaffected.
 */

import { describe, it, expect } from 'vitest';
import { ingestDocument } from '@/content/ingest';
import { isLowConfidenceGeneric, isGeneralFinancialDoc } from '@/content/ingest/detect';
import { buildStagePrompt } from '@/analyst/prompts';
import { documentTypeFor, deterministicAnalysis } from '@/analyst/deterministic';
import type { AnalysisStage, DocumentModel } from '@/types';

function docFrom(html: string): Document {
  return new DOMParser().parseFromString(html, 'text/html');
}

const PROSE =
  'Revenue for the quarter increased 12% to $1.2 billion on strong demand. ' +
  'Management expects continued momentum into the second half of the year. ';

/** An IR press release: headings + financial prose, no filing item headers. */
const IR_RELEASE_HTML = `<!doctype html><html><head><title>Acme Reports Q3 Results</title></head><body>
  <h1>Acme Reports Third Quarter Results</h1>
  <p>${PROSE}</p>
  <h2>Financial Results</h2>
  <p>${PROSE.repeat(3)}</p>
  <h2>Business Outlook</h2>
  <p>${PROSE.repeat(2)}</p>
  <h2>Dividend Declaration</h2>
  <p>The board declared a quarterly dividend of $0.24 per share.</p>
</body></html>`;

/** Same release, but it references "Annual Report on Form 10-K" — the classic
 *  text-heuristic false positive. */
const IR_RELEASE_MENTIONS_10K = IR_RELEASE_HTML.replace(
  '<h2>Financial Results</h2>',
  '<p>Further detail appears in the Annual Report on Form 10-K.</p><h2>Financial Results</h2>',
);

const IR_URL = 'https://ir.example.com/news/q3-results';
const EDGAR_URL = 'https://www.sec.gov/Archives/edgar/data/123456/000012345624000001/acme.htm';

// ── heading-fallback ingestion ────────────────────────────────────────────────

describe('ingestDocument — heading fallback for ir_or_financial', () => {
  it('rebuilds sections from DOM headings when form segmentation collapses', () => {
    const { model } = ingestDocument({ document: docFrom(IR_RELEASE_HTML), url: IR_URL });
    expect(model.source.category).toBe('ir_or_financial');
    expect(model.sectionSource).toBe('headings');
    expect(model.sections.length).toBeGreaterThan(1);
    expect(model.sections.every((s) => /^report_\d+_/.test(s.id))).toBe(true);
    expect(model.sections.map((s) => s.label)).toContain('Financial Results');
  });

  it('stays a low-confidence non-filing despite the multi-section rebuild', () => {
    const { model } = ingestDocument({ document: docFrom(IR_RELEASE_HTML), url: IR_URL });
    expect(isLowConfidenceGeneric(model)).toBe(true);
    expect(isGeneralFinancialDoc(model)).toBe(true);
  });

  it('a "Form 10-K" mention never converts the release into a trusted filing', () => {
    const { model } = ingestDocument({ document: docFrom(IR_RELEASE_MENTIONS_10K), url: IR_URL });
    // The text heuristic may claim 10-K — the marker must keep it demoted anyway.
    expect(model.sectionSource).toBe('headings');
    expect(isLowConfidenceGeneric(model)).toBe(true);
    expect(isGeneralFinancialDoc(model)).toBe(true);
    // And the analysis label must never repeat the false form claim.
    expect(documentTypeFor(model)).toBe('Other');
  });

  it('NEVER applies the heading fallback on an EDGAR page (inertness)', () => {
    const { model } = ingestDocument({ document: docFrom(IR_RELEASE_HTML), url: EDGAR_URL });
    expect(model.source.category).toBe('edgar_filing');
    expect(model.sectionSource).toBeUndefined();
    expect(model.sections.length).toBe(1);
    expect(model.sections[0]!.id).toBe('document_body');
    expect(isGeneralFinancialDoc(model)).toBe(false);
  });

  it('an off-SEC page with real ITEM headers keeps the form path (inertness)', () => {
    const html = `<!doctype html><html><body>
      <h1>ANNUAL REPORT ON FORM 10-K</h1>
      <h2>ITEM 1. BUSINESS</h2><p>${PROSE.repeat(3)}</p>
      <h2>ITEM 1A. RISK FACTORS</h2><p>${PROSE.repeat(3)}</p>
      <h2>ITEM 7. MANAGEMENT&rsquo;S DISCUSSION AND ANALYSIS</h2><p>${PROSE.repeat(3)}</p>
    </body></html>`;
    const { model } = ingestDocument({ document: docFrom(html), url: IR_URL });
    expect(model.filingType).toBe('10-K');
    expect(model.sectionSource).toBeUndefined();
    expect(model.sections.some((s) => s.id === 'item_1a_risk_factors')).toBe(true);
    expect(isGeneralFinancialDoc(model)).toBe(false);
  });
});

// ── LM prompt honesty ─────────────────────────────────────────────────────────

const ALL_STAGES: AnalysisStage[] = [
  'snapshot', 'takeaways', 'whatChanged', 'revenue', 'margins',
  'cashflow', 'shares', 'risks', 'narrative', 'synthesis',
];

function generalDoc(): DocumentModel {
  return {
    source: { url: IR_URL, host: 'ir', category: 'ir_or_financial' },
    companyName: 'Acme Industries, Inc.',
    filingType: '10-K', // false text-heuristic claim
    sections: [{ id: 'document_body', label: 'Document', order: 1, text: PROSE, charRange: [0, PROSE.length] }],
    rawTextHash: 'hash-general',
  };
}

function edgarDoc(): DocumentModel {
  return {
    source: { url: EDGAR_URL, host: 'edgar', category: 'edgar_filing' },
    companyName: 'Acme Industries, Inc.',
    filingType: '10-K',
    sections: new Array(12).fill(null).map((_, i) => ({
      id: `item_${i}`, label: `Item ${i}`, order: i, text: PROSE, charRange: [0, PROSE.length] as [number, number],
    })),
    rawTextHash: 'hash-edgar',
  };
}

describe('buildStagePrompt — general financial pages', () => {
  it('frames the document as a web page and drops the unreliable form claim', () => {
    for (const stage of ALL_STAGES) {
      const p = buildStagePrompt(stage, generalDoc(), 'Excerpts.');
      expect(p).toContain('Document: general financial web page');
      expect(p).toContain('NOT an SEC filing');
      expect(p).not.toContain('Filing type (detected)');
    }
  });

  it('leaves EDGAR filing prompts untouched (inertness)', () => {
    for (const stage of ALL_STAGES) {
      const p = buildStagePrompt(stage, edgarDoc(), 'Excerpts.');
      expect(p).toContain('Filing type (detected): 10-K');
      expect(p).not.toContain('general financial web page');
    }
  });
});

// ── deterministic labeling ────────────────────────────────────────────────────

describe('deterministic analysis on general financial pages', () => {
  it("labels the snapshot 'Other' and phrases the one-liner as a financial document", () => {
    const a = deterministicAnalysis(generalDoc(), {});
    expect(a.documentType).toBe('Other');
    expect(a.oneSentenceSummary).toContain('financial document');
    expect(a.oneSentenceSummary).not.toContain("'s Other");
  });

  it('keeps real filing labels for EDGAR docs (inertness)', () => {
    expect(documentTypeFor(edgarDoc())).toBe('10-K');
    const a = deterministicAnalysis(edgarDoc(), {});
    expect(a.documentType).toBe('10-K');
  });
});
