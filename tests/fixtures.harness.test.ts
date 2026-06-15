/**
 * Offline extraction harness — runs the full ingestDocument() pipeline against
 * saved fixture HTML files and reports usability per site.
 *
 * ─── CRITICAL CAVEAT ────────────────────────────────────────────────────────
 * Fixtures are SERVER-FETCH captures, not true rendered-DOM snapshots.
 * For SSR + hydration sites (Yahoo Finance, Motley Fool, Benzinga), the live DOM
 * the content script sees WILL differ from these files. A passing fixture is a
 * SMOKE TEST that field extraction works on available markup — it is NOT proof
 * the live site works.
 *
 * Mark a site as supported only after:
 *   1. Running FilingLens on the real page and opening DevTools.
 *   2. Copying true outerHTML via: document.documentElement.outerHTML
 *   3. Replacing the stub fixture with that capture.
 *   4. This harness passing on the real capture.
 *
 * Sites marked UNVERIFIED have no fixture at all (anti-bot, JS shells, or
 * paywalls prevent server-fetch captures). Do not claim support for those until
 * a true DOM snapshot is supplied.
 * ────────────────────────────────────────────────────────────────────────────
 *
 * How to interpret results:
 *   PASS    — extraction ran, produced ≥1 section, ≥500 chars, correct category.
 *             Still needs true DOM snapshot before claiming live support.
 *   FAIL    — extraction threw or produced unusable output. Check the selector
 *             overrides in siteProfiles.ts and the fixture HTML structure.
 *   SKIP    — no fixture available; site is UNVERIFIED.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { ingestDocument } from '@/content/ingest';

const FIXTURES_DIR = join(process.cwd(), 'fixtures');

function loadFixture(filename: string): string {
  return readFileSync(join(FIXTURES_DIR, filename), 'utf-8');
}

function docFrom(html: string): Document {
  return new DOMParser().parseFromString(html, 'text/html');
}

// ── SEC.gov regression ────────────────────────────────────────────────────────
// The existing EDGAR path must not be broken by any of the new site changes.

describe('SEC.gov regression (inline fixture — no file read)', () => {
  const ARCHIVES = 'https://www.sec.gov/Archives/edgar/data/320193/000032019324000006';
  const LOREM = 'The Company continued to execute on its strategy during the period, and management believes the results reflect underlying operating trends. ';

  it('10-K on Archives path still classifies as edgar_filing', () => {
    const html = `<!doctype html><html><head><title>Apple 10-K</title></head><body>
      <span name="dei:DocumentType">10-K</span>
      <span name="dei:EntityRegistrantName">Apple Inc.</span>
      <h2>ITEM 1. BUSINESS</h2><p>${'Apple designs consumer electronics. ' + LOREM.repeat(3)}</p>
      <h2>ITEM 1A. RISK FACTORS</h2><p>${'Adverse conditions may affect results. ' + LOREM.repeat(3)}</p>
      <h2>ITEM 7. MANAGEMENT DISCUSSION AND ANALYSIS</h2><p>${'Revenue grew 5%. ' + LOREM.repeat(3)}</p>
    </body></html>`;
    const { model } = ingestDocument({
      document: docFrom(html),
      url: `${ARCHIVES}/aapl-20231230.htm`,
    });
    expect(model.source.category).toBe('edgar_filing');
    expect(model.filingType).toBe('10-K');
    expect(model.sections.length).toBeGreaterThanOrEqual(2);
  });

  it('off-sec.gov URL still classifies as ir_or_financial (not edgar_filing)', () => {
    const html = '<!doctype html><html><body><h1>Apple IR</h1><p>Investor relations page for Apple Inc. The company reported strong results for the fiscal year ended September 30, 2023, with net income of $96.99 billion.</p></body></html>';
    const { model } = ingestDocument({
      document: docFrom(html),
      url: 'https://investor.apple.com/news/press-releases',
    });
    expect(model.source.category).toBe('ir_or_financial');
    expect(model.source.category).not.toBe('edgar_filing');
  });
});

// ── Group A fixtures ──────────────────────────────────────────────────────────
// Static content_scripts matches. Content readable at document_idle.
// SMOKE TEST ONLY — needs true outerHTML snapshot to confirm live support.

describe('Group A (auto-inject, static content) — SMOKE TEST', () => {
  const FIXTURES: Array<{
    site: string;
    file: string;
    url: string;
  }> = [
    {
      site: 'stockanalysis.com',
      file: 'stockanalysis_AAPL.html',
      url: 'https://stockanalysis.com/stocks/aapl/',
    },
    {
      site: 'annualreports.com',
      file: 'annualreports_AAPL.html',
      url: 'https://www.annualreports.com/Company/apple',
    },
    {
      site: 'fool.com',
      file: 'fool_AAPL.html',
      url: 'https://www.fool.com/investing/2024/06/10/apple-stock-analysis/',
    },
    {
      site: 'benzinga.com',
      file: 'benzinga_AAPL.html',
      url: 'https://www.benzinga.com/stock/AAPL',
    },
  ];

  for (const { site, file, url } of FIXTURES) {
    describe(`${site} [SMOKE TEST — needs true outerHTML snapshot]`, () => {
      const html = loadFixture(file);
      const { model, positionMap } = ingestDocument({ document: docFrom(html), url });

      it('classifies as ir_or_financial (not edgar_filing)', () => {
        expect(model.source.category).toBe('ir_or_financial');
      });

      it('is NOT misclassified as an EDGAR filing', () => {
        expect(model.source.category).not.toBe('edgar_filing');
        expect(model.source.category).not.toBe('edgar_ixbrl');
      });

      it('produces at least 1 section', () => {
        expect(model.sections.length).toBeGreaterThanOrEqual(1);
      });

      it('extracts at least 500 chars of text', () => {
        expect(positionMap.text.length).toBeGreaterThanOrEqual(500);
      });
    });
  }
});

// ── Group C fixtures ──────────────────────────────────────────────────────────
// optional_host_permissions. These fixtures represent the accessible (pre-gate) view.
// SMOKE TEST ONLY — live pages may show consent/paywall gates or heavy hydration.

describe('Group C (optional permission, pre-gate view) — SMOKE TEST', () => {
  const FIXTURES: Array<{
    site: string;
    file: string;
    url: string;
    note: string;
  }> = [
    {
      site: 'finance.yahoo.com',
      file: 'yahoo_finance_AAPL.html',
      url: 'https://finance.yahoo.com/quote/AAPL/',
      note: 'GUCE consent wall in EU; heavy React hydration — live DOM differs',
    },
    {
      site: 'macrotrends.net',
      file: 'macrotrends_AAPL_revenue.html',
      url: 'https://www.macrotrends.net/stocks/charts/AAPL/apple/revenue',
      note: 'Email registration wall after a few views — live DOM may have .bwal-modal',
    },
    {
      site: 'bamsec.com',
      file: 'bamsec_AAPL.html',
      url: 'https://bamsec.com/company/0000320193',
      note: 'Filing index is open; document viewer is account-gated',
    },
  ];

  for (const { site, file, url, note } of FIXTURES) {
    describe(`${site} [SMOKE TEST — ${note}]`, () => {
      const html = loadFixture(file);
      const { model, positionMap } = ingestDocument({ document: docFrom(html), url });

      it('classifies as ir_or_financial', () => {
        expect(model.source.category).toBe('ir_or_financial');
      });

      it('is NOT misclassified as an EDGAR filing', () => {
        expect(model.source.category).not.toBe('edgar_filing');
      });

      it('produces at least 1 section', () => {
        expect(model.sections.length).toBeGreaterThanOrEqual(1);
      });

      it('extracts at least 500 chars of text', () => {
        expect(positionMap.text.length).toBeGreaterThanOrEqual(500);
      });
    });
  }
});

// ── UNVERIFIED sites (no fixture) ─────────────────────────────────────────────
// These sites could not be captured via server-fetch (anti-bot, JS shells, or
// paywalls). Do NOT claim support until a true browser outerHTML snapshot is
// supplied and this test suite updated.

describe('UNVERIFIED sites (no fixture — skipped)', () => {
  it.skip(
    'sec.report — UNVERIFIED: anti-bot / Cloudflare interstitial; ' +
    'contentSelector in siteProfiles.ts gates extraction but needs real DOM snapshot to confirm',
    () => { /* replace with real fixture */ },
  );

  it.skip(
    'finviz.com — UNVERIFIED: anti-bot on server fetch; ' +
    'in-browser content script sees static HTML but no DOM snapshot available to test offline',
    () => { /* replace with real fixture */ },
  );

  it.skip(
    'cnbc.com — UNVERIFIED: server HTML is an empty JS shell; ' +
    'extraction requires the hydrated DOM — must capture outerHTML from the live browser',
    () => { /* replace with real fixture */ },
  );

  it.skip(
    'reuters.com — UNVERIFIED: metered paywall + EU consent wall on article bodies; ' +
    'only non-article market/quote data is accessible — no fixture available',
    () => { /* replace with real fixture */ },
  );
});
