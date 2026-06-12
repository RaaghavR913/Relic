/**
 * FilingLens — Session 1 section segmentation tests.
 *
 * Covers the item-number segmenter (10-K / 10-Q / 8-K / 20-F), the title-pattern
 * segmenter (S-1 / DEF 14A), and TOC de-duplication.
 */

import { describe, it, expect } from 'vitest';
import { segmentSections } from '@/content/segment';

describe('10-K item segmentation', () => {
  it('segments standard ITEM headers into canonical sections', () => {
    const text = [
      'ITEM 1. BUSINESS',
      'We make widgets and sell them worldwide.',
      '',
      'ITEM 1A. RISK FACTORS',
      'Our business is subject to numerous risks.',
      '',
      'ITEM 7. MANAGEMENT DISCUSSION AND ANALYSIS',
      'Revenue increased year over year.',
    ].join('\n');

    const sections = segmentSections(text, '10-K', []);
    const ids = sections.map(s => s.id);
    expect(ids).toContain('item_1_business');
    expect(ids).toContain('item_1a_risk_factors');
    expect(ids).toContain('item_7_mdna');

    const risk = sections.find(s => s.id === 'item_1a_risk_factors')!;
    expect(risk.text).toContain('subject to numerous risks');
    // charRange must point back into the original text.
    expect(text.slice(risk.charRange[0], risk.charRange[1])).toContain('numerous risks');
  });

  it('de-dupes a table-of-contents cluster, keeping the real section bodies', () => {
    // A dense TOC listing items 1, 1A, 7 up front, then the real headers later.
    const toc = 'ITEM 1. Business 3\nITEM 1A. Risk Factors 12\nITEM 7. MD&A 40\n';
    const filler = 'x'.repeat(50);
    const body =
      'ITEM 1. BUSINESS\n' + filler + ' real business content.\n\n' +
      'ITEM 1A. RISK FACTORS\n' + filler + ' real risk content.\n\n' +
      'ITEM 7. MANAGEMENT DISCUSSION\n' + filler + ' real mdna content.';
    const text = toc + '\n\n' + body;

    const sections = segmentSections(text, '10-K', []);
    const risk = sections.find(s => s.id === 'item_1a_risk_factors')!;
    expect(risk).toBeDefined();
    // The kept header must be the REAL one (its content has the filler body, not "12").
    expect(risk.text).toContain('real risk content');
    expect(risk.charRange[0]).toBeGreaterThan(toc.length);
  });
});

describe('8-K two-level item segmentation', () => {
  it('handles 1.01 / 2.02 / 5.02 style item numbers', () => {
    const text = [
      'ITEM 2.02 RESULTS OF OPERATIONS AND FINANCIAL CONDITION',
      'We reported strong quarterly results.',
      '',
      'ITEM 9.01 FINANCIAL STATEMENTS AND EXHIBITS',
      'See exhibit 99.1.',
    ].join('\n');
    const sections = segmentSections(text, '8-K', []);
    const ids = sections.map(s => s.id);
    expect(ids).toContain('item_2_02_results_of_operations');
    expect(ids).toContain('item_9_01_financial_statements');
  });
});

describe('S-1 title-pattern segmentation', () => {
  it('segments by section titles', () => {
    const text = [
      'PROSPECTUS SUMMARY',
      'We are a leading provider of cloud services.',
      '',
      'RISK FACTORS',
      'Investing in our common stock involves risk.',
      '',
      'USE OF PROCEEDS',
      'We intend to use the net proceeds for working capital.',
    ].join('\n');
    const sections = segmentSections(text, 'S-1', []);
    const ids = sections.map(s => s.id);
    expect(ids).toContain('s1_prospectus_summary');
    expect(ids).toContain('s1_risk_factors');
    expect(ids).toContain('s1_use_of_proceeds');
  });

  it('falls back to a whole-document section when only one title pattern matches', () => {
    // A misdetected S-1 whose only match is the incidental word "Business"
    // (e.g. the BDC data page). Must NOT yield a lone "Business" section pretending
    // the page was parsed as an S-1 — that surfaced as the "1 sections" symptom.
    const text = 'Business Development Company Report\nThis is a data set, not a prospectus.';
    const sections = segmentSections(text, 'S-1', []);
    expect(sections.length).toBe(1);
    expect(sections[0]!.id).toBe('document_body');
  });
});

describe('DEF 14A title-pattern segmentation', () => {
  it('segments proxy statement sections', () => {
    const text = [
      'NOTICE OF ANNUAL MEETING OF STOCKHOLDERS',
      'You are cordially invited.',
      '',
      'PROPOSAL 1: ELECTION OF DIRECTORS',
      'The board recommends a vote FOR each nominee.',
      '',
      'EXECUTIVE COMPENSATION',
      'Our compensation philosophy is pay-for-performance.',
    ].join('\n');
    const sections = segmentSections(text, 'DEF 14A', []);
    const ids = sections.map(s => s.id);
    expect(ids).toContain('proxy_notice');
    expect(ids).toContain('proxy_prop1_election');
    expect(ids).toContain('proxy_exec_compensation');
  });
});

