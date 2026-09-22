// ============================================================
// Relic — export metadata (PDF Info dictionary + XMP sidecar)
// ------------------------------------------------------------
// Every exported report carries two machine-readable identity layers, stamped
// onto the jsPDF document just before it is written out:
//
//   1. The PDF Info dictionary (/Title /Subject /Author /Creator /Keywords) —
//      what Preview, Acrobat, Spotlight and Windows Search show and index. Until
//      now an export's only Info entries were jsPDF's own /Producer and
//      /CreationDate, so a library of them was indistinguishable to the OS.
//   2. A raw XMP packet in Relic's own namespace carrying `relic:payload`: the
//      structured analysis as JSON. A reader (Relic Desktop) recovers exact data
//      instead of re-parsing rendered prose, and never drifts when the PDF
//      layout changes.
//
// Neither layer changes a single rendered pixel, and neither touches the
// network — the payload is built from artifacts already in hand.
//
// ── the packet, exactly ──────────────────────────────────────────────────────
//
//   <?xpacket begin="<BOM>" id="W5M0MpCehiHzreSzNTczkc9d"?>
//   <x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="Relic v3.1.7">
//    <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
//     <rdf:Description rdf:about="" xmlns:relic="https://relic.app/ns/1.0/">
//      <relic:schema>1</relic:schema>
//      <relic:ticker>MU</relic:ticker>          ...flat scalars, for any XMP tool
//      <relic:filing-type>10-Q</relic:filing-type>
//      <relic:payload>{"schema":1,...}</relic:payload>   ...XML-escaped JSON
//     </rdf:Description>
//    </rdf:RDF>
//   </x:xmpmeta>
//   <?xpacket end="r"?>
//
// A reader wanting the full object takes the text of `relic:payload`, unescapes
// the five XML entities, and JSON.parses it. A reader wanting only identity can
// read the flat scalars without a JSON parser at all.
//
// Pure: no chrome.*, no DOM, no network. jsPDF is touched only through the two
// public APIs it documents (setProperties / addMetadata).
// ============================================================

import type { jsPDF } from 'jspdf';
import type { DocumentModel, FilingAnalysis, XbrlFundamentals } from '@/types';
import { type FilingExportData, clean } from './report';

/** Relic's XMP namespace URI. Trailing slash per the XMP spec. */
export const RELIC_XMP_NS = 'https://relic.app/ns/1.0/';

/** Bump when the payload shape changes in a way a reader must notice. */
export const RELIC_SIDECAR_SCHEMA = 1;

/**
 * Ceiling on the serialized payload, in bytes.
 *
 * jsPDF writes the metadata stream uncompressed and unfiltered, so whatever
 * goes in here is added verbatim to every export. A typical payload is 20–60 KB;
 * this leaves generous headroom while making it impossible for a pathological
 * analysis to turn a 110 KB report into a multi-megabyte one. Over the cap, the
 * analysis is dropped and `omitted` says so — identity always survives.
 */
export const MAX_SIDECAR_BYTES = 512 * 1024;

// ── payload shape (the contract a reader codes against) ──────────────────────

/** One section as an index entry — its bounds, never its text. */
export interface SidecarSection {
  id: string;
  label: string;
  order: number;
  /** Offsets into the normalized document text (DOCUMENT space). */
  charRange: [number, number];
  /** Length of the section's text, so a reader can sanity-check its own extraction. */
  chars: number;
  incorporatedByReference?: true;
}

/**
 * Document identity and structure.
 *
 * Deliberately NOT `DocumentModel` itself: that carries `sections[].text`, i.e.
 * the entire filing, which would add hundreds of KB to every PDF to restate
 * text the PDF's own text layer (and the source URL) already hold. Everything
 * here is the part a reader cannot cheaply recompute.
 */
export interface SidecarDoc {
  source: DocumentModel['source'];
  ticker?: string;
  companyName?: string;
  filingType: DocumentModel['filingType'];
  filingTypeConfidence?: DocumentModel['filingTypeConfidence'];
  segmentationConfidence?: DocumentModel['segmentationConfidence'];
  sectionSource?: DocumentModel['sectionSource'];
  periodOfReport?: string;
  filedAt?: string;
  /** The extension's cache key for this document — a stable content identity. */
  rawTextHash: string;
  sections: SidecarSection[];
  /** Deterministic us-gaap/dei facts. Exact, not model output, and small. */
  xbrl?: XbrlFundamentals;
}

