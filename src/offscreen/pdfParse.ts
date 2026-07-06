// ============================================================
// Relic — offscreen PDF text extraction (PDF.js)
// ------------------------------------------------------------
// Runs inside the offscreen document (the extension's heavy-compute context).
// The content script fetches a PDF's bytes under activeTab and relays them here;
// we extract per-page text with PDF.js and return it for the text-only ingestion
// path (detect → segment → flag → summarize/sentiment).
//
// PRIVACY: PDF.js parses the ArrayBuffer entirely on-device. The only asset it
// loads is the bundled worker (chrome-extension:// URL, same-origin). No network.
//
// We use the `legacy` build so the worker runs on the extension's floor of
// minimum_chrome_version (116); the modern build assumes newer JS (e.g.
// Promise.withResolvers, Chrome 119+).
// ============================================================

import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
// Vite emits the worker as a hashed asset under dist/assets/ and gives us its
// runtime URL. It is loaded same-origin by the offscreen page, so it satisfies
// `script-src 'self'` and COEP require-corp without a web_accessible_resources entry.
import pdfWorkerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url';
import { debugLog } from '@/lib/debug';

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

export interface PdfText {
  /** All page texts joined with form-feed-ish double newlines, in page order. */
  text: string;
  /** Per-page extracted text, in page order. */
  pages: string[];
}

/**
 * Extract text from a PDF's raw bytes. Returns the joined document text plus the
 * per-page breakdown. Throws on a corrupt/encrypted PDF; a scanned (image-only)
 * PDF parses fine but yields little/no text — the caller decides how to surface
 * that (Relic shows a "couldn't extract text" state; OCR is out of scope).
 */
export async function parsePdf(bytes: Uint8Array): Promise<PdfText> {
  const loadingTask = pdfjsLib.getDocument({
    data: bytes,
    // Belt-and-suspenders: never phone home for fonts. Missing glyph maps only
    // affect exotic CJK/heuristics, not Latin-script filing text.
    disableFontFace: true,
  });

  const pdf = await loadingTask.promise;
  const pages: string[] = [];

  try {
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      // Join text items with spaces; PDF.js `hasEOL` marks line breaks.
      let pageText = '';
      for (const item of content.items) {
        // TextItem has `str`; TextMarkedContent (structure markers) does not.
        if ('str' in item) {
          pageText += item.str;
          if (item.hasEOL) pageText += '\n';
          else pageText += ' ';
        }
      }
      pages.push(pageText.replace(/[ \t]+\n/g, '\n').trim());
      // Release page resources as we go — large 10-Ks can be 100+ pages.
      page.cleanup();
    }
  } finally {
    // Tears down the document and its worker transport.
    await loadingTask.destroy();
  }

  const text = pages.join('\n\n');
  debugLog(`[Relic offscreen] parsed PDF: ${pages.length} pages, ${text.length} chars`);
  return { text, pages };
}

/** Decode a base64 string (relayed over runtime messaging) back into bytes. */
export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
