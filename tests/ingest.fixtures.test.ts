/**
 * End-to-end ingestion regression tests across every supported page type.
 *
 * Each fixture is a compact, structurally-realistic facsimile (XBRL dei facts,
 * ITEM headers, proxy/prospectus titles, inline-XBRL contextref) — enough to
 * exercise classifyPage → detectFilingType → segmentSections → extractCompanyMeta
 * through the real ingestDocument() orchestrator. Real saved SEC/IR HTML can be
 * dropped in later; these pin the contract cheaply and deterministically.
 */

import { describe, it, expect } from 'vitest';
import { ingestDocument } from '@/content/ingest';
import type { FilingType, PageCategory } from '@/types';

const ARCHIVES = 'https://www.sec.gov/Archives/edgar/data/123456/000012345624000001';

function docFrom(html: string): Document {
  return new DOMParser().parseFromString(html, 'text/html');
}

const BODY = (s: string) => `<p>${s}</p>`;
const LOREM =
  'The Company continued to execute on its strategy during the period, and ' +
  'management believes the results reflect underlying operating trends. ';

interface Fixture {
  name: string;
  url: string;
  html: string;
  filingType: FilingType;
  category: PageCategory;
  minSections: number;
  sectionIdIncludes?: string;
  companyName?: RegExp;
}

