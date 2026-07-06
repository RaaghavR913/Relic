// ============================================================
// Relic — PDF ingestion (text-only path)
// ------------------------------------------------------------
// A filing opened as a PDF renders inside Chrome's built-in PDF viewer, whose
// DOM exposes no extractable filing text — so the normal DOM walk
// (pickFilingRoot → buildNormalizedText → PositionMap) produces nothing.
//
// This module drives an alternate, DOM-less ingestion path:
//   1. detect the PDF viewer,
//   2. fetch the PDF's own bytes (same-origin under activeTab / file access),
//   3. hand them to the offscreen document for PDF.js text extraction (in
//      content/index.ts's runPdfFlow), and
//   4. build a text-based DocumentModel with a synthetic PositionMap.
//
// Everything downstream that keys off section TEXT — filing-type detection,
// segmentation, language flags, summaries, sentiment — then works unchanged. The
// synthetic PositionMap returns null DOM ranges, so on-page highlighting and the
// year-over-year redline (which need live DOM / EDGAR) are simply inert.
// ============================================================

import type {
  DocumentModel,
  IngestResult,
  PositionMap,
  Section,
  Segment,
} from '../../types/index.js';
import { cyrb53 } from '../../lib/hash.js';
import { detectFilingTypeWithConfidence } from './detect.js';
import { segmentSections } from './segment.js';
import { assessSegmentationConfidence } from '../segment.js';

/** Refuse absurdly large files: the bytes cross the message bus base64-encoded. */
export const MAX_PDF_BYTES = 25 * 1024 * 1024; // 25 MB

// ── detection ──────────────────────────────────────────────────────────────

/**
 * True when the current document is a PDF rendered by the browser's viewer.
 * `document.contentType` is the primary signal; the embed and URL checks are
 * fallbacks for viewers/versions that mask the content type from content scripts.
 */
export function isPdfDocument(doc: Document = document): boolean {
  try {
    if (doc.contentType === 'application/pdf') return true;
  } catch {
    /* contentType can throw in exotic sandboxes — fall through */
  }
  if (doc.querySelector('embed[type="application/pdf"], embed[name="plugin"]')) {
    return true;
  }
  try {
    const href = doc.location?.href ?? location.href;
    if (/\.pdf$/i.test(new URL(href).pathname)) return true;
  } catch {
    /* unparseable URL — not a PDF we can handle */
  }
  return false;
}

// ── byte fetch + transport encoding ──────────────────────────────────────────

/** Base64-encode an ArrayBuffer in chunks (avoids arg-count limits on large files). */
function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/**
 * Download the current PDF's bytes as an ArrayBuffer. The request is same-origin
 * to the tab (the tab URL *is* the PDF), so it works for any remote origin under
 * the activeTab grant, and for file:// pages once "Allow access to file URLs" is
 * enabled — no host-permission or CSP change.
 *
 * Uses XHR rather than fetch: fetch() frequently rejects file:// requests, while
 * XHR with file access resolves them reliably (a successful file:// read reports
 * HTTP status 0). XHR is equally fine for http(s).
 */
function downloadArrayBuffer(url: string): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('GET', url);
    xhr.responseType = 'arraybuffer';
    xhr.onload = () => {
      const ok = xhr.status === 0 || (xhr.status >= 200 && xhr.status < 300);
      if (ok && xhr.response) resolve(xhr.response as ArrayBuffer);
      else reject(new Error(`could not download PDF (HTTP ${xhr.status})`));
    };
    xhr.onerror = () => reject(new Error('could not download PDF (network error)'));
    xhr.send();
  });
}

/**
 * Download the current PDF and return its bytes base64-encoded for the message
 * bus (chrome.runtime messaging JSON-serializes payloads, so raw bytes can't be
 * transferred directly).
 */
export async function fetchPdfBase64(url: string): Promise<string> {
  const buf = await downloadArrayBuffer(url);
  if (buf.byteLength === 0) throw new Error('PDF is empty');
  if (buf.byteLength > MAX_PDF_BYTES) {
    throw new Error(
      `PDF is too large to analyze (${Math.round(buf.byteLength / 1_000_000)} MB; limit 25 MB)`,
    );
  }
  return arrayBufferToBase64(buf);
}

// ── synthetic, text-only PositionMap ─────────────────────────────────────────

/**
 * A PositionMap over plain extracted text with no backing DOM. `toDocRange`
 * (pure arithmetic) is all the flagging pass needs; every DOM-producing method
 * returns empty so on-page overlays paint nothing. This lets the existing
 * flag/summary/sentiment code run against a PDF unchanged.
 */
