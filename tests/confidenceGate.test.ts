import { describe, it, expect } from 'vitest';
import { isLowConfidenceGeneric, isEdgarExhibit } from '../src/content/ingest/detect';
import type { FilingType, PageCategory } from '../src/types';

function model(
  host: 'edgar' | 'ir',
  filingType: FilingType,
  sectionCount = 20,
  category?: PageCategory,
) {
  return {
    source: { host, ...(category ? { category } : {}) },
    filingType,
    sections: new Array(sectionCount).fill(null),
  };
}

describe('isLowConfidenceGeneric', () => {
  it('is true for a generic (ir-host) page with no recognized filing type', () => {
    expect(isLowConfidenceGeneric(model('ir', 'UNKNOWN', 20, 'ir_or_financial'))).toBe(true);
    expect(isLowConfidenceGeneric(model('ir', 'UNKNOWN', 1, 'ir_or_financial'))).toBe(true);
  });

  it('is true when a form is claimed but the page never segmented into items', () => {
    // e.g. a press release that merely mentions "Form 10-K" → 1 fallback section.
    expect(isLowConfidenceGeneric(model('ir', '10-K', 1, 'ir_or_financial'))).toBe(true);
    expect(isLowConfidenceGeneric(model('ir', '10-Q', 0, 'ir_or_financial'))).toBe(true);
  });

  it('is false for an off-EDGAR filing that actually segmented into many items', () => {
    expect(isLowConfidenceGeneric(model('ir', '10-K', 23, 'ir_or_financial'))).toBe(false);
    expect(isLowConfidenceGeneric(model('ir', 'DEF 14A', 8, 'ir_or_financial'))).toBe(false);
  });

  it('is false for an authoritative EDGAR filing regardless of type/section count', () => {
    expect(isLowConfidenceGeneric(model('edgar', 'UNKNOWN', 1, 'edgar_filing'))).toBe(false);
    expect(isLowConfidenceGeneric(model('edgar', '10-K', 23, 'edgar_ixbrl'))).toBe(false);
  });

  it('is false for a SEC DATA_REPORT page — it is an intentional readable doc, not a misdetection', () => {
    // The BDC data page: correctly classified, must NOT show the "doesn't look like
    // a filing" warning (which previously could not happen because all sec.gov was
    // trusted, and now must not happen for the right reason).
    expect(isLowConfidenceGeneric(model('edgar', 'DATA_REPORT', 1, 'sec_data_report'))).toBe(false);
    expect(isLowConfidenceGeneric(model('edgar', 'DATA_REPORT', 5, 'sec_data_report'))).toBe(false);
  });

  it('back-compat: pre-category persisted models still trust the edgar host', () => {
    expect(isLowConfidenceGeneric(model('edgar', 'UNKNOWN', 1))).toBe(false);
    expect(isLowConfidenceGeneric(model('ir', 'UNKNOWN', 1))).toBe(true);
  });

  it('is false for an EDGAR index page — it gets its own dedicated banner (no double warning)', () => {
    // A Filing Detail / accession index page (e.g. a Form 3 index) detects as
    // UNKNOWN with 1 section, but must NOT also trip the low-confidence warning.
    expect(isLowConfidenceGeneric(model('edgar', 'UNKNOWN', 1, 'edgar_index'))).toBe(false);
  });
});

describe('isEdgarExhibit', () => {
  it('is true for an EDGAR filing-category doc that never classified or segmented', () => {
    // The real case: IBM EX-21 subsidiaries exhibit — category edgar_filing,
    // UNKNOWN type, 1 fallback section. isLowConfidenceGeneric trusts it (line 36
    // above), so this is the predicate that routes it to Summary-only + banner.
    expect(isEdgarExhibit(model('edgar', 'UNKNOWN', 1, 'edgar_filing'))).toBe(true);
    expect(isEdgarExhibit(model('edgar', 'UNKNOWN', 0, 'edgar_ixbrl'))).toBe(true);
  });

  it('is false for a real EDGAR filing that segmented into many items', () => {
    // The main 10-K (filingType 10-K, 23 sections) must keep its investor tabs.
    expect(isEdgarExhibit(model('edgar', '10-K', 23, 'edgar_filing'))).toBe(false);
    expect(isEdgarExhibit(model('edgar', '10-Q', 12, 'edgar_ixbrl'))).toBe(false);
  });

  it('is false for a recognized form that merely failed to segment (not an exhibit)', () => {
    // A 10-K detected by URL but collapsed to 1 section is a parse miss, not an
    // exhibit — keep it on the investor path (AnalystPanel gates it to deterministic).
    expect(isEdgarExhibit(model('edgar', '10-K', 1, 'edgar_filing'))).toBe(false);
  });

  it('is false for non-EDGAR-filing categories (index, data report, off-EDGAR)', () => {
    expect(isEdgarExhibit(model('edgar', 'UNKNOWN', 1, 'edgar_index'))).toBe(false);
    expect(isEdgarExhibit(model('edgar', 'DATA_REPORT', 1, 'sec_data_report'))).toBe(false);
    expect(isEdgarExhibit(model('ir', 'UNKNOWN', 1, 'ir_or_financial'))).toBe(false);
  });

  it('is false for null and pre-category persisted models (no category to trust)', () => {
    expect(isEdgarExhibit(null)).toBe(false);
    expect(isEdgarExhibit(model('edgar', 'UNKNOWN', 1))).toBe(false);
  });
});
