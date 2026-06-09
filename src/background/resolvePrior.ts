// ============================================================
// FilingLens — Prior comparable filing resolver (Session 6)
// ------------------------------------------------------------
// Given a CIK, filing type, and period-of-report, find the most recent EARLIER
// filing of the same form via the EDGAR submissions JSON
// (https://data.sec.gov/submissions/CIK##########.json), and build the URL of
// its primary document.
//
// Pure-ish: the network call is injected via `fetchText` so this is unit-testable
// without touching the real queue or network. The service worker supplies a
// closure over fetchEdgarText + the shared RateLimitedQueue.
// ============================================================

export interface PriorFilingLocator {
  cik: string;            // zero-padded 10-digit
  accessionNo: string;    // dashed, e.g. 0000320193-22-000108
  primaryDocument: string;
  form: string;
  reportDate: string;     // periodOfReport, ISO date
  filingDate: string;     // ISO date
  url: string;            // full https Archives URL of the primary document
  companyName?: string;
}

/** Zero-pad a CIK to the 10-digit form EDGAR submissions URLs require. */
export function padCik(cik: string | number): string {
  const digits = String(cik).replace(/\D/g, '');
  return digits.padStart(10, '0');
}

export function submissionsUrl(cik: string | number): string {
  return `https://data.sec.gov/submissions/CIK${padCik(cik)}.json`;
}

/**
 * Build the URL of an older-filings continuation file referenced by
 * `filings.files[].name` (e.g. "CIK0000320193-submissions-001.json"). These live
 * under the same submissions/ path as the primary CIK json.
 */
export function continuationUrl(name: string): string {
  return `https://data.sec.gov/submissions/${name}`;
}

/**
 * Build the primary-document URL for a filing.
 * Accession folders drop the dashes; the data path uses the unpadded CIK.
 */
export function buildArchiveUrl(cik: string | number, accessionNo: string, primaryDocument: string): string {
  const cikInt = String(parseInt(String(cik).replace(/\D/g, ''), 10));
  const accNoDashless = accessionNo.replace(/-/g, '');
  return `https://www.sec.gov/Archives/edgar/data/${cikInt}/${accNoDashless}/${primaryDocument}`;
}

interface RecentFilings {
  accessionNumber?: string[];
  filingDate?: string[];
  reportDate?: string[];
  form?: string[];
  primaryDocument?: string[];
}

/** Reference to an older-filings continuation file (filings.files[i]). */
interface FilesEntry {
  name?: string;
}

interface SubmissionsJson {
  name?: string;
  cik?: string;
  filings?: { recent?: RecentFilings; files?: FilesEntry[] };
}

interface FilingEntry {
  accessionNo: string;
  filingDate: string;
  reportDate: string;
  form: string;
  primaryDocument: string;
}

/** Flatten the column-oriented `filings.recent` arrays into row objects. */
function rowsOf(recent: RecentFilings): FilingEntry[] {
  const n = recent.accessionNumber?.length ?? 0;
  const rows: FilingEntry[] = [];
  for (let i = 0; i < n; i++) {
    rows.push({
      accessionNo: recent.accessionNumber?.[i] ?? '',
      filingDate: recent.filingDate?.[i] ?? '',
      reportDate: recent.reportDate?.[i] ?? '',
      form: recent.form?.[i] ?? '',
      primaryDocument: recent.primaryDocument?.[i] ?? '',
    });
  }
  return rows;
}

export interface ResolveDeps {
  /** Fetch the submissions JSON text for a URL (rate-limited in production). */
  fetchText: (url: string) => Promise<string>;
}

/**
 * From a set of filing rows, pick the prior comparable for (filingType,
 * periodOfReport). Returns undefined when no earlier same-form filing exists.
 * See `resolvePriorFiling` for the selection semantics.
 */
function selectPrior(
  rows: FilingEntry[],
  filingType: string,
  periodOfReport: string | undefined,
): FilingEntry | undefined {
  const sameForm = rows
    .filter((r) => r.form === filingType && r.accessionNo && r.primaryDocument)
    .sort((a, b) => (a.reportDate < b.reportDate ? 1 : a.reportDate > b.reportDate ? -1 : 0));

  if (sameForm.length === 0) return undefined;

  if (periodOfReport) {
    const target = periodOfReport.slice(0, 10);
    // Most recent entry strictly earlier than the current period.
    const prior = sameForm.find((r) => r.reportDate && r.reportDate.slice(0, 10) < target);
    if (prior) return prior;
    // Current filing present in the list → take the one right after it.
    const idx = sameForm.findIndex((r) => r.reportDate.slice(0, 10) === target);
    if (idx >= 0 && idx + 1 < sameForm.length) return sameForm[idx + 1];
    return undefined;
  }

  // No period info: index 0 is the latest (assumed current), index 1 is prior.
  return sameForm[1];
}

/**
 * Find the prior comparable filing for (cik, filingType, periodOfReport).
 * Returns null when no earlier filing of the same form exists.
 *
 * Selection:
 *   - Keep entries whose form EXACTLY equals filingType (amendments like 10-K/A
 *     are excluded — they are not standalone comparables).
 *   - Sort by reportDate descending.
 *   - If periodOfReport is known, pick the entry with the largest reportDate
 *     STRICTLY earlier than it. Falling back, if the current filing itself is in
 *     the list, take the entry immediately after it.
 *   - If periodOfReport is unknown, assume index 0 is the current filing and
 *     return index 1.
 */
export async function resolvePriorFiling(
  cik: string | number,
  filingType: string,
  periodOfReport: string | undefined,
  deps: ResolveDeps,
): Promise<PriorFilingLocator | null> {
  const json = await deps.fetchText(submissionsUrl(cik));
  let data: SubmissionsJson;
  try {
    data = JSON.parse(json) as SubmissionsJson;
  } catch {
    throw new Error('Could not parse EDGAR submissions JSON');
  }

  const recent = data.filings?.recent;
  if (!recent) return null;

  const recentRows = rowsOf(recent);
  let prior = selectPrior(recentRows, filingType, periodOfReport);

  // `filings.recent` only holds the most recent ~1000 filings. For a company
  // whose target-type filings have aged out of `recent`, fall back to the first
  // older-filings continuation file (`filings.files[0]`) and re-run the
  // selection over the combined set. The continuation fetch goes through the same
  // injected `fetchText` — i.e. the shared RateLimitedQueue + cache (invariant #1).
  if (!prior) {
    const contName = data.filings?.files?.[0]?.name;
    if (contName) {
      let contRows: FilingEntry[] = [];
      try {
        const contJson = await deps.fetchText(continuationUrl(contName));
        contRows = rowsOf(JSON.parse(contJson) as RecentFilings);
      } catch {
        // Continuation unavailable/unparseable — fall through with recent only.
      }
      if (contRows.length > 0) {
        prior = selectPrior([...recentRows, ...contRows], filingType, periodOfReport);
      }
    }
  }

  if (!prior) return null;

  const result: PriorFilingLocator = {
    cik: padCik(cik),
    accessionNo: prior.accessionNo,
    primaryDocument: prior.primaryDocument,
    form: prior.form,
    reportDate: prior.reportDate,
    filingDate: prior.filingDate,
    url: buildArchiveUrl(cik, prior.accessionNo, prior.primaryDocument),
  };
  if (data.name) result.companyName = data.name;
  return result;
}