/**
 * The `relic:payload` object.
 *
 * Section summaries, per-sentence sentiment and the redline are intentionally
 * absent: the first two are unbounded (a 10-K runs to thousands of scored
 * sentences) and all three are rendered as prose in the report itself, so a
 * reader recovers them from the text layer. The analysis is the part that is
 * lossy to re-parse, so it is the part carried verbatim.
 */
export interface RelicSidecar {
  schema: typeof RELIC_SIDECAR_SCHEMA;
  /** Extension version that produced the export. */
  appVersion: string;
  /** ms epoch. */
  generatedAt: number;
  doc: SidecarDoc;
  analysis: FilingAnalysis | null;
  /** Present only when the payload was trimmed to stay under MAX_SIDECAR_BYTES. */
  omitted?: 'analysis';
}

// ── builders ─────────────────────────────────────────────────────────────────

/** Gather the structured payload from the artifacts the report was built from. */
export function buildSidecar(data: FilingExportData): RelicSidecar {
  const { doc } = data;
  return {
    schema: RELIC_SIDECAR_SCHEMA,
    appVersion: data.appVersion,
    generatedAt: data.generatedAt,
    doc: {
      source: doc.source,
      ...(doc.ticker ? { ticker: doc.ticker } : {}),
      ...(doc.companyName ? { companyName: doc.companyName } : {}),
      filingType: doc.filingType,
      ...(doc.filingTypeConfidence ? { filingTypeConfidence: doc.filingTypeConfidence } : {}),
      ...(doc.segmentationConfidence ? { segmentationConfidence: doc.segmentationConfidence } : {}),
      ...(doc.sectionSource ? { sectionSource: doc.sectionSource } : {}),
      ...(doc.periodOfReport ? { periodOfReport: doc.periodOfReport } : {}),
      ...(doc.filedAt ? { filedAt: doc.filedAt } : {}),
      rawTextHash: doc.rawTextHash,
      sections: doc.sections.map((s) => ({
        id: s.id,
        label: s.label,
        order: s.order,
        charRange: s.charRange,
        chars: s.text.length,
        ...(s.incorporatedByReference ? { incorporatedByReference: true as const } : {}),
      })),
      ...(doc.xbrl ? { xbrl: doc.xbrl } : {}),
    },
    analysis: data.analysis,
  };
}

function byteLength(s: string): number {
  return new TextEncoder().encode(s).length;
}

/** Serialize the payload, degrading to identity-only if it breaches the cap. */
export function serializeSidecar(sidecar: RelicSidecar): string {
  const full = JSON.stringify(sidecar);
  if (byteLength(full) <= MAX_SIDECAR_BYTES) return full;
  return JSON.stringify({ ...sidecar, analysis: null, omitted: 'analysis' } satisfies RelicSidecar);
}

// ── Info dictionary ──────────────────────────────────────────────────────────

/** jsPDF writes Info values as PDF literal strings, so keep them CP1252-safe. */
function infoValue(s: string, max = 220): string {
  const folded = clean(s);
  return folded.length > max ? `${folded.slice(0, max - 3).trimEnd()}...` : folded;
}

/**
 * The five keys jsPDF's Info dictionary supports. Anything else it ignores.
 *
 * `keywords` is a `;`-joined `key=value` list rather than prose because that is
 * what survives Spotlight and Windows Search intact, and what lets a reader
 * recover identity from a PDF whose XMP was stripped by an intermediary tool.
 */
