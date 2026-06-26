/**
 * Offline extraction harness — exercises the ingestDocument() pipeline.
 *
 * Covers the SEC.gov classification regression (inline fixtures, no file reads)
 * and tracks UNVERIFIED sites that have no offline fixture yet.
 *
 * NOTE: Saved HTML snapshots of third-party financial sites are intentionally
 * NOT committed to this repo (they are copyrighted page captures). To smoke-test
 * a specific non-SEC site layout, capture the live outerHTML locally
 * (`document.documentElement.outerHTML`) and run it through ingestDocument().
 */

import { describe, it, expect } from 'vitest';
import { ingestDocument } from '@/content/ingest';

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
