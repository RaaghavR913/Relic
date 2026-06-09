// ============================================================
// FilingLens — canonical data model (source of truth)
// All other modules must import from here; never redefine locally.
// ============================================================

export type FilingType =
  | '10-K'
  | '10-Q'
  | '8-K'
  | '20-F'
  | 'S-1'
  | 'DEF 14A'
  | 'UNKNOWN';

export interface DocumentModel {
  source: {
    url: string;
    host: 'edgar' | 'ir';
    accessionNo?: string;
    cik?: string;
  };
  ticker?: string;
  companyName?: string;
  filingType: FilingType;
  /** Confidence of the filingType detection: 'high' (XBRL), 'medium' (URL), 'low' (text). */
  filingTypeConfidence?: 'high' | 'medium' | 'low';
  periodOfReport?: string; // ISO date
  filedAt?: string;        // ISO date
  sections: Section[];
  rawTextHash: string;     // cache key
}

export interface Section {
  id: string;              // canonical: 'item_1a_risk_factors', 'item_7_mdna', etc.
  label: string;
  order: number;
  text: string;            // normalized plain text
  htmlAnchor?: string;
  charRange: [number, number]; // offsets into normalized doc text (DOCUMENT space)
  /**
   * Table regions inside this section, as [start, end] offsets in DOCUMENT space
   * (offsets into PositionMap.text). Recorded here so later sentiment/flagging can
   * EXCLUDE tabular text. positionMap itself stays pure text<->DOM (Session 1 spec §4).
   */
  tables?: Array<[number, number]>;
}

export interface AnalysisArtifacts {
  summaries: Record<string /* sectionId */, { plain: string; analyst: string }>;
  sentiment: SentenceSentiment[];
  flags: LanguageFlag[];
  redline?: SectionDiff[];
  embeddings?: { chunkId: string; vector: Float32Array; sectionId: string }[];
}

export interface SentenceSentiment {
  sectionId: string;
  sentenceIdx: number;
  label: 'positive' | 'negative' | 'neutral';
  score: number;
  range: [number, number];
}

export interface LanguageFlag {
  type: 'uncertainty' | 'weak_modal' | 'litigious' | 'negative';
  range: [number, number];
  sectionId: string;
  term: string;
  note: string;
}

export interface SectionDiff {
  sectionId: string;
  added: DiffSpan[];
  removed: DiffSpan[];
  summary: string;
  magnitude: number;
}

export interface DiffSpan {
  text: string;
  range: [number, number];
}

// ── positionMap types ─────────────────────────────────────────────────────────

/**
 * One linear slice of the normalized document string.
 * Invariant (within a real segment): normPos − normStart === nodePos − nodeStart.
 * Synthetic segments (synthetic=true) hold structural whitespace (\n \n\n space)
 * with no direct DOM counterpart; their node field is null.
 */
export interface Segment {
  node: Text | null;   // null for synthetic structural whitespace
  nodeStart: number;   // byte offset in Text.data where this segment starts
  length: number;      // character count in normalized string
  normStart: number;   // byte offset in positionMap.text where this segment starts
  synthetic?: true;    // present+true for structural newlines / collapsed-space markers
}

/** Result of buildNormalizedText / buildPositionMap. */
export interface BuildResult {
  positionMap: PositionMap;
  /** [start, end) char ranges in positionMap.text that cover TABLE elements.
   *  Used by later sessions to exclude table content from sentence-level analysis. */
  tableRanges: ReadonlyArray<[number, number]>;
}

/**
 * Critical shared artifact produced by Session 1.
 * Every overlay (sentiment, flags, redline, Q&A deep-links) uses this to convert
 * [charStart, charEnd) ranges in positionMap.text into live DOM Ranges / DOMRects —
 * without ever wrapping nodes in spans.
 */
export interface PositionMap {
  /** The canonical normalized document string (single source of truth for offsets). */
  readonly text: string;
  /** Ordered segments; use for diagnostics only — prefer the method API. */
  readonly segments: ReadonlyArray<Segment>;
  /** [normStart, normEnd) → live DOM Range spanning potentially multiple text nodes.
   *  Returns null if the range falls entirely within synthetic (structural) content. */
  toDomRange(range: [number, number]): Range | null;
  /** Convenience: toDomRange → getClientRects. Empty array on failure. */
  toClientRects(range: [number, number]): DOMRect[];
  /** DOM text node + intra-node offset → normalized position. Null if unmapped
   *  (e.g. discarded whitespace). */
  fromNode(node: Text, offset: number): number | null;
  /** Screen coordinate → normalized position via caretRangeFromPoint. */
  fromPoint(x: number, y: number): number | null;
  /**
   * Lift a section- or sentence-relative range into DOCUMENT space (offsets into
   * positionMap.text). `base` is either a Section (uses its charRange[0]) or a raw
   * base offset. Sentence sentiment / flag ranges are produced relative to a section's
   * text; this is the single sanctioned way to lift them before calling toDomRange.
   */
  toDocRange(base: Section | number, range: [number, number]): [number, number];
  /** Re-run the DFS over a new root and return a fresh PositionMap. */
  rebuild(root: Element | Document): PositionMap;
}

/** Result of a full ingestion pass: the data model plus the live PositionMap. */
export interface IngestResult {
  model: DocumentModel;
  positionMap: PositionMap;
  /** Table ranges (document space) discovered during the DOM walk, mirrored onto sections. */
  tableRanges: ReadonlyArray<[number, number]>;
}
