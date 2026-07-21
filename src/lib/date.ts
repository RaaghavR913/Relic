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

const MONTHS: Readonly<Record<string, number>> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
};

function monthNumber(name: string): number | undefined {
  const key = name.toLowerCase().replace(/\.$/, '');
  return MONTHS[key] ?? MONTHS[key.slice(0, 3)];
}

const pad = (n: number) => String(n).padStart(2, '0');

/**
 * Normalize a filing date to date-only ISO (YYYY-MM-DD).
 *
 * Inline-XBRL renders dei:DocumentPeriodEndDate as DISPLAY text — "September 30,
 * 2023" — not the ISO value. Downstream code (prior-filing selection, XBRL
 * period matching) compares these as ISO strings, so a human-readable value
 * silently produces wrong results rather than an error. Normalize at ingest so
 * the model always carries ISO.
 *
 * Deliberately avoids Date.parse: it interprets "September 30, 2023" as LOCAL
 * midnight, and toISOString() then shifts the day backwards in any timezone
 * east of UTC. Parsing the parts directly keeps the calendar date intact.
 *
 * Returns undefined when the value cannot be understood — callers must treat
 * that as "unknown period", never as a comparable value.
 */
export function toIsoDate(value?: string): string | undefined {
  if (!value) return undefined;
  const s = value.trim();
  if (!s) return undefined;

  // Already ISO (possibly with a time component) — take the date part.
  const iso = DATE_ONLY.exec(s);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;

  // "September 30, 2023" / "Sept. 30, 2023" / "Sep 30 2023"
  const mdy = /^([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})$/.exec(s);
  if (mdy) {
    const mo = monthNumber(mdy[1]!);
    const day = Number(mdy[2]);
    if (mo && day >= 1 && day <= 31) return `${mdy[3]}-${pad(mo)}-${pad(day)}`;
  }

  // "30 September 2023"
  const dmy = /^(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})$/.exec(s);
  if (dmy) {
    const mo = monthNumber(dmy[2]!);
    const day = Number(dmy[1]);
    if (mo && day >= 1 && day <= 31) return `${dmy[3]}-${pad(mo)}-${pad(day)}`;
  }

  // "09/30/2023" (US convention on EDGAR cover pages)
  const slash = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
  if (slash) {
    const mo = Number(slash[1]);
    const day = Number(slash[2]);
    if (mo >= 1 && mo <= 12 && day >= 1 && day <= 31) {
      return `${slash[3]}-${pad(mo)}-${pad(day)}`;
    }
  }

  return undefined;
}
