/**
 * Company metadata extraction for the ingest pipeline.
 * Prioritises XBRL dei:* facts, then EDGAR URL structure, then text heuristics.
 */

import { queryXbrlFact } from './detect.js';
import { toIsoDate } from '@/lib/date';

export interface CompanyMeta {
  companyName?: string;
  ticker?: string;
  cik?: string;
  accessionNo?: string;
  /** Date-only ISO (YYYY-MM-DD). Normalized — inline XBRL renders display text. */
  periodOfReport?: string;
  /** Date-only ISO (YYYY-MM-DD). */
  filedAt?: string;
}

export function parseEdgarUrl(url: string): Pick<CompanyMeta, 'cik' | 'accessionNo'> {
  // Dashed format: /Archives/edgar/data/1234567890/0001234567890-24-000001/
  const dashed = /\/Archives\/edgar\/data\/(\d+)\/(\d{10}-\d{2}-\d{6})/i.exec(url);
  if (dashed?.[1] && dashed?.[2]) {
    return { cik: dashed[1], accessionNo: dashed[2] };
  }
  // Compact format: /Archives/edgar/data/1234567890/000123456789024000001/
  const compact = /\/Archives\/edgar\/data\/(\d+)\/(\d{18})\//i.exec(url);
  if (compact?.[1] && compact?.[2]) {
    const raw = compact[2];
    return {
      cik: compact[1],
      accessionNo: `${raw.slice(0, 10)}-${raw.slice(10, 12)}-${raw.slice(12)}`,
    };
  }
  return {};
}

export function extractCompanyMeta(doc: Document, url?: string): CompanyMeta {
  // Fallback chain, most → least authoritative. XBRL is the registrant of record;
  // off-EDGAR pages (IR / earnings) have no dei:* facts, so fall back to structured
  // page metadata before the title regex — this is what kills most "Unknown company".
  const companyName =
    queryXbrlFact(doc, 'dei:EntityRegistrantName') ??
    queryXbrlFact(doc, 'dei:entityregistrantname') ??
    jsonLdOrgName(doc) ??
    metaContent(doc, 'og:site_name') ??
    firstH1(doc) ??
    titleFromDoc(doc);

  const tickerRaw =
    queryXbrlFact(doc, 'dei:TradingSymbol') ??
    queryXbrlFact(doc, 'dei:tradingsymbol');

  const cikXbrl =
    queryXbrlFact(doc, 'dei:EntityCentralIndexKey') ??
    queryXbrlFact(doc, 'dei:entitycentralindexkey');

  // Inline XBRL renders these facts as DISPLAY text ("September 30, 2023"), not
  // the ISO value. Everything downstream (prior-filing selection, XBRL period
  // matching) compares them as ISO, so normalize here at the single source.
  const periodOfReport = toIsoDate(
    queryXbrlFact(doc, 'dei:DocumentPeriodEndDate') ??
      queryXbrlFact(doc, 'dei:documentperiodenddate'),
  );

  const filedAt = toIsoDate(
    queryXbrlFact(doc, 'dei:DocumentEffectiveDate') ??
      queryXbrlFact(doc, 'dei:documenteffectivedate'),
  );

  const { cik: cikUrl, accessionNo } = parseEdgarUrl(url ?? '');
  const cik = cikUrl ?? (cikXbrl ? normalizeCik(cikXbrl) : undefined);

  const result: CompanyMeta = {};
  if (companyName) result.companyName = companyName;
  if (tickerRaw) result.ticker = tickerRaw.toUpperCase();
  if (cik) result.cik = cik;
  if (accessionNo) result.accessionNo = accessionNo;
  if (periodOfReport) result.periodOfReport = periodOfReport;
  if (filedAt) result.filedAt = filedAt;
  return result;
}

function normalizeCik(raw: string): string {
  return String(parseInt(raw, 10));
}

function titleFromDoc(doc: Document): string | undefined {
  const title = doc.title;
  if (!title) return undefined;
  const m = /^([^|–—\n]{3,80}?)\s*(?:(?:\d{4})|10-K|10-Q|8-K|S-1|DEF|proxy)/i.exec(title);
  return m?.[1]?.trim() || undefined;
}

/** Read a `<meta property|name="key">` content value, trimmed. */
function metaContent(doc: Document, key: string): string | undefined {
  const el =
    doc.querySelector(`meta[property="${key}"]`) ?? doc.querySelector(`meta[name="${key}"]`);
  const content = el?.getAttribute('content')?.trim();
  return content || undefined;
}

/** First `<h1>` text, cleaned — a decent company/brand signal on IR pages. */
function firstH1(doc: Document): string | undefined {
  const h1 = doc.querySelector('h1')?.textContent?.trim().replace(/\s+/g, ' ');
  return h1 && h1.length >= 2 && h1.length <= 120 ? h1 : undefined;
}

// Schema.org @types we accept as the page's owning organization.
const ORG_TYPE_RE = /Organization|Corporation|LocalBusiness/i;

/**
 * Walk a parsed JSON-LD value for the name of an Organization/Corporation node.
 * Handles arrays, `@graph`, and nested publisher/author objects. Depth-bounded.
 */
function findOrgName(node: unknown, depth = 0): string | undefined {
  if (depth > 4 || node === null || typeof node !== 'object') return undefined;
  if (Array.isArray(node)) {
    for (const item of node) {
      const n = findOrgName(item, depth + 1);
      if (n) return n;
    }
    return undefined;
  }
  const o = node as Record<string, unknown>;
  const type = o['@type'];
  const typeStr = Array.isArray(type) ? type.join(' ') : typeof type === 'string' ? type : '';
  if (ORG_TYPE_RE.test(typeStr) && typeof o['name'] === 'string' && o['name'].trim()) {
    return o['name'].trim();
  }
  for (const key of ['@graph', 'publisher', 'author', 'organization', 'mainEntity']) {
    if (key in o) {
      const n = findOrgName(o[key], depth + 1);
      if (n) return n;
    }
  }
  return undefined;
}

/** Company name from a JSON-LD `<script type="application/ld+json">` block, if any. */
function jsonLdOrgName(doc: Document): string | undefined {
  for (const s of Array.from(doc.querySelectorAll('script[type="application/ld+json"]'))) {
    let data: unknown;
    try {
      data = JSON.parse(s.textContent ?? '');
    } catch {
      continue;
    }
    const name = findOrgName(data);
    if (name) return name;
  }
  return undefined;
}
