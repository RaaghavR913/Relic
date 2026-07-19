// ============================================================
// Relic — Prior comparable filing resolver (Session 6)
// ------------------------------------------------------------
// Given a CIK, filing type, and period-of-report, find EARLIER filings of the
// same form via the EDGAR submissions JSON
// (https://data.sec.gov/submissions/CIK##########.json), and build the URL of
// each one's primary document.
//
// Three entry points:
//   - resolvePriorFiling            → the single most-recent earlier filing (Auto)
//   - listPriorComparableFilings    → every earlier same-form filing (dropdown)
//   - resolvePriorFilingByAccession → one specific earlier filing the user picked
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

/**
 * Continuation-file paging caps (`filings.files[]`, each ~1000 filings).
 *
 * Auto only needs the immediately-prior filing, which is in `recent` or the first
 * continuation for all but the most extreme filers — a tiny cap suffices.
 *
 * Enumeration (the dropdown) must reach back several years. Normal filers keep
 * decades of a given form in `recent` alone (sparse), so paging usually stops
 * immediately; only hyper-active filers (big banks file thousands of Form 4s/8-Ks
 * a year) push a form's history across many continuation files. The higher cap +
 * "enough priors" early-stop bounds that worst case to a handful of cached fetches
 * while giving everyone else full history. Ultra-mega-filers may still surface only
 * the last couple years — raise the cap for deeper history.
 */
export const MAX_CONTINUATION_FILES = 2;
export const ENUMERATE_MAX_CONTINUATION_FILES = 8;
/** Stop paging continuation files once this many same-form priors are collected. */
const ENOUGH_PRIORS = 12;

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

/** Options shared by the enumerate / resolve-by-accession helpers. */
export interface ListPriorOpts {
  /** How many continuation files to page (default ENUMERATE_MAX_CONTINUATION_FILES). */
  maxContinuationFiles?: number;
  /** Drop this accession from the result (the currently-open filing). */
  excludeAccessionNo?: string;
  /**
   * Only include priors whose period is within this many years of the current
   * one (the dropdown look-back window). Also lets paging stop as soon as the
   * window is covered. Omit for the full history.
   */
  withinYears?: number;
}

/** Subtract whole years from an ISO date (YYYY-MM-DD), keeping month/day — used as a `>=` bound. */
function subtractYearsIso(iso: string, years: number): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso.slice(0, 10));
  if (!m) return iso.slice(0, 10);
  return `${String(Number(m[1]) - years).padStart(4, '0')}-${m[2]}-${m[3]}`;
}

/** Same-form rows with accession + primary document, unsorted. */
function sameFormRows(rows: FilingEntry[], filingType: string): FilingEntry[] {
  return rows.filter((r) => r.form === filingType && r.accessionNo && r.primaryDocument);
}

/** Sort filing rows by reportDate, most recent first. */
function byReportDateDesc(a: FilingEntry, b: FilingEntry): number {
  return a.reportDate < b.reportDate ? 1 : a.reportDate > b.reportDate ? -1 : 0;
}