const FIXTURES: Fixture[] = [
  {
    name: '10-K (XBRL dei)',
    url: `${ARCHIVES}/acme-10k.htm`,
    filingType: '10-K',
    category: 'edgar_filing',
    minSections: 3,
    sectionIdIncludes: 'item_1a_risk_factors',
    companyName: /Acme Industries/,
    html: `<!doctype html><html><head><title>Acme Industries, Inc. 2023 Form 10-K</title></head><body>
      <div>
        <span name="dei:DocumentType">10-K</span>
        <span name="dei:EntityRegistrantName">Acme Industries, Inc.</span>
        <span name="dei:TradingSymbol">ACME</span>
      </div>
      <h1>ANNUAL REPORT ON FORM 10-K</h1>
      <h2>ITEM 1. BUSINESS</h2>${BODY('Acme designs industrial widgets. ' + LOREM.repeat(2))}
      <h2>ITEM 1A. RISK FACTORS</h2>${BODY('Our business is subject to adverse litigation and regulatory risk. ' + LOREM.repeat(2))}
      <h2>ITEM 7. MANAGEMENT&rsquo;S DISCUSSION AND ANALYSIS</h2>${BODY('Revenue increased 12% to $1.2 billion. ' + LOREM.repeat(2))}
    </body></html>`,
  },
  {
    name: '10-Q (XBRL dei)',
    url: `${ARCHIVES}/acme-10q.htm`,
    filingType: '10-Q',
    category: 'edgar_filing',
    minSections: 2,
    sectionIdIncludes: 'item_2_mdna',
    companyName: /Acme/,
    html: `<!doctype html><html><head><title>Acme 10-Q</title></head><body>
      <span name="dei:DocumentType">10-Q</span>
      <span name="dei:EntityRegistrantName">Acme Industries, Inc.</span>
      <h2>ITEM 1. FINANCIAL STATEMENTS</h2>${BODY(LOREM.repeat(2))}
      <h2>ITEM 2. MANAGEMENT&rsquo;S DISCUSSION AND ANALYSIS</h2>${BODY('Quarterly revenue grew 8%. ' + LOREM.repeat(2))}
    </body></html>`,
  },
  {
    name: '8-K (XBRL dei)',
    url: `${ARCHIVES}/acme-8k.htm`,
    filingType: '8-K',
    category: 'edgar_filing',
    minSections: 2,
    sectionIdIncludes: 'item_2_02_results_of_operations',
    companyName: /Acme/,
    html: `<!doctype html><html><head><title>Acme 8-K</title></head><body>
      <span name="dei:DocumentType">8-K</span>
      <span name="dei:EntityRegistrantName">Acme Industries, Inc.</span>
      <h2>ITEM 2.02. RESULTS OF OPERATIONS AND FINANCIAL CONDITION</h2>${BODY('Acme reported record quarterly results. ' + LOREM.repeat(2))}
      <h2>ITEM 7.01. REGULATION FD DISCLOSURE</h2>${BODY(LOREM.repeat(2))}
    </body></html>`,
  },
  {
    name: 'S-1 (title patterns, Archives URL)',
    url: `${ARCHIVES}/acme-s-1.htm`,
    filingType: 'S-1',
    category: 'edgar_filing',
    minSections: 2,
    sectionIdIncludes: 's1_risk_factors',
    companyName: /Acme Biosciences/,
    html: `<!doctype html><html><head><title>Acme Biosciences Prospectus</title></head><body>
      <h1>Acme Biosciences, Inc.</h1>
      <h2>PROSPECTUS SUMMARY</h2>${BODY('We are a clinical-stage biotech. ' + LOREM.repeat(2))}
      <h2>RISK FACTORS</h2>${BODY('Investing in our common stock involves a high degree of risk. ' + LOREM.repeat(2))}
      <h2>USE OF PROCEEDS</h2>${BODY('We intend to use the net proceeds for R&D. ' + LOREM.repeat(2))}
    </body></html>`,
  },
  {
    name: 'DEF 14A (title patterns, Archives URL)',
    url: `${ARCHIVES}/acme-def14a.htm`,
    filingType: 'DEF 14A',
    category: 'edgar_filing',
    minSections: 2,
    sectionIdIncludes: 'proxy_exec_compensation',
    companyName: /Acme/,
    html: `<!doctype html><html><head><title>Acme Proxy Statement</title></head><body>
      <h1>Acme Industries, Inc.</h1>
      <h2>NOTICE OF ANNUAL MEETING OF STOCKHOLDERS</h2>${BODY(LOREM.repeat(2))}
      <h2>PROPOSAL 1: ELECTION OF DIRECTORS</h2>${BODY('The board recommends a vote FOR each nominee. ' + LOREM.repeat(2))}
      <h2>EXECUTIVE COMPENSATION</h2>${BODY('The compensation committee oversees pay. ' + LOREM.repeat(2))}
    </body></html>`,
  },
  {
    name: 'inline-XBRL (contextref, viewer URL, no dei)',
    url: 'https://www.sec.gov/cgi-bin/viewer?action=view&type=10-K',
    filingType: '10-K',
    category: 'edgar_ixbrl',
    minSections: 2,
    sectionIdIncludes: 'item_1a_risk_factors',
    html: `<!doctype html><html><head><title>Inline XBRL Viewer</title></head><body>
      <h1>ANNUAL REPORT ON FORM 10-K</h1>
      <p>Reported revenue was <span contextref="C1">$1.2 billion</span> for the year.</p>
      <h2>ITEM 1. BUSINESS</h2>${BODY('We operate one reportable segment. ' + LOREM.repeat(2))}
      <h2>ITEM 1A. RISK FACTORS</h2>${BODY('Our results are subject to adverse macroeconomic conditions. ' + LOREM.repeat(2))}
    </body></html>`,
  },
  {
    name: 'EDGAR full-text search results (readable, not a filing)',
    url: 'https://efts.sec.gov/LATEST/search-index?q=acme',
    filingType: 'DATA_REPORT',
    category: 'sec_search',
    minSections: 1,
    html: `<!doctype html><html><head><title>EDGAR Full-Text Search</title></head><body>
      <h1>EDGAR Full-Text Search Results</h1>
      <h2>Results</h2>${BODY('Showing filings matching your query. ' + LOREM)}
    </body></html>`,
  },
];

describe('ingestDocument — supported page-type matrix', () => {
  for (const fx of FIXTURES) {
    describe(fx.name, () => {
      const { model } = ingestDocument({ document: docFrom(fx.html), url: fx.url });

      it(`classifies the page as ${fx.category}`, () => {
        expect(model.source.category).toBe(fx.category);
      });

      it(`detects filing type ${fx.filingType}`, () => {
        expect(model.filingType).toBe(fx.filingType);
      });

      it(`segments into at least ${fx.minSections} section(s)`, () => {
        expect(model.sections.length).toBeGreaterThanOrEqual(fx.minSections);
      });

      if (fx.sectionIdIncludes) {
        it(`includes section "${fx.sectionIdIncludes}"`, () => {
          expect(model.sections.map((s) => s.id)).toContain(fx.sectionIdIncludes);
        });
      }

      if (fx.companyName) {
        it('extracts a plausible company name', () => {
          expect(model.companyName ?? '').toMatch(fx.companyName!);
        });
      }
    });
  }
});
