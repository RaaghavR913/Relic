/**
 * Real-EDGAR segmentation validation (Session 2 hardening).
 *
 * Unlike the synthetic cases in segmentation.test.ts, these run the segmenter over
 * the NORMALIZED TEXT of real SEC primary documents — the exact input the segmenter
 * sees in production. The normalized text was produced once, offline, by running the
 * real positionMap (buildPositionMap, under jsdom) over each filing's HTML; storing
 * the text rather than the multi-megabyte HTML keeps the repo small and the test fast
 * (pure regex segmentation, no DOM). To refresh a fixture, re-run buildPositionMap on
 * the source URL below and overwrite the .normalized.txt file.
 *
 * These fixtures exist to catch the failure this hardening fixed — a header repeated
 * on a line mis-bounding a load-bearing section — on the messy structure of real
 * filings (front TOCs, dense item-reference lists, cross-references). The Apple 10-Q
 * is the key regression guard: its Item 2 (MD&A) and Part II Item 1A (Risk Factors)
 * must bind to the real bodies, which the previous keep-last de-dup got wrong.
 *
 * ── INCORPORATION BY REFERENCE (JPMorgan 10-K, AstraZeneca 20-F) ──
 * Large/foreign issuers incorporate their MD&A / operating review BY REFERENCE: the
 * formal "Item 7" / "Item 5" header is a short pointer and the real narrative lives
 * in an exhibit or an un-numbered block. The segmenter (which keys off item headers)
 * therefore under-bounds those sections. As of S2 we DETECT this (the pointer section
 * is flagged `incorporatedByReference`) so the UI can note it and the analyst skips
 * the pointer text instead of presenting it as the MD&A — but we do NOT recover the
 * narrative (it may live in a separate exhibit file). The assertions below pin both
 * the still-short bounds AND the detection flag. Business and Risk Factors bind
 * correctly, so the document stays high-confidence rather than hiding all analysis.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FilingType } from '@/types';
import { segmentSections, assessSegmentationConfidence } from '@/content/segment';

const DIR = join(process.cwd(), 'fixtures', 'edgar');

interface EdgarFixture {
  name: string;
  file: string;
  type: FilingType;
  /** Provenance — re-fetch from here to refresh. */
  source: string;
}

const FIXTURES: EdgarFixture[] = [
  {
    name: 'Apple 8-K',
    file: 'aapl_8k.normalized.txt',
    type: '8-K',
    source: 'sec.gov/Archives/edgar/data/320193/000032019326000011/aapl-20260430.htm (filed 2026-04-30)',
  },
  {
    name: 'Apple 10-Q',
    file: 'aapl_10q.normalized.txt',
    type: '10-Q',
    source: 'sec.gov/Archives/edgar/data/320193/000032019326000013/aapl-20260328.htm (filed 2026-05-01)',
  },
  {
    name: 'JPMorgan 10-K (bank, long risk factors)',
    file: 'jpm_10k.normalized.txt',
    type: '10-K',
    source: 'sec.gov/Archives/edgar/data/19617/000162828026008131/jpm-20251231.htm (filed 2026-02-13)',
  },
  {
    name: 'AstraZeneca 20-F (foreign issuer)',
    file: 'azn_20f.normalized.txt',
    type: '20-F',
    source: 'sec.gov/Archives/edgar/data/901832/000110465926019130/azn-20251231x20f.htm (filed 2026-02-24)',
  },
];

function sectionsFor(fx: EdgarFixture) {
  const text = readFileSync(join(DIR, fx.file), 'utf8');
  return { text, sections: segmentSections(text, fx.type, []) };
}

const byId = (secs: ReturnType<typeof sectionsFor>['sections'], id: string) =>
  secs.find((s) => s.id === id);

