/**
 * Company-name extraction fallback chain (kills "Unknown company" on IR pages).
 *
 * Order, most → least authoritative:
 *   dei:EntityRegistrantName → JSON-LD Organization → og:site_name → <h1> → <title>.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { extractCompanyMeta } from '@/content/ingest/meta';

beforeEach(() => {
  document.head.innerHTML = '';
  document.body.innerHTML = '';
});

describe('extractCompanyMeta — company-name fallbacks', () => {
  it('prefers the authoritative XBRL registrant over page metadata', () => {
    document.head.innerHTML = '<meta property="og:site_name" content="Marketing Brand">';
    document.body.innerHTML =
      '<span name="dei:EntityRegistrantName">Acme Industries, Inc.</span><h1>Q4 Results</h1>';
    expect(extractCompanyMeta(document).companyName).toBe('Acme Industries, Inc.');
  });

  it('falls back to a JSON-LD Organization name', () => {
    document.head.innerHTML =
      '<script type="application/ld+json">' +
      JSON.stringify({ '@context': 'https://schema.org', '@type': 'Organization', name: 'Beta Corp' }) +
      '</script>';
    document.body.innerHTML = '<h1>Fourth Quarter Earnings</h1>';
    expect(extractCompanyMeta(document).companyName).toBe('Beta Corp');
  });

  it('finds an Organization nested inside a JSON-LD @graph / publisher', () => {
    document.head.innerHTML =
      '<script type="application/ld+json">' +
      JSON.stringify({
        '@graph': [{ '@type': 'NewsArticle', publisher: { '@type': 'Corporation', name: 'Gamma Holdings' } }],
      }) +
      '</script>';
    expect(extractCompanyMeta(document).companyName).toBe('Gamma Holdings');
  });

  it('falls back to og:site_name when there is no XBRL or JSON-LD org', () => {
    document.head.innerHTML = '<meta property="og:site_name" content="Delta Technologies">';
    document.body.innerHTML = '<h1>Investor Relations</h1>';
    expect(extractCompanyMeta(document).companyName).toBe('Delta Technologies');
  });

  it('falls back to the first <h1> when nothing else is available', () => {
    document.body.innerHTML = '<h1>Epsilon Pharmaceuticals</h1><p>news</p>';
    expect(extractCompanyMeta(document).companyName).toBe('Epsilon Pharmaceuticals');
  });

  it('still returns ticker from dei:TradingSymbol and cik from the EDGAR URL', () => {
    document.body.innerHTML =
      '<span name="dei:EntityRegistrantName">Zeta Co</span><span name="dei:TradingSymbol">zeta</span>';
    const meta = extractCompanyMeta(
      document,
      'https://www.sec.gov/Archives/edgar/data/123/000012300024000001/zeta-10k.htm',
    );
    expect(meta.ticker).toBe('ZETA');
    expect(meta.cik).toBe('123');
  });
});
