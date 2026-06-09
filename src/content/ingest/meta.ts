/**
 * Company metadata extraction for the ingest pipeline.
 * Prioritises XBRL dei:* facts, then EDGAR URL structure, then text heuristics.
 */

import { queryXbrlFact } from './detect.js';

export interface CompanyMeta {
  companyName?: string;
  ticker?: string;
  cik?: string;
  accessionNo?: string;
  periodOfReport?: string;
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
  const companyName =
    queryXbrlFact(doc, 'dei:EntityRegistrantName') ??
    queryXbrlFact(doc, 'dei:entityregistrantname') ??
    titleFromDoc(doc);

  const tickerRaw =
    queryXbrlFact(doc, 'dei:TradingSymbol') ??
    queryXbrlFact(doc, 'dei:tradingsymbol');

  const cikXbrl =
    queryXbrlFact(doc, 'dei:EntityCentralIndexKey') ??
    queryXbrlFact(doc, 'dei:entitycentralindexkey');

  const periodOfReport =
    queryXbrlFact(doc, 'dei:DocumentPeriodEndDate') ??
    queryXbrlFact(doc, 'dei:documentperiodenddate');

  const filedAt =
    queryXbrlFact(doc, 'dei:DocumentEffectiveDate') ??
    queryXbrlFact(doc, 'dei:documenteffectivedate');

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
