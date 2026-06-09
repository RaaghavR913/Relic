// ============================================================
// FilingLens — Session 6 tests: section alignment
// ============================================================

import { describe, it, expect } from 'vitest';
import {
  alignSections,
  focusMatches,
  focusAlignments,
  DEFAULT_FOCUS_IDS,
} from '../src/redline/align';
import { segmentSections } from '../src/content/segment';
import type { Section } from '../src/types';

function sec(id: string, label: string, order: number, text = `${id} text`): Section {
  return { id, label, order, text, charRange: [0, text.length] };
}

describe('alignSections', () => {
  it('matches sections present in both filings by canonical id', () => {
    const current = [
      sec('item_1a_risk_factors', 'Risk Factors', 20),
      sec('item_7_mdna', 'MD&A', 90),
    ];
    const prior = [
      sec('item_1a_risk_factors', 'Risk Factors', 20),
      sec('item_7_mdna', 'MD&A', 90),
    ];
    const aligned = alignSections(current, prior);
    expect(aligned.every((a) => a.status === 'matched')).toBe(true);
    expect(aligned).toHaveLength(2);
    expect(aligned[0]!.current).toBeDefined();
    expect(aligned[0]!.prior).toBeDefined();
  });

  it('flags a section present only this year as added', () => {
    const current = [
      sec('item_1a_risk_factors', 'Risk Factors', 20),
      sec('item_1c_cybersecurity', 'Cybersecurity', 35),
    ];
    const prior = [sec('item_1a_risk_factors', 'Risk Factors', 20)];
    const aligned = alignSections(current, prior);
    const cyber = aligned.find((a) => a.id === 'item_1c_cybersecurity');
    expect(cyber?.status).toBe('added');
    expect(cyber?.prior).toBeUndefined();
  });

  it('flags a section present only last year as removed', () => {
    const current = [sec('item_1a_risk_factors', 'Risk Factors', 20)];
    const prior = [
      sec('item_1a_risk_factors', 'Risk Factors', 20),
      sec('item_6_selected_financial_data', 'Selected Financial Data', 80),
    ];
    const aligned = alignSections(current, prior);
    const removed = aligned.find((a) => a.status === 'removed');
    expect(removed).toBeDefined();
    expect(removed?.label).toContain('Selected Financial Data');
  });

  it('aligns across renumbering via alias groups (Item 7 MD&A ↔ Item 2 MD&A)', () => {
    const current = [sec('item_7_mdna', "Management's Discussion and Analysis", 90)];
    const prior = [sec('item_2_mdna', "Management's Discussion and Analysis", 20)];
    const aligned = alignSections(current, prior);
    expect(aligned).toHaveLength(1);
    expect(aligned[0]!.status).toBe('matched');
  });

  it('focusMatches keeps only the focus sections (any status)', () => {
    const current = [
      sec('item_1_business', 'Business', 10),
      sec('item_1a_risk_factors', 'Risk Factors', 20),
      sec('item_7_mdna', 'MD&A', 90),
    ];
    const prior = [
      sec('item_1_business', 'Business', 10),
      sec('item_1a_risk_factors', 'Risk Factors', 20),
    ];
    const aligned = alignSections(current, prior);
    const focus = focusMatches(aligned, DEFAULT_FOCUS_IDS);
    const ids = focus.map((f) => f.id).sort();
    expect(ids).toContain('item_1a_risk_factors');
    expect(ids).toContain('item_7_mdna');
    expect(ids).not.toContain('item_1_business');
    // MD&A is added (not in prior) but still surfaced by focusMatches.
    expect(focus.find((f) => f.id === 'item_7_mdna')?.status).toBe('added');
  });
});

// ── M1: 20-F Changes-tab coverage ────────────────────────────────────────────

describe('20-F redline focus coverage (M1)', () => {
  // A minimal 20-F that the segmenter (ITEMS_20F) will emit focus sections from.
  const TWENTY_F = [
    'ITEM 3.D. RISK FACTORS',
    'Investing in our ordinary shares involves significant risk.',
    '',
    'ITEM 4. INFORMATION ON THE COMPANY',
    'We are a global provider of enterprise software.',
    '',
    'ITEM 5. OPERATING AND FINANCIAL REVIEW AND PROSPECTS',
    'Revenue grew 15% year-over-year driven by cloud services.',
  ].join('\n');

  it('20-F focus IDs resolve against what the 20-F segmenter actually emits', () => {
    const emittedIds = new Set(segmentSections(TWENTY_F, '20-F', []).map((s) => s.id));
    const twentyFFocus = DEFAULT_FOCUS_IDS.filter((id) => id.startsWith('20f_'));

    // Every 20-F focus id must correspond to a real emitter — otherwise the focus
    // list is dead and the redline is a silent no-op (the original M1 bug).
    expect(twentyFFocus.length).toBeGreaterThan(0);
    for (const id of twentyFFocus) {
      expect(emittedIds.has(id)).toBe(true);
    }
    // The two explicitly-required ids are present.
    expect(twentyFFocus).toContain('20f_item_3d_risk_factors');
    expect(twentyFFocus).toContain('20f_item_5_operating_review');
  });

  it('a 20-F vs prior 20-F yields non-empty focus alignments', () => {
    const sections = segmentSections(TWENTY_F, '20-F', []);
    // Prior year: same sections, slightly different text.
    const prior = segmentSections(
      TWENTY_F.replace('Revenue grew 15%', 'Revenue grew 9%'),
      '20-F',
      [],
    );
    const aligned = alignSections(sections, prior);
    const focus = focusAlignments(aligned);

    expect(focus.length).toBeGreaterThan(0);
    const ids = focus.map((f) => f.id);
    expect(ids).toContain('20f_item_3d_risk_factors');
    expect(ids).toContain('20f_item_5_operating_review');
    // Risk Factors matched across both years (drives the semantic diff).
    expect(focus.find((f) => f.id === '20f_item_3d_risk_factors')?.status).toBe('matched');
  });

  it('aligns a 20-F risk section against a 10-K risk section via the alias group', () => {
    const current = [sec('20f_item_3d_risk_factors', 'Risk Factors', 35)];
    const prior = [sec('item_1a_risk_factors', 'Risk Factors', 20)];
    const aligned = alignSections(current, prior);
    expect(aligned).toHaveLength(1);
    expect(aligned[0]!.status).toBe('matched');
  });
});

// ── M1: unsupported-form guard ───────────────────────────────────────────────

describe('focusAlignments unsupported-form guard (M1)', () => {
  it('returns an empty focus set when no section is a focus id (drives unsupported_form)', () => {
    // A fallback-segmented filing (e.g. a form with no item registry) emits only
    // generic ids. None are focus ids → empty focus set → computeRedline must
    // surface status:'unsupported_form' rather than an empty (misleading) diff.
    const current = [sec('document_body', 'Document', 1)];
    const prior = [sec('document_body', 'Document', 1)];
    const aligned = alignSections(current, prior);
    expect(focusAlignments(aligned)).toHaveLength(0);
  });

  it('returns a non-empty focus set for a covered form (10-K)', () => {
    const current = [
      sec('item_1a_risk_factors', 'Risk Factors', 20),
      sec('item_7_mdna', 'MD&A', 90),
    ];
    const prior = [
      sec('item_1a_risk_factors', 'Risk Factors', 20),
      sec('item_7_mdna', 'MD&A', 90),
    ];
    const aligned = alignSections(current, prior);
    expect(focusAlignments(aligned).length).toBeGreaterThan(0);
  });
});
