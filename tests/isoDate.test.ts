import { describe, it, expect } from 'vitest';
import { toIsoDate } from '../src/lib/date';

// Inline XBRL renders dei:DocumentPeriodEndDate as DISPLAY text ("September 30,
// 2023"), not the ISO value. Downstream code compares periods as ISO strings, so
// an un-normalized value silently produced wrong results — see selectPrior tests.

describe('toIsoDate', () => {
  it('passes ISO values through', () => {
    expect(toIsoDate('2023-09-30')).toBe('2023-09-30');
    expect(toIsoDate('2023-09-30T00:00:00Z')).toBe('2023-09-30');
  });

  it('normalizes the inline-XBRL display form', () => {
    expect(toIsoDate('September 30, 2023')).toBe('2023-09-30');
    expect(toIsoDate('Sept. 27, 2025')).toBe('2025-09-27');
    expect(toIsoDate('Sep 24 2022')).toBe('2022-09-24');
    expect(toIsoDate('December 31, 2024')).toBe('2024-12-31');
    expect(toIsoDate('January 1, 2020')).toBe('2020-01-01');
  });

  it('handles day-first and slash forms', () => {
    expect(toIsoDate('30 September 2023')).toBe('2023-09-30');
    expect(toIsoDate('09/30/2023')).toBe('2023-09-30');
  });

  it('does NOT shift the calendar day (the Date.parse trap)', () => {
    // Date.parse('September 30, 2023') is LOCAL midnight; .toISOString() then
    // reports the previous day in any timezone east of UTC. Ours must not.
    expect(toIsoDate('September 30, 2023')).toBe('2023-09-30');
    expect(toIsoDate('April 26, 2026')).toBe('2026-04-26');
    expect(toIsoDate('January 1, 2021')).toBe('2021-01-01');
  });

  it('returns undefined for unusable input rather than guessing', () => {
    expect(toIsoDate(undefined)).toBeUndefined();
    expect(toIsoDate('')).toBeUndefined();
    expect(toIsoDate('   ')).toBeUndefined();
    expect(toIsoDate('not a date')).toBeUndefined();
    expect(toIsoDate('Smarch 40, 2023')).toBeUndefined();
  });
});
