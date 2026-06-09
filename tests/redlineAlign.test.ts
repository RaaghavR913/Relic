// ============================================================
// FilingLens — Session 6 tests: section alignment
// ============================================================

import { describe, it, expect } from 'vitest';
import { alignSections, focusMatches, DEFAULT_FOCUS_IDS } from '../src/redline/align';
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
