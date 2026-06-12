/**
 * Page classification + readable-page ingestion tests (Bug 1 regression).
 *
 * The www.sec.gov data/research pages are readable documents but NOT company
 * filings. Before the fix they were forced through the EDGAR filing path and came
 * out as "Unknown company / S-1 / 1 section". These tests pin the corrected
 * behavior: a sec.gov data page classifies as `sec_data_report`, ingests as a
 * DATA_REPORT named by its H1, with heading-based sections — never an S-1.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { classifyPage } from '@/content/ingest/classify';
import { ingestDocument } from '@/content/ingest';
import { detectFilingType } from '@/content/ingest/detect';

const BDC_URL = 'https://www.sec.gov/data-research/sec-markets-data/opendatasetsshtmlbdc';

/** A reduced facsimile of the BDC data page: an H1, prose, and a data-fields table. */
const BDC_HTML = `
  <h1>Business Development Company Report</h1>
  <p>This data set provides structured information derived from filings submitted to
     EDGAR. It enumerates available report forms including 10-K, 10-Q, 8-K, and S-1
     submissions, and documents the fields exposed in each dataset.</p>
  <h2>Data Fields</h2>
  <table>
    <tr><th>Field</th><th>Description</th></tr>
    <tr><td>cik</td><td>Central Index Key of the registrant.</td></tr>
    <tr><td>period</td><td>Period of report covered by the dataset.</td></tr>
    <tr><td>form</td><td>The EDGAR form type associated with the row.</td></tr>
  </table>
  <h2>Download</h2>
  <p>The complete data set is available for download in compressed form, refreshed
     on a quarterly cadence aligned to filing deadlines.</p>
`;

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('classifyPage', () => {
  it('classifies a www.sec.gov data page as sec_data_report (not a filing)', () => {
    document.body.innerHTML = BDC_HTML;
    expect(classifyPage(document, BDC_URL)).toBe('sec_data_report');
  });

  it('classifies an EDGAR Archives filing URL as edgar_filing', () => {
    document.body.innerHTML = '<p>Some filing body text.</p>';
    const url =
      'https://www.sec.gov/Archives/edgar/data/320193/000032019323000106/aapl-20230930.htm';
    expect(classifyPage(document, url)).toBe('edgar_filing');
  });

  it('classifies a page carrying dei:* facts as edgar_filing regardless of path', () => {
    document.body.innerHTML =
      '<span name="dei:EntityRegistrantName">Acme Corp</span><p>body</p>';
    expect(classifyPage(document, 'https://www.sec.gov/some/info/page')).toBe('edgar_filing');
  });

  it('classifies the EDGAR browse/search page as sec_search', () => {
    document.body.innerHTML = '<p>search results</p>';
    expect(classifyPage(document, 'https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany')).toBe(
      'sec_search',
    );
  });

  it('classifies an off-sec.gov page as ir_or_financial', () => {
    document.body.innerHTML = '<p>Q4 earnings</p>';
    expect(classifyPage(document, 'https://investors.acme.com/news/q4')).toBe('ir_or_financial');
  });

  it('classifies non-web schemes, the Web Store, and unparseable URLs as unsupported', () => {
    document.body.innerHTML = '<p>n/a</p>';
    expect(classifyPage(document, 'chrome://extensions')).toBe('unsupported');
    expect(classifyPage(document, 'file:///Users/me/report.pdf')).toBe('unsupported');
    expect(classifyPage(document, 'https://chromewebstore.google.com/detail/x')).toBe('unsupported');
    expect(classifyPage(document, 'not a url')).toBe('unsupported');
  });
});

describe('ingestDocument on the BDC data page', () => {
  it('produces a DATA_REPORT named by H1 with heading sections — never S-1', () => {
    document.body.innerHTML = BDC_HTML;
    const { model } = ingestDocument({ document, url: BDC_URL });

    // The crux of the bug: must NOT be misdetected as an S-1 filing.
    expect(model.filingType).toBe('DATA_REPORT');
    expect(model.filingType).not.toBe('S-1');

    // Named by its heading, not "Unknown company".
    expect(model.companyName).toBe('Business Development Company Report');

    // Category recorded for downstream UI/gating.
    expect(model.source.category).toBe('sec_data_report');

    // Heading-based segmentation → more than the single misleading "Business" section.
    expect(model.sections.length).toBeGreaterThan(1);
    const labels = model.sections.map((s) => s.label);
    expect(labels).toContain('Data Fields');

    // No investor metadata is fabricated.
    expect(model.ticker).toBeUndefined();
    expect(model.periodOfReport).toBeUndefined();
  });

  it('still extracts the table text (tables are not dropped from extraction)', () => {
    document.body.innerHTML = BDC_HTML;
    const { positionMap, tableRanges } = ingestDocument({ document, url: BDC_URL });
    expect(positionMap.text).toContain('Central Index Key');
    expect(tableRanges.length).toBeGreaterThan(0);
  });
});

describe('S-1 heuristic tightening', () => {
  it('does not treat an incidental "S-1" form mention as an S-1 filing', () => {
    const text = 'This dataset covers forms 10-K, 10-Q, S-1, and 8-K submissions.';
    expect(detectFilingType({ text })).toBe('UNKNOWN');
  });

  it('still detects a genuine S-1 registration statement', () => {
    const text = 'REGISTRATION STATEMENT UNDER THE SECURITIES ACT OF 1933\nForm S-1';
    expect(detectFilingType({ text })).toBe('S-1');
  });
});
