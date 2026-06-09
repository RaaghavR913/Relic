import { describe, it, expect } from 'vitest';
import { isLowConfidenceGeneric } from '../src/content/ingest/detect';
import type { FilingType } from '../src/types';

function model(host: 'edgar' | 'ir', filingType: FilingType) {
  return { source: { host }, filingType };
}

describe('isLowConfidenceGeneric', () => {
  it('is true for a generic (ir-host) page with no recognized filing type', () => {
    expect(isLowConfidenceGeneric(model('ir', 'UNKNOWN'))).toBe(true);
  });

  it('is false for an IR-hosted page where a real filing type was detected', () => {
    expect(isLowConfidenceGeneric(model('ir', '10-K'))).toBe(false);
    expect(isLowConfidenceGeneric(model('ir', '10-Q'))).toBe(false);
    expect(isLowConfidenceGeneric(model('ir', 'DEF 14A'))).toBe(false);
  });

  it('is false on EDGAR regardless of detected type', () => {
    expect(isLowConfidenceGeneric(model('edgar', 'UNKNOWN'))).toBe(false);
    expect(isLowConfidenceGeneric(model('edgar', '10-K'))).toBe(false);
  });
});
