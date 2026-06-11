import { describe, it, expect } from 'vitest';
import { isLowConfidenceGeneric } from '../src/content/ingest/detect';
import type { FilingType } from '../src/types';

function model(host: 'edgar' | 'ir', filingType: FilingType, sectionCount = 20) {
  return { source: { host }, filingType, sections: new Array(sectionCount).fill(null) };
}

describe('isLowConfidenceGeneric', () => {
  it('is true for a generic (ir-host) page with no recognized filing type', () => {
    expect(isLowConfidenceGeneric(model('ir', 'UNKNOWN'))).toBe(true);
    expect(isLowConfidenceGeneric(model('ir', 'UNKNOWN', 1))).toBe(true);
  });

  it('is true when a form is claimed but the page never segmented into items', () => {
    // e.g. a press release that merely mentions "Form 10-K" → 1 fallback section.
    expect(isLowConfidenceGeneric(model('ir', '10-K', 1))).toBe(true);
    expect(isLowConfidenceGeneric(model('ir', '10-Q', 0))).toBe(true);
  });

  it('is false for an off-EDGAR filing that actually segmented into many items', () => {
    expect(isLowConfidenceGeneric(model('ir', '10-K', 23))).toBe(false);
    expect(isLowConfidenceGeneric(model('ir', 'DEF 14A', 8))).toBe(false);
  });

  it('is false on EDGAR regardless of detected type or section count', () => {
    expect(isLowConfidenceGeneric(model('edgar', 'UNKNOWN', 1))).toBe(false);
    expect(isLowConfidenceGeneric(model('edgar', '10-K', 23))).toBe(false);
  });
});
