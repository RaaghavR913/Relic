/**
 * Unit tests for src/content/ingest/siteProfiles.ts
 *
 * Verifies group classification, contentSelector presence for group B,
 * optionalHostPattern presence for group C, isGroupCSite(), and detectGateState().
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  getSiteProfile,
  isGroupCSite,
  detectGateState,
} from '@/content/ingest/siteProfiles';

// ── getSiteProfile ────────────────────────────────────────────────────────────

describe('getSiteProfile', () => {
  it('returns group A for stockanalysis.com', () => {
    const p = getSiteProfile('https://stockanalysis.com/stocks/aapl/');
    expect(p?.group).toBe('A');
  });

  it('returns group A for www.stockanalysis.com (www. variant)', () => {
    const p = getSiteProfile('https://www.stockanalysis.com/stocks/aapl/financials/');
    expect(p?.group).toBe('A');
  });

  it('returns group A for annualreports.com', () => {
    const p = getSiteProfile('https://www.annualreports.com/Company/apple');
    expect(p?.group).toBe('A');
  });

  it('returns group A for fool.com', () => {
    const p = getSiteProfile('https://www.fool.com/investing/stock-market/market-sectors/technology/apple/');
    expect(p?.group).toBe('A');
  });

  it('returns group A for benzinga.com', () => {
    const p = getSiteProfile('https://www.benzinga.com/stock/AAPL');
    expect(p?.group).toBe('A');
  });

  it('returns group B for sec.report', () => {
    const p = getSiteProfile('https://sec.report/Document/0000320193-24-000006/');
    expect(p?.group).toBe('B');
  });

  it('returns group B for www.sec.report', () => {
    const p = getSiteProfile('https://www.sec.report/CIK/0000320193');
    expect(p?.group).toBe('B');
  });

  it('group B sec.report has a contentSelector', () => {
    const p = getSiteProfile('https://sec.report/Document/0000320193-24-000006/');
    expect(typeof p?.contentSelector).toBe('string');
    expect(p!.contentSelector!.length).toBeGreaterThan(0);
  });

  it('returns group B for finviz.com', () => {
    const p = getSiteProfile('https://finviz.com/quote.ashx?t=AAPL');
    expect(p?.group).toBe('B');
  });

  it('group B finviz has a contentSelector', () => {
    const p = getSiteProfile('https://finviz.com/quote.ashx?t=AAPL');
    expect(typeof p?.contentSelector).toBe('string');
  });

  it('returns group C for finance.yahoo.com', () => {
    const p = getSiteProfile('https://finance.yahoo.com/quote/AAPL/');
    expect(p?.group).toBe('C');
  });

  it('returns group C for macrotrends.net', () => {
    const p = getSiteProfile('https://www.macrotrends.net/stocks/charts/AAPL/apple/revenue');
    expect(p?.group).toBe('C');
  });

  it('returns group C for bamsec.com', () => {
    const p = getSiteProfile('https://bamsec.com/company/0000320193');
    expect(p?.group).toBe('C');
  });

  it('returns group C for cnbc.com', () => {
    const p = getSiteProfile('https://www.cnbc.com/quotes/AAPL');
    expect(p?.group).toBe('C');
  });

  it('returns group C for reuters.com', () => {
    const p = getSiteProfile('https://www.reuters.com/markets/companies/AAPL.OQ/');
    expect(p?.group).toBe('C');
  });

  it('every group C profile has an optionalHostPattern', () => {
    const groupC = [
      'https://finance.yahoo.com/quote/AAPL/',
      'https://www.macrotrends.net/stocks/charts/AAPL/apple/revenue',
      'https://bamsec.com/company/320193',
      'https://www.cnbc.com/quotes/AAPL',
      'https://www.reuters.com/markets/companies/AAPL.OQ/',
    ];
    for (const url of groupC) {
      const p = getSiteProfile(url);
      expect(p?.optionalHostPattern, `${url} missing optionalHostPattern`).toBeTruthy();
    }
  });

  it('returns undefined for unregistered hosts', () => {
    expect(getSiteProfile('https://seekingalpha.com/symbol/AAPL')).toBeUndefined();
    expect(getSiteProfile('https://morningstar.com/stocks/aapl')).toBeUndefined();
    expect(getSiteProfile('https://bloomberg.com/quote/AAPL:US')).toBeUndefined();
  });

  it('returns undefined for sec.gov (handled separately by classifyPage)', () => {
    expect(getSiteProfile('https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=aapl')).toBeUndefined();
    expect(getSiteProfile('https://www.sec.gov/Archives/edgar/data/320193/000032019324000006/aapl-20231230.htm')).toBeUndefined();
  });

  it('returns undefined for malformed URLs', () => {
    expect(getSiteProfile('not a url')).toBeUndefined();
    expect(getSiteProfile('')).toBeUndefined();
  });
});

// ── isGroupCSite ─────────────────────────────────────────────────────────────

describe('isGroupCSite', () => {
  it('returns true for group C URLs', () => {
    expect(isGroupCSite('https://finance.yahoo.com/quote/AAPL/')).toBe(true);
    expect(isGroupCSite('https://www.reuters.com/markets/companies/AAPL.OQ/')).toBe(true);
    expect(isGroupCSite('https://www.cnbc.com/quotes/AAPL')).toBe(true);
  });

  it('returns false for group A URLs', () => {
    expect(isGroupCSite('https://stockanalysis.com/stocks/aapl/')).toBe(false);
    expect(isGroupCSite('https://www.fool.com/quote/aapl/')).toBe(false);
  });

  it('returns false for group B URLs', () => {
    expect(isGroupCSite('https://sec.report/Document/0000320193-24-000006/')).toBe(false);
    expect(isGroupCSite('https://finviz.com/quote.ashx?t=AAPL')).toBe(false);
  });

  it('returns false for unregistered URLs', () => {
    expect(isGroupCSite('https://seekingalpha.com/symbol/AAPL')).toBe(false);
    expect(isGroupCSite('https://www.sec.gov/Archives/edgar/data/320193/')).toBe(false);
  });
});

// ── detectGateState ───────────────────────────────────────────────────────────

describe('detectGateState', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('returns open when no gate selectors are present', () => {
    document.body.innerHTML = '<article><p>Apple reported record revenue.</p></article>';
    const p = getSiteProfile('https://finance.yahoo.com/quote/AAPL/')!;
    expect(detectGateState(p, document)).toBe('open');
  });

  it('returns consent_wall when the yahoo consent selector matches', () => {
    document.body.innerHTML = '<div id="consent-page"><p>Please accept cookies</p></div>';
    const p = getSiteProfile('https://finance.yahoo.com/quote/AAPL/')!;
    expect(detectGateState(p, document)).toBe('consent_wall');
  });

  it('returns consent_wall when the CNBC OneTrust selector matches', () => {
    document.body.innerHTML = '<div id="onetrust-banner-sdk"><button>Accept All</button></div>';
    const p = getSiteProfile('https://www.cnbc.com/quotes/AAPL')!;
    expect(detectGateState(p, document)).toBe('consent_wall');
  });

  it('returns paywall when the macrotrends registration selector matches', () => {
    document.body.innerHTML = '<div class="bwal-modal"><p>Register to continue</p></div>';
    const p = getSiteProfile('https://www.macrotrends.net/stocks/charts/AAPL/apple/revenue')!;
    expect(detectGateState(p, document)).toBe('paywall');
  });

  it('returns open when no gate selector matches (group A profile has no selectors)', () => {
    document.body.innerHTML = '<div id="consent-page">whatever</div>';
    const p = getSiteProfile('https://stockanalysis.com/stocks/aapl/')!;
    // Group A has no consentSelector or paywallSelector — always open.
    expect(detectGateState(p, document)).toBe('open');
  });
});
