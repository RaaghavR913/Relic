import { describe, it, expect } from 'vitest';
import { isLowConfidenceGeneric } from '../src/content/ingest/detect';
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
});