export function buildInfoProperties(data: FilingExportData): {
  title: string;
  subject: string;
  author: string;
  keywords: string;
  creator: string;
} {
  const { doc } = data;
  const period = doc.periodOfReport ? doc.periodOfReport.slice(0, 10) : '';
  const name = doc.companyName ?? 'Filing';
  const title = [
    `${name}${doc.ticker ? ` (${doc.ticker})` : ''}`,
    doc.filingType,
    period,
  ].filter(Boolean).join(' - ');

  return {
    title: infoValue(title),
    subject: infoValue(`Relic on-device analysis of ${doc.filingType}`),
    author: 'Relic',
    keywords: [
      'relic',
      doc.ticker && `ticker=${doc.ticker}`,
      `form=${doc.filingType}`,
      period && `period=${period}`,
      doc.source.cik && `cik=${doc.source.cik}`,
      doc.source.accessionNo && `accession=${doc.source.accessionNo}`,
    ].filter(Boolean).map((k) => infoValue(String(k), 80)).join(';'),
    creator: infoValue(`Relic v${data.appVersion}`),
  };
}

// ── XMP packet ───────────────────────────────────────────────────────────────

/**
 * Escape the five XML entities.
 *
 * Only reached with `JSON.stringify` output and short scalar fields. JSON
 * escapes every C0 control character as `\uXXXX` and every lone surrogate, so
 * the result cannot contain a codepoint that is illegal in XML 1.0 — this
 * handles the rest.
 */
export function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * One `relic:*` scalar element.
 *
 * Property names are lowercase and hyphenated because PDF.js — the reader Relic
 * Desktop uses — lowercases every XMP property name when it builds its metadata
 * map. A camelCase `relic:filingType` is written faithfully but only readable
 * back as `relic:filingtype`, and a lookup under the name as written returns
 * null. Keeping the written name and the retrievable key identical removes that
 * trap. (Verified against pdfjs-dist legacy, the build Relic already ships.)
 */
function el(name: string, value: string | number | boolean | undefined): string {
  if (value === undefined || value === '') return '';
  return `\n   <relic:${name}>${escapeXml(String(value))}</relic:${name}>`;
}

/**
 * Build the complete XMP packet, passed to jsPDF verbatim (`rawXml = true`).
 *
 * Raw mode rather than jsPDF's namespace mode on purpose: that path nests the
 * blob inside a `jspdf:metadata` element in a namespace Relic does not own, and
 * escapes whatever it is handed — so a caller that escapes its own payload (as
 * the original sketch of this feature did) double-escapes it. Owning the packet
 * keeps `relic:payload` addressable by name and escaped exactly once.
 */
export function buildXmpPacket(data: FilingExportData): string {
  const { doc } = data;
  const payload = serializeSidecar(buildSidecar(data));
  // Lowercase, hyphenated names on purpose — see the note above `el`.
  const scalars = [
    el('schema', RELIC_SIDECAR_SCHEMA),
    el('app-version', data.appVersion),
    el('generated-at', new Date(data.generatedAt).toISOString()),
    el('company-name', doc.companyName),
    el('ticker', doc.ticker),
    el('filing-type', doc.filingType),
    el('period-of-report', doc.periodOfReport?.slice(0, 10)),
    el('filed-at', doc.filedAt?.slice(0, 10)),
    el('cik', doc.source.cik),
    el('accession-no', doc.source.accessionNo),
    el('source-url', doc.source.url),
    el('sections', doc.sections.length),
    data.analysis ? el('overall-read', data.analysis.overallRead) : '',
    data.analysis ? el('degraded', data.analysis.degraded) : '',
  ].join('');

  return (
        // The `begin` attribute is the UTF-8 BOM, per the XMP spec; written as an
// escape so no editor or linter can silently strip an invisible character.
    `<?xpacket begin="\uFEFF" id="W5M0MpCehiHzreSzNTczkc9d"?>\n` +
    `<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="Relic v${escapeXml(data.appVersion)}">\n` +
    ` <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">\n` +
    `  <rdf:Description rdf:about="" xmlns:relic="${RELIC_XMP_NS}">` +
    scalars +
    `\n   <relic:payload>${escapeXml(payload)}</relic:payload>\n` +
    `  </rdf:Description>\n` +
    ` </rdf:RDF>\n` +
    `</x:xmpmeta>\n` +
    `<?xpacket end="r"?>`
  );
}

// ── public API ───────────────────────────────────────────────────────────────

/** Stamp both metadata layers onto a rendered document. Call once, before output. */
export function stampExportMetadata(pdfDoc: jsPDF, data: FilingExportData): void {
  pdfDoc.setProperties(buildInfoProperties(data));
  pdfDoc.addMetadata(buildXmpPacket(data), true);
}
