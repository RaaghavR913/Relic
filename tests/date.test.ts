/**
 * Calendar-date formatting must be timezone-safe: filing period-end dates are
 * date-only ISO strings, and the naive `new Date("2026-04-26")` path renders the
 * previous day in any timezone west of UTC (e.g. "April 25, 2026" in US Pacific).
 */

import { describe, it, expect } from 'vitest';
import { fmtCalendarDate } from '@/lib/date';

describe('fmtCalendarDate', () => {
  it('preserves the calendar day regardless of timezone', () => {
    // Built from the same local Y-M-D parts, so the assertion holds under any
    // runtime timezone/locale — and fails for the old UTC-midnight parsing.
    const expectedLong = new Date(2026, 3, 26).toLocaleDateString(undefined, {
      year: 'numeric', month: 'long', day: 'numeric',
    });
    expect(fmtCalendarDate('2026-04-26', 'long')).toBe(expectedLong);
    // NVIDIA Q1 FY2027 ended Apr 26 — never the day before.
    expect(fmtCalendarDate('2026-04-26', 'long')).toContain('26');
    expect(fmtCalendarDate('2026-04-26', 'long')).not.toContain('25');
  });

  it('honours the requested month style', () => {
    const short = new Date(2025, 3, 27).toLocaleDateString(undefined, {
      year: 'numeric', month: 'short', day: 'numeric',
    });
    expect(fmtCalendarDate('2025-04-27', 'short')).toBe(short);
  });

  it('tolerates a date-prefixed timestamp', () => {
    const expected = new Date(2026, 3, 26).toLocaleDateString(undefined, {
      year: 'numeric', month: 'long', day: 'numeric',
    });
    expect(fmtCalendarDate('2026-04-26T00:00:00Z', 'long')).toBe(expected);
  });

  it('returns empty for missing input and echoes an unparseable string', () => {
    expect(fmtCalendarDate(undefined)).toBe('');
    expect(fmtCalendarDate('')).toBe('');
    expect(fmtCalendarDate('not-a-date')).toBe('not-a-date');
  });
});