describe('20-F item segmentation', () => {
  it('segments standard top-level 20-F items into canonical sections', () => {
    const text = [
      'ITEM 3. KEY INFORMATION',
      'The following summarizes key information about the company.',
      '',
      'ITEM 4. INFORMATION ON THE COMPANY',
      'We are a global provider of enterprise software.',
      '',
      'ITEM 5. OPERATING AND FINANCIAL REVIEW AND PROSPECTS',
      'Revenue grew 15% year-over-year driven by cloud services.',
      '',
      'ITEM 8. FINANCIAL INFORMATION',
      'See our consolidated financial statements.',
      '',
      'ITEM 15. CONTROLS AND PROCEDURES',
      'Management evaluated disclosure controls as of fiscal year end.',
    ].join('\n');

    const sections = segmentSections(text, '20-F', []);
    const ids = sections.map(s => s.id);
    expect(ids).toContain('20f_item_3_key_information');
    expect(ids).toContain('20f_item_4_company_information');
    expect(ids).toContain('20f_item_5_operating_review');
    expect(ids).toContain('20f_item_8_financial_info');
    expect(ids).toContain('20f_item_15_controls');

    const review = sections.find(s => s.id === '20f_item_5_operating_review')!;
    expect(review).toBeDefined();
    expect(review.text).toContain('Revenue grew 15%');
    expect(text.slice(review.charRange[0], review.charRange[1])).toContain('Revenue grew 15%');
  });

  it('segments dot-letter subitems (3.D risk factors, 5.A/5.B MD&A components)', () => {
    const text = [
      'ITEM 3. KEY INFORMATION',
      'General key information about the company and the offering.',
      '',
      'ITEM 3.D. RISK FACTORS',
      'Investing in our ordinary shares involves significant risk.',
      '',
      'ITEM 5. OPERATING AND FINANCIAL REVIEW AND PROSPECTS',
      'Overview of our operating performance.',
      '',
      'ITEM 5.A. OPERATING RESULTS',
      'Total revenues increased by 12% to $4.2 billion.',
      '',
      'ITEM 5.B. LIQUIDITY AND CAPITAL RESOURCES',
      'We had $1.5 billion in cash and cash equivalents.',
    ].join('\n');

    const sections = segmentSections(text, '20-F', []);
    const ids = sections.map(s => s.id);
    expect(ids).toContain('20f_item_3_key_information');
    expect(ids).toContain('20f_item_3d_risk_factors');
    expect(ids).toContain('20f_item_5_operating_review');
    expect(ids).toContain('20f_item_5a_operating_results');
    expect(ids).toContain('20f_item_5b_liquidity');

    const risk = sections.find(s => s.id === '20f_item_3d_risk_factors')!;
    expect(risk.text).toContain('significant risk');
    expect(text.slice(risk.charRange[0], risk.charRange[1])).toContain('significant risk');
  });

  it('segments Part II items (16A–16K) correctly', () => {
    const text = [
      'ITEM 15. CONTROLS AND PROCEDURES',
      'Our CEO and CFO have evaluated the effectiveness of our disclosure controls.',
      '',
      'ITEM 16A. AUDIT COMMITTEE FINANCIAL EXPERT',
      'Our board has determined that two members qualify as audit committee financial experts.',
      '',
      'ITEM 16G. CORPORATE GOVERNANCE',
      'We comply with NASDAQ corporate governance standards with certain exceptions.',
      '',
      'ITEM 16K. CYBERSECURITY',
      'We have adopted a cybersecurity risk management program.',
    ].join('\n');

    const sections = segmentSections(text, '20-F', []);
    const ids = sections.map(s => s.id);
    expect(ids).toContain('20f_item_15_controls');
    expect(ids).toContain('20f_item_16a_audit_expert');
    expect(ids).toContain('20f_item_16g_governance');
    expect(ids).toContain('20f_item_16k_cybersecurity');
  });

  it('does not produce 20-F sections when segmenting a 10-K (no regression)', () => {
    const text = [
      'ITEM 1. BUSINESS',
      'We make widgets.',
      '',
      'ITEM 1A. RISK FACTORS',
      'Our business faces many risks.',
      '',
      'ITEM 7. MANAGEMENT DISCUSSION AND ANALYSIS',
      'Revenue grew significantly.',
    ].join('\n');

    const sections = segmentSections(text, '10-K', []);
    const ids = sections.map(s => s.id);
    // 10-K sections must be present
    expect(ids).toContain('item_1_business');
    expect(ids).toContain('item_1a_risk_factors');
    expect(ids).toContain('item_7_mdna');
    // No 20-F sections should appear
    expect(ids.every(id => !id.startsWith('20f_'))).toBe(true);
  });

  it('de-dupes a 20-F table-of-contents cluster, keeping the real section bodies', () => {
    const toc = 'ITEM 3. Key Information 5\nITEM 4. Information on the Company 12\nITEM 5. Operating Review 40\n';
    const filler = 'x'.repeat(50);
    const body =
      'ITEM 3. KEY INFORMATION\n' + filler + ' real key info.\n\n' +
      'ITEM 4. INFORMATION ON THE COMPANY\n' + filler + ' real company info.\n\n' +
      'ITEM 5. OPERATING AND FINANCIAL REVIEW\n' + filler + ' real operating review.';
    const text = toc + '\n\n' + body;

    const sections = segmentSections(text, '20-F', []);
    const opReview = sections.find(s => s.id === '20f_item_5_operating_review')!;
    expect(opReview).toBeDefined();
    expect(opReview.text).toContain('real operating review');
    expect(opReview.charRange[0]).toBeGreaterThan(toc.length);
  });
});

describe('fallback segmentation', () => {
  it('returns a single document_body section when no headers match', () => {
    const sections = segmentSections('Just some plain text with no structure.', '10-K', []);
    expect(sections.length).toBe(1);
    expect(sections[0]!.id).toBe('document_body');
  });
});
