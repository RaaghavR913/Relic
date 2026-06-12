/**
 * Page classification for the ingest pipeline.
 *
 * Decides a coarse PageCategory from URL + DOM BEFORE any filing-type detection.
 * This replaces the previous assumption that every `sec.gov` host is an EDGAR
 * filing — www.sec.gov also serves data-research, rules, and informational pages
 * that are readable documents but NOT company filings. Treating those as filings
 * produced the "Unknown company / S-1 / 1 section" misclassification.
 *
 * Ordering matters: the most authoritative signals (Archives path, XBRL facts,
 * inline-XBRL namespace) win before falling back to host-level buckets.
 */

import type { PageCategory } from '../../types/index.js';
import { queryXbrlFact } from './detect.js';

export function safeHost(url: string | undefined): string {
  if (!url) return '';
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

function isSecHost(host: string): boolean {
  return /(?:^|\.)sec\.gov$/i.test(host);
}

/** Web Store hosts Chrome never lets an extension script (mirrors inject.ts). */
const WEB_STORE_HOSTS = /(?:^|\.)chromewebstore\.google\.com$|^chrome\.google\.com$/i;

/**
 * True for pages the extension can meaningfully ingest: an http(s) page that
 * isn't the Web Store. Non-web schemes (chrome://, file://, about:) and
 * unparseable URLs are not analyzable — they classify as `unsupported`.
 */
function isSupportedUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false;
  return !WEB_STORE_HOSTS.test(parsed.hostname);
}

/** True when the document carries inline-XBRL structure (ix: tags / contextRef). */
function hasInlineXbrl(doc: Document): boolean {
  try {
    // ix:* tags need a namespace-aware selector escape; contextref is the cheap tell.
    return (
      doc.querySelector('[contextref], [contextRef]') !== null ||
      doc.getElementsByTagName('ix:header').length > 0 ||
      doc.getElementsByTagName('ix:nonNumeric').length > 0
    );
  } catch {
    return false;
  }
}

/** True when authoritative dei:* facts are present (genuine EDGAR filing). */
function hasDeiFacts(doc: Document): boolean {
  return (
    queryXbrlFact(doc, 'dei:DocumentType') !== undefined ||
    queryXbrlFact(doc, 'dei:EntityRegistrantName') !== undefined
  );
}

/**
 * Classify a page into a PageCategory.
 *
 * @param doc the picked filing-root document (post-iframe selection)
 * @param url the page URL (used for path-based signals)
 */
export function classifyPage(doc: Document, url: string): PageCategory {
  // Non-web schemes, the Web Store, and unparseable URLs can't be analyzed.
  if (!isSupportedUrl(url)) return 'unsupported';

  const host = safeHost(url);

  if (isSecHost(host)) {
    // Authoritative filing signals first — these can appear on any sec.gov path.
    if (/\/Archives\/edgar\/data\//i.test(url)) return 'edgar_filing';
    if (hasDeiFacts(doc)) return 'edgar_filing';
    if (hasInlineXbrl(doc)) return 'edgar_ixbrl';

    // Search / browse / company-profile surfaces — readable but not a single filing.
    if (/\/cgi-bin\/browse-edgar|\/edgar\/search|\/cgi-bin\/srqsb/i.test(url)) {
      return 'sec_search';
    }

    // Everything else on sec.gov (data-research, rules, files, news, divisions…)
    // is an informational/data page: readable, no registrant, NOT a filing.
    return 'sec_data_report';
  }

  // Off-sec.gov: an investor-relations / earnings / generic financial page.
  return 'ir_or_financial';
}

/** Categories that should be read as a plain readable document, not a filing. */
export function isReadableNonFiling(category: PageCategory): boolean {
  return category === 'sec_data_report' || category === 'sec_search';
}

/** Back-compat host bucket derived from category (DocumentModel.source.host). */
export function hostForCategory(category: PageCategory): 'edgar' | 'ir' {
  return category === 'ir_or_financial' || category === 'unsupported' ? 'ir' : 'edgar';
}
