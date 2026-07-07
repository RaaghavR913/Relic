/**
 * Relic — fiscal-vs-calendar offset detection tests (src/lib/fiscalCalendar.ts).
 *
 * The note must fire for genuinely offset filers (NVIDIA's Q1 FY2027 ends April
 * 2026) via either the XBRL fiscal-year focus or a clearly dominant textual
 * fiscal year — and must stay silent for calendar-aligned filers, ambiguous
 * mention counts, one-off forward guidance, and implausible (±2+) offsets.
 */

import { describe, it, expect } from 'vitest';
import type { DocumentModel, Section, XbrlFundamentals } from '@/types';
import { detectFiscalCalendarOffset } from '@/lib/fiscalCalendar';

function makeDoc(opts: {
  text?: string;
  periodOfReport?: string;
  xbrl?: Partial<XbrlFundamentals>;
}): DocumentModel {
  const text = opts.text ?? 'Revenue increased during the period.';
  const section: Section = {
    id: 'item_2_mdna',
    label: 'Item 2. MD&A',
    order: 0,
    text,
    charRange: [0, text.length],
  };
  return {
    source: { url: 'https://www.sec.gov/Archives/x.htm', host: 'edgar' },
    filingType: '10-Q',
    ...(opts.periodOfReport ? { periodOfReport: opts.periodOfReport } : {}),
    sections: [section],
    ...(opts.xbrl ? { xbrl: { facts: [], metrics: [], ...opts.xbrl } } : {}),
    rawTextHash: 'test-hash',
  };
}

describe('detectFiscalCalendarOffset — XBRL fiscal-year focus', () => {
  it('reports a lead-by-one offset (NVIDIA: FY2027 quarter ended Apr 2026)', () => {
    const doc = makeDoc({ periodOfReport: '2026-04-26', xbrl: { fiscalYearFocus: 2027 } });
    expect(detectFiscalCalendarOffset(doc)).toEqual({
      fiscalYear: 2027,
      calendarYear: 2026,
      periodEnd: '2026-04-26',
    });
  });

  it('returns null when the fiscal year matches the calendar year', () => {
    const doc = makeDoc({ periodOfReport: '2026-12-31', xbrl: { fiscalYearFocus: 2026 } });
    expect(detectFiscalCalendarOffset(doc)).toBeNull();
  });

  it('suppresses implausible offsets of two or more years', () => {
    const doc = makeDoc({ periodOfReport: '2026-04-26', xbrl: { fiscalYearFocus: 2029 } });
    expect(detectFiscalCalendarOffset(doc)).toBeNull();
  });

  it('falls back to xbrl.periodEnd when periodOfReport is absent', () => {
    const doc = makeDoc({ xbrl: { fiscalYearFocus: 2027, periodEnd: '2026-04-26' } });
    expect(detectFiscalCalendarOffset(doc)?.calendarYear).toBe(2026);
  });

  it('returns null when no period end is known at all', () => {
    const doc = makeDoc({ xbrl: { fiscalYearFocus: 2027 } });
    expect(detectFiscalCalendarOffset(doc)).toBeNull();
  });
});

describe('detectFiscalCalendarOffset — text fallback (PDF / non-iXBRL)', () => {
  it('detects a dominant offset fiscal year in the text', () => {
    const doc = makeDoc({
      periodOfReport: '2026-04-26',
      text:
        'Revenue grew in the first quarter of fiscal year 2027. ' +
        'Operating income in fiscal year 2027 rose. ' +
        'Compared with the first quarter of fiscal year 2026, margins in fiscal 2027 expanded.',
    });
    expect(detectFiscalCalendarOffset(doc)).toEqual({
      fiscalYear: 2027,
      calendarYear: 2026,
      periodEnd: '2026-04-26',
    });
  });

  it('stays silent for a calendar-aligned filer with one-off forward guidance', () => {
    const doc = makeDoc({
      periodOfReport: '2026-06-30',
      text:
        'Results for fiscal 2026 were strong. Fiscal 2026 revenue grew. ' +
        'Fiscal year 2026 margins expanded. We expect growth through fiscal 2027.',
    });
    expect(detectFiscalCalendarOffset(doc)).toBeNull();
  });

  it('stays silent when mention counts are ambiguous (dominant < 2× runner-up)', () => {
    const doc = makeDoc({
      periodOfReport: '2026-04-26',
      text:
        'fiscal year 2027 grew. fiscal year 2027 improved. fiscal year 2027 expanded. ' +
        'fiscal year 2026 comparison. fiscal year 2026 baseline.',
    });
    expect(detectFiscalCalendarOffset(doc)).toBeNull();
  });

  it('requires at least 3 mentions of the dominant year', () => {
    const doc = makeDoc({
      periodOfReport: '2026-04-26',
      text: 'Revenue rose in fiscal year 2027. Fiscal 2027 was strong.',
    });
    expect(detectFiscalCalendarOffset(doc)).toBeNull();
  });

  it('prefers the XBRL focus over the text scan when both are present', () => {
    const doc = makeDoc({
      periodOfReport: '2026-04-26',
      xbrl: { fiscalYearFocus: 2027 },
      text: 'fiscal 2025 fiscal 2025 fiscal 2025 fiscal 2025', // misleading text
    });
    expect(detectFiscalCalendarOffset(doc)?.fiscalYear).toBe(2027);
  });
});