/** Map a raw filing row to the public locator shape (builds the Archives URL). */
function toLocator(cik: string | number, r: FilingEntry, companyName?: string): PriorFilingLocator {
  const result: PriorFilingLocator = {
    cik: padCik(cik),
    accessionNo: r.accessionNo,
    primaryDocument: r.primaryDocument,
    form: r.form,
    reportDate: r.reportDate,
    filingDate: r.filingDate,
    url: buildArchiveUrl(cik, r.accessionNo, r.primaryDocument),
  };
  if (companyName) result.companyName = companyName;
  return result;
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
  const sameForm = sameFormRows(rows, filingType).sort(byReportDateDesc);

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
 * Parse the submissions JSON for a CIK. Throws on unparseable JSON (the caller
 * turns that into a user-facing "resolve failed" message).
 */
async function fetchSubmissions(cik: string | number, deps: ResolveDeps): Promise<SubmissionsJson> {
  const json = await deps.fetchText(submissionsUrl(cik));
  try {
    return JSON.parse(json) as SubmissionsJson;
  } catch {
    throw new Error('Could not parse EDGAR submissions JSON');
  }
}

/**
 * Flatten `filings.recent`, then page older-filings continuation files
 * (`filings.files[]`) one at a time — up to `maxContinuationFiles` — accumulating
 * rows. `stop(rows)` is consulted after `recent` and after each continuation so a
 * caller can bail early (enough priors found, target accession seen). Each fetch
 * rides the same injected `fetchText` (shared RateLimitedQueue + cache);
 * unparseable/unavailable continuations are skipped, not fatal.
 */
async function pageFilings(
  data: SubmissionsJson,
  deps: ResolveDeps,
  maxContinuationFiles: number,
  stop: (rows: FilingEntry[]) => boolean,
): Promise<FilingEntry[]> {
  const rows: FilingEntry[] = data.filings?.recent ? rowsOf(data.filings.recent) : [];
  if (stop(rows)) return rows;

  const files = data.filings?.files ?? [];
  const cap = Math.min(files.length, Math.max(0, maxContinuationFiles));
  for (let i = 0; i < cap; i++) {
    const name = files[i]?.name;
    if (!name) continue;
    try {
      const contJson = await deps.fetchText(continuationUrl(name));
      rows.push(...rowsOf(JSON.parse(contJson) as RecentFilings));
    } catch {
      continue; // this continuation is unusable — try the next one
    }
    if (stop(rows)) break;
  }
  return rows;
}

/**
 * Find the prior comparable filing for (cik, filingType, periodOfReport).
 * Returns null when no earlier filing of the same form exists.
 *
 * Selection (Auto):
 *   - Keep entries whose form EXACTLY equals filingType (amendments like 10-K/A
 *     are excluded — they are not standalone comparables).
 *   - Sort by reportDate descending.
 *   - If periodOfReport is known, pick the entry with the largest reportDate
 *     STRICTLY earlier than it. Falling back, if the current filing itself is in
 *     the list, take the entry immediately after it.
 *   - If periodOfReport is unknown, assume index 0 is the current filing and
 *     return index 1.
 *
 * `filings.recent` only holds the most recent ~1000 filings. When the prior has
 * aged out, this pages the older-filings continuation files (`filings.files[]`)
 * one at a time — up to MAX_CONTINUATION_FILES — re-running the selection over the
 * accumulated rows until a prior is found or the files run out.
 */
export async function resolvePriorFiling(
  cik: string | number,
  filingType: string,
  periodOfReport: string | undefined,
  deps: ResolveDeps,
): Promise<PriorFilingLocator | null> {
  const data = await fetchSubmissions(cik, deps);

  // `filings.recent` may be entirely absent (some submission JSONs page ALL
  // filings into continuation files). Treat that the same as "present but no
  // match" so the continuation paging below still runs.
  const rows: FilingEntry[] = data.filings?.recent ? rowsOf(data.filings.recent) : [];
  let prior = selectPrior(rows, filingType, periodOfReport);

  if (!prior) {
    const files = data.filings?.files ?? [];
    const cap = Math.min(files.length, MAX_CONTINUATION_FILES);
    for (let i = 0; i < cap && !prior; i++) {
      const name = files[i]?.name;
      if (!name) continue;
      try {
        const contJson = await deps.fetchText(continuationUrl(name));
        rows.push(...rowsOf(JSON.parse(contJson) as RecentFilings));
      } catch {
        continue; // this continuation is unusable — try the next one
      }
      prior = selectPrior(rows, filingType, periodOfReport);
    }
  }

  if (!prior) return null;
  return toLocator(cik, prior, data.name);
}

/**
 * Enumerate every earlier same-form filing for (cik, filingType), most recent
 * first — the source for the "Compare against" dropdown. Excludes amendments
 * (exact-form match) and de-dupes across recent + continuation files.
 *
 * When `periodOfReport` is given, only filings strictly earlier than it are kept
 * (drops the currently-open filing); `opts.excludeAccessionNo` drops it as well
 * (belt-and-suspenders for filings without a period date).
 */
export async function listPriorComparableFilings(
  cik: string | number,
  filingType: string,
  periodOfReport: string | undefined,
  deps: ResolveDeps,
  opts?: ListPriorOpts,
): Promise<PriorFilingLocator[]> {
  const data = await fetchSubmissions(cik, deps);
  const target = periodOfReport?.slice(0, 10);
  const exclude = opts?.excludeAccessionNo;
  const withinYears = opts?.withinYears;

  // A row is a usable prior when it's the exact form, strictly earlier than the
  // current period (when known), and not the current filing itself.
  const isPrior = (r: FilingEntry): boolean =>
    r.form === filingType &&
    Boolean(r.accessionNo && r.primaryDocument) &&
    (!target || r.reportDate.slice(0, 10) < target) &&
    r.accessionNo !== exclude;

  // When both the current period and a look-back window are known, the cutoff is
  // known up front — page only until a prior older than it appears (the whole
  // window is then in hand). Otherwise fall back to a fixed prior count.
  const cutoff = withinYears && target ? subtractYearsIso(target, withinYears) : undefined;
  const rows = await pageFilings(
    data,
    deps,
    opts?.maxContinuationFiles ?? ENUMERATE_MAX_CONTINUATION_FILES,
    (rs) => {
      const priors = rs.filter(isPrior);
      return cutoff
        ? priors.some((r) => r.reportDate.slice(0, 10) < cutoff)
        : priors.length >= ENOUGH_PRIORS;
    },
  );

  const sorted = rows.filter(isPrior).sort(byReportDateDesc);
  // Trim to the look-back window — anchored on the current period when known,
  // otherwise on the newest prior found.
  const anchor = target ?? sorted[0]?.reportDate.slice(0, 10);
  const effCutoff = withinYears && anchor ? subtractYearsIso(anchor, withinYears) : undefined;

  const seen = new Set<string>();
  const priors: PriorFilingLocator[] = [];
  for (const r of sorted) {
    if (effCutoff && r.reportDate.slice(0, 10) < effCutoff) continue;
    if (seen.has(r.accessionNo)) continue;
    seen.add(r.accessionNo);
    priors.push(toLocator(cik, r, data.name));
  }
  return priors;
}

/**
 * Resolve one specific earlier filing the user picked from the dropdown, by its
 * accession number. Re-derives everything from EDGAR (authoritative) rather than
 * trusting a client-supplied URL. Returns null when the accession isn't found
 * among the company's same-form filings.
 *
 * Pages the same continuation files as `listPriorComparableFilings` (same cap,
 * from the same warm cache) but stops as soon as the target accession appears —
 * so anything the dropdown surfaced resolves here without extra network.
 */
export async function resolvePriorFilingByAccession(
  cik: string | number,
  filingType: string,
  accessionNo: string,
  deps: ResolveDeps,
  opts?: ListPriorOpts,
): Promise<PriorFilingLocator | null> {
  const data = await fetchSubmissions(cik, deps);
  const rows = await pageFilings(
    data,
    deps,
    opts?.maxContinuationFiles ?? ENUMERATE_MAX_CONTINUATION_FILES,
    (rs) => rs.some((r) => r.accessionNo === accessionNo && r.form === filingType),
  );
  const match = sameFormRows(rows, filingType).find((r) => r.accessionNo === accessionNo);
  return match ? toLocator(cik, match, data.name) : null;
}
