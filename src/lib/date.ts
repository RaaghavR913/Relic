// ============================================================
// Relic — timezone-safe calendar-date formatting (shared)
// ------------------------------------------------------------
// Filing dates (period end, prior period end, filed date) are date-ONLY ISO
// strings like "2026-04-26". `new Date("2026-04-26")` parses that as UTC
// midnight, so `toLocaleDateString` in any timezone WEST of UTC renders the
// PREVIOUS calendar day — e.g. NVIDIA's quarter ending Apr 26, 2026 shows as
// "April 25, 2026" in US Pacific. These are pure calendar dates with no time
// component, so we parse the Y-M-D parts and build a LOCAL date, preserving the
// intended day in every timezone.
// ============================================================

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})/;

/** Parse a date-only (or date-prefixed) ISO string as a LOCAL calendar date. */
function parseCalendarDate(iso: string): Date | null {
  const m = DATE_ONLY.exec(iso);
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Format a calendar date for display without timezone drift. Returns '' for an
 * empty input and echoes the raw string back if it can't be parsed.
 */
export function fmtCalendarDate(iso?: string, month: 'long' | 'short' = 'long'): string {
  if (!iso) return '';
  const d = parseCalendarDate(iso);
  if (!d) return iso;
  return d.toLocaleDateString(undefined, { year: 'numeric', month, day: 'numeric' });
}
