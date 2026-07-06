/**
 * PDF (text-only) ingestion path: detection, cover-page metadata, the synthetic
 * PositionMap, and the end-to-end text → DocumentModel build. These cover the
 * DOM-less path that makes a filing opened as a PDF analyzable (Summary / flags /
 * sentiment) without a live DOM. PDF.js parsing itself is exercised by the E2E
 * test, not here (it needs a real worker + binary PDF).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  isPdfDocument,
  extractPdfMeta,
  ingestPdfText,
  TextPositionMap,
} from '@/content/ingest/pdf';
import type { Section } from '@/types';

// A realistic 10-Q cover page (modeled on NVIDIA's, matching the screenshot).
const TEN_Q_COVER = [
  'UNITED STATES',
  'SECURITIES AND EXCHANGE COMMISSION',
  'Washington, D.C. 20549',
  'FORM 10-Q',
  'QUARTERLY REPORT PURSUANT TO SECTION 13 OR 15(d) OF THE SECURITIES EXCHANGE ACT OF 1934',
  'For the quarterly period ended April 26, 2026',
  'Commission File Number: 0-23985',
  'NVIDIA CORPORATION',
  '(Exact name of registrant as specified in its charter)',
  'Delaware',
  '94-3177549',
  'Trading Symbol(s)',
  'NVDA',
  'Item 2. Management’s Discussion and Analysis of Financial Condition',
  'Revenue increased significantly during the period.',
].join('\n');

describe('isPdfDocument', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('detects the Chrome PDF viewer via document.contentType', () => {
    const doc = {
      contentType: 'application/pdf',
      querySelector: () => null,
      location: { href: 'https://cdn.example.com/x.bin' },
    } as unknown as Document;
    expect(isPdfDocument(doc)).toBe(true);
  });

  it('detects a PDF via the <embed> fallback when contentType is masked', () => {
    document.body.innerHTML = '<embed type="application/pdf" src="x">';
    expect(isPdfDocument(document)).toBe(true);
    document.body.innerHTML = '<embed name="plugin" src="x">';
    expect(isPdfDocument(document)).toBe(true);
  });

  it('detects a PDF via a .pdf URL path, ignoring case and query string', () => {
    const doc = {
      contentType: 'text/html',
      querySelector: () => null,
      location: { href: 'https://d18rn0p25nwr6d.cloudfront.net/CIK-1/927dc2d6.PDF?x=1#page=2' },
    } as unknown as Document;
    expect(isPdfDocument(doc)).toBe(true);
  });

  it('returns false for an ordinary HTML page', () => {
    const doc = {
      contentType: 'text/html',
      querySelector: () => null,
      location: { href: 'https://www.sec.gov/Archives/edgar/data/1/x.htm' },
    } as unknown as Document;
    expect(isPdfDocument(doc)).toBe(false);
  });
});

describe('extractPdfMeta', () => {
  it('pulls registrant, reporting period (ISO), and ticker from a 10-Q cover', () => {
    const meta = extractPdfMeta(TEN_Q_COVER);
    expect(meta.companyName).toBe('NVIDIA CORPORATION');
    expect(meta.periodOfReport).toBe('2026-04-26');
    expect(meta.ticker).toBe('NVDA');
  });

  it('parses a 10-K "fiscal year ended" period', () => {
    const cover =
      'FORM 10-K\nANNUAL REPORT\nFor the fiscal year ended December 31, 2025\n' +
      'ACME INDUSTRIES, INC.\n(Exact name of registrant as specified in its charter)';
    const meta = extractPdfMeta(cover);
    expect(meta.companyName).toBe('ACME INDUSTRIES, INC.');
    expect(meta.periodOfReport).toBe('2025-12-31');
  });

  it('returns nothing for text without a recognizable cover', () => {
    const meta = extractPdfMeta('Just some prose with no filing cover markers at all.');
    expect(meta.companyName).toBeUndefined();
    expect(meta.periodOfReport).toBeUndefined();
    expect(meta.ticker).toBeUndefined();
  });
});

describe('TextPositionMap (synthetic, DOM-less)', () => {
  const text = 'Hello world. This is a filing.';
  const map = new TextPositionMap(text);

  it('exposes the source text and never produces DOM ranges', () => {
    expect(map.text).toBe(text);
    expect(map.toDomRange()).toBeNull();
    expect(map.toClientRects()).toEqual([]);
    expect(map.fromNode()).toBeNull();
    expect(map.fromPoint()).toBeNull();
    expect(map.rebuild()).toBe(map);
  });

  it('lifts section-relative ranges to document space by arithmetic', () => {
    const section = { charRange: [100, 200] } as unknown as Section;
    expect(map.toDocRange(section, [5, 12])).toEqual([105, 112]);
    // A raw numeric base is also accepted.
    expect(map.toDocRange(40, [1, 3])).toEqual([41, 43]);
  });
});

describe('ingestPdfText', () => {
  it('builds a PDF-category DocumentModel with text-based detection + metadata', () => {
    const url = 'https://d18rn0p25nwr6d.cloudfront.net/CIK-1/927dc2d6.pdf';
    const { model, positionMap, tableRanges } = ingestPdfText(TEN_Q_COVER, url);

    expect(model.source.category).toBe('pdf');
    expect(model.source.host).toBe('ir');
    expect(model.source.url).toBe(url);
    expect(model.filingType).toBe('10-Q');
    expect(model.companyName).toBe('NVIDIA CORPORATION');
    expect(model.periodOfReport).toBe('2026-04-26');
    expect(model.ticker).toBe('NVDA');
    expect(model.rawTextHash).toBeTruthy();
    expect(model.sections.length).toBeGreaterThanOrEqual(1);

    // The synthetic map carries the full text and no XBRL is fabricated.
    expect(positionMap.text).toBe(TEN_Q_COVER);
    expect(positionMap.toDomRange([0, 1])).toBeNull();
    expect(tableRanges).toEqual([]);
    expect(model.xbrl).toBeUndefined();
  });
});