describe('real-EDGAR segmentation', () => {
  // Every fixture must segment into multiple bounded sections without throwing.
  for (const fx of FIXTURES) {
    it(`${fx.name}: segments into multiple sections`, () => {
      const { text, sections } = sectionsFor(fx);
      expect(sections.length).toBeGreaterThan(1);
      // charRanges must be valid offsets into the source text (some sections,
      // e.g. a "Reserved" item, are legitimately empty — bounds still hold).
      for (const s of sections) {
        expect(s.charRange[0]).toBeGreaterThanOrEqual(0);
        expect(s.charRange[1]).toBeLessThanOrEqual(text.length);
        expect(s.charRange[1]).toBeGreaterThanOrEqual(s.charRange[0]);
      }
    });
  }

  it('Apple 8-K: bounds the disclosed item blocks', () => {
    const { sections } = sectionsFor(FIXTURES[0]!);
    expect(byId(sections, 'item_2_02_results_of_operations')).toBeDefined();
    expect(byId(sections, 'item_9_01_financial_statements')).toBeDefined();
    expect(assessSegmentationConfidence(sections, '8-K')).toBe('high');
  });

  it('Apple 10-Q: MD&A and Risk Factors bind to the REAL bodies (keep-first regression guard)', () => {
    const { sections } = sectionsFor(FIXTURES[1]!);
    const mdna = byId(sections, 'item_2_mdna');
    const risk = byId(sections, 'part_ii_item_1a_risk_factors');

    // Item 2 must be the Part I MD&A, not the Part II "Item 2" (Unregistered Sales)
    // that the old keep-last de-dup would have selected.
    expect(mdna).toBeDefined();
    expect(mdna!.text.length).toBeGreaterThan(5000);
    expect(mdna!.text).toMatch(/discussion and analysis|results of operations/i);

    expect(risk).toBeDefined();
    expect(risk!.text.length).toBeGreaterThan(5000);

    expect(assessSegmentationConfidence(sections, '10-Q')).toBe('high');
  });

  it('JPMorgan 10-K: Business and Risk Factors bind correctly', () => {
    const { sections } = sectionsFor(FIXTURES[2]!);
    const business = byId(sections, 'item_1_business');
    const risk = byId(sections, 'item_1a_risk_factors');

    expect(business).toBeDefined();
    expect(business!.text.length).toBeGreaterThan(10_000);

    expect(risk).toBeDefined();
    expect(risk!.text.length).toBeGreaterThan(50_000); // bank risk factors run very long
    expect(risk!.text).toMatch(/risk/i);

    // Key sections bound → document stays high-confidence (one under-bound section
    // must not hide all investor analysis for an otherwise well-segmented filing).
    expect(assessSegmentationConfidence(sections, '10-K')).toBe('high');

    // MD&A is incorporated by reference → Item 7 is a short pointer. We do not
    // recover the narrative, but we DETECT and flag it so the UI can note it.
    const mdna = byId(sections, 'item_7_mdna');
    expect(mdna).toBeDefined();
    expect(mdna!.text.length).toBeLessThan(1_000);
    expect(mdna!.incorporatedByReference).toBe(true);
  });

  it('AstraZeneca 20-F: Key Information and Company Information bind correctly', () => {
    const { sections } = sectionsFor(FIXTURES[3]!);
    const keyInfo = byId(sections, '20f_item_3_key_information');
    const company = byId(sections, '20f_item_4_company_information');

    expect(keyInfo).toBeDefined();
    expect(keyInfo!.text.length).toBeGreaterThan(10_000);

    expect(company).toBeDefined();
    expect(company!.text.length).toBeGreaterThan(10_000);

    expect(assessSegmentationConfidence(sections, '20-F')).toBe('high');

    // The Operating & Financial Review (20-F MD&A equivalent) is incorporated by
    // reference (Exhibit 15.1) → Item 5 is a short pointer. Detected and flagged.
    const opReview = byId(sections, '20f_item_5_operating_review');
    expect(opReview).toBeDefined();
    expect(opReview!.text.length).toBeLessThan(8_000);
    expect(opReview!.incorporatedByReference).toBe(true);
  });
});