export class TextPositionMap implements PositionMap {
  readonly text: string;
  readonly segments: ReadonlyArray<Segment> = [];

  constructor(text: string) {
    this.text = text;
  }

  toDomRange(): Range | null {
    return null;
  }

  toClientRects(): DOMRect[] {
    return [];
  }

  fromNode(): number | null {
    return null;
  }

  fromPoint(): number | null {
    return null;
  }

  toDocRange(base: Section | number, range: [number, number]): [number, number] {
    const start = typeof base === 'number' ? base : base.charRange[0];
    return [start + range[0], start + range[1]];
  }

  rebuild(): PositionMap {
    return this;
  }
}

// ── cover-page metadata (text heuristics; no XBRL/DOM available) ──────────────

export interface PdfMeta {
  companyName?: string;
  ticker?: string;
  periodOfReport?: string; // ISO date
}

/**
 * Best-effort registrant/period/ticker from a filing PDF's cover page. Mirrors
 * the signals a 10-K/10-Q front page always carries; every field is optional so
 * a non-standard cover simply yields less metadata (never a wrong assertion).
 */
export function extractPdfMeta(text: string): PdfMeta {
  const head = text.slice(0, 6000);
  const meta: PdfMeta = {};

  // Registrant: the name printed immediately above "(Exact name of registrant …)".
  const reg = /([^\n]{2,90}?)\s*\n?\s*\(\s*Exact name of (?:the )?registrant\b/i.exec(head);
  const name = reg?.[1] ? cleanCompany(reg[1]) : undefined;
  if (name) meta.companyName = name;

  // Reporting period: "For the quarterly/fiscal year/transition period ended <date>".
  const period =
    /For the (?:quarterly|fiscal year|annual|transition)\s+period\s+ended\s+([A-Z][a-z]+\.?\s+\d{1,2},\s+\d{4})/i.exec(
      head,
    ) ?? /For the fiscal year ended\s+([A-Z][a-z]+\.?\s+\d{1,2},\s+\d{4})/i.exec(head);
  const iso = period?.[1] ? toIsoDate(period[1]) : undefined;
  if (iso) meta.periodOfReport = iso;

  // Trading symbol, when the cover lists one (post-2019 cover-page tagging).
  const ticker = /Trading Symbol\(s\)\s*\n?\s*([A-Z]{1,5})(?:\b|\n)/.exec(head);
  if (ticker?.[1]) meta.ticker = ticker[1];

  return meta;
}

/** Tidy a captured registrant string: collapse whitespace, drop trailing noise. */
function cleanCompany(raw: string): string | undefined {
  const s = raw.replace(/\s+/g, ' ').trim();
  // Guard against capturing a whole run-on line: keep it name-length.
  if (s.length < 2 || s.length > 80) return undefined;
  return s;
}

/** "April 26, 2026" → "2026-04-26"; returns undefined if unparseable. */
function toIsoDate(human: string): string | undefined {
  const t = Date.parse(human);
  if (Number.isNaN(t)) return undefined;
  return new Date(t).toISOString().slice(0, 10);
}

// ── ingestion ─────────────────────────────────────────────────────────────

/**
 * Build a DocumentModel from PDF-extracted text. Reuses the exact text-based
 * detection + segmentation + confidence assessment as the DOM path; only the
 * PositionMap (synthetic) and metadata source (cover-page regex vs. XBRL/DOM)
 * differ. `category: 'pdf'` marks it for PDF-aware UI gating.
 */
export function ingestPdfText(text: string, url: string): IngestResult {
  const positionMap = new TextPositionMap(text);

  const detection = detectFilingTypeWithConfidence({ text, url });
  const filingType = detection.type;

  const sections = segmentSections(text, { filingType, tableRanges: [] });
  const segmentationConfidence = assessSegmentationConfidence(sections, filingType);
  const meta = extractPdfMeta(text);

  const model: DocumentModel = {
    source: { url, host: 'ir', category: 'pdf' },
    ...(meta.ticker ? { ticker: meta.ticker } : {}),
    ...(meta.companyName ? { companyName: meta.companyName } : {}),
    filingType,
    filingTypeConfidence: detection.confidence,
    segmentationConfidence,
    ...(meta.periodOfReport ? { periodOfReport: meta.periodOfReport } : {}),
    sections,
    rawTextHash: cyrb53(text),
  };

  return { model, positionMap, tableRanges: [] };
}
