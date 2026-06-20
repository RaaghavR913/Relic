// ============================================================
// Disclora — canonical data model (source of truth)
// All other modules must import from here; never redefine locally.
// ============================================================

export type FilingType =
  | '10-K'
  | '10-Q'
  | '8-K'
  | '20-F'
  | '6-K' // foreign private issuer interim report (often carries an earnings release)
  | 'S-1'
  | 'DEF 14A'
  | 'DATA_REPORT' // sec.gov data/research/info page — readable, but NOT a company filing
  | 'UNKNOWN';

/**
 * Coarse page taxonomy decided up-front from URL + DOM, BEFORE filing-type
 * detection. Every downstream decision (label, low-confidence demotion, tab
 * gating, summary register) keys off this — never off a re-derived host string.
 * This is the first-class fix for "all sec.gov pages are EDGAR filings".
 */
export type PageCategory =
  | 'edgar_filing' // /Archives/edgar/data/... or XBRL dei:* facts present
  | 'edgar_index' // EDGAR Filing Detail / accession index page (…-index.html) — a directory, not the document
  | 'edgar_ixbrl' // inline-XBRL viewer (ix: namespace / contextref present)
  | 'sec_search' // EDGAR full-text / browse-edgar search & company profile pages
  | 'sec_data_report' // www.sec.gov data-research / rules / info pages (readable, not a filing)
  | 'ir_or_financial' // off-sec.gov page that looks financial (earnings, IR)
  | 'unsupported';

export interface DocumentModel {
  source: {
    url: string;
    host: 'edgar' | 'ir';
    /**
     * Fine-grained page taxonomy (see PageCategory). Optional for back-compat
     * with persisted models; new ingests always populate it.
     */
    category?: PageCategory;
    accessionNo?: string;
    cik?: string;
  };
  ticker?: string;
  companyName?: string;
  filingType: FilingType;
  /** Confidence of the filingType detection: 'high' (XBRL), 'medium' (URL), 'low' (text). */
  filingTypeConfidence?: 'high' | 'medium' | 'low';
  /**
   * Confidence that the segmenter bounded the sections correctly: 'low' when the
   * structure looks mis-segmented (collapsed/empty focus sections). Drives the
   * low-confidence UI even on an authoritative EDGAR filing. Only set for filings
   * (left undefined for readable data/report pages).
   */
  segmentationConfidence?: 'high' | 'low';
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
  /**
   * Set on a load-bearing MD&A / operating-review section when its body is a short
   * "incorporated by reference" pointer (the real narrative lives in an exhibit or an
   * un-numbered block elsewhere), not the analysable prose. Downstream UI surfaces a
   * note instead of presenting the pointer text as analysis. See segment.ts
   * isMdnaByReference. (S2 carry-over: detection only, no narrative recovery.)
   */
  incorporatedByReference?: boolean;
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
  /**
   * True when the match sits inside a forward-looking / safe-harbor boilerplate
   * sentence (copied into nearly every filing). Such matches carry low marginal
   * signal and are hidden from the on-page overlay by default.
   */
  boilerplate?: boolean;
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

// ── investor analysis types (Analyst tab) ────────────────────────────────────

export type InsightLabel =
  | 'Bullish'
  | 'Bearish'
  | 'Mixed'
  | 'Neutral'
  | 'Watch Item'
  | 'Red Flag'
  | 'Quality Signal'
  | 'Weakness Signal'
  | 'Unclear';

export type InsightCategory =
  | 'Revenue'
  | 'Margins'
  | 'Cash Flow'
  | 'Balance Sheet'
  | 'Shares'
  | 'Risk'
  | 'Guidance'
  | 'Management Commentary'
  | 'Valuation'
  | 'Operations'
  | 'Legal/Regulatory'
  | 'Customer Demand';

export type Severity = 'Low' | 'Medium' | 'High';
export type TimeHorizon = 'Short-term' | 'Medium-term' | 'Long-term';
export type ConfidenceLevel = 'Low' | 'Medium' | 'High';
export type OverallRead = 'Bullish' | 'Bearish' | 'Mixed' | 'Neutral';
export type ScorePoint = 1 | 2 | 3 | 4 | 5;

/** Investor-facing document classification (broader than FilingType — covers IR pages). */
export type AnalysisDocumentType =
  | '10-K'
  | '10-Q'
  | '8-K'
  | 'Earnings Call'
  | 'Investor Presentation'
  | 'Income Statement'
  | 'Balance Sheet'
  | 'Cash Flow Statement'
  | 'Other';

/** One investor-relevant signal extracted from the document. */
export interface FilingInsight {
  label: InsightLabel;
  category: InsightCategory;
  title: string;
  summary: string;
  whyItMatters: string;
  investorMeaning: string;
  /** Short verbatim quote from the document. Present only when verified against source. */
  evidence?: string;
  /** DOCUMENT-space char range of the verified evidence quote (jump-to-source). */
  evidenceRange?: [number, number];
  severity: Severity;
  timeHorizon: TimeHorizon;
  confidence: ConfidenceLevel;
}

export interface NarrativeCheck {
  claim: string;
  evidence: string;
  assessment: 'Supported' | 'Partially Supported' | 'Not Supported' | 'Unclear';
  investorMeaning: string;
}

export interface WatchItem {
  item: string;
  whyItMatters: string;
  relatedMetric?: string;
}

/** 1 = weak, 5 = strong — except riskLevel where 1 = low risk, 5 = high risk. */
export interface AnalysisScores {
  revenueStrength: ScorePoint;
  marginQuality: ScorePoint;
  cashFlowQuality: ScorePoint;
  balanceSheetStrength: ScorePoint;
  riskLevel: ScorePoint;
  managementCredibility: ScorePoint;
  shareholderFriendliness: ScorePoint;
}

/** Pipeline stages, in execution order. The UI renders incrementally as stages land. */
export type AnalysisStage =
  | 'snapshot'
  | 'takeaways'
  | 'whatChanged'
  | 'revenue'
  | 'margins'
  | 'cashflow'
  | 'shares'
  | 'risks'
  | 'narrative'
  | 'synthesis';

export interface FilingAnalysis {
  documentType: AnalysisDocumentType;
  companyName?: string;
  ticker?: string;
  period?: string;

  overallRead: OverallRead;
  confidence: ConfidenceLevel;
  oneSentenceSummary: string;

  investorSnapshot: {
    mainFinancialTheme: string;
    timeHorizon: TimeHorizon;
    mostImportantInvestorQuestion: string;
  };

  topTakeaways: FilingInsight[];
  whatChanged: FilingInsight[];
  revenueImpact: FilingInsight[];
  marginImpact: FilingInsight[];
  cashFlowImpact: FilingInsight[];
  balanceSheetHealth: FilingInsight[];
  shareImpact: FilingInsight[];
  riskSignals: FilingInsight[];

  managementNarrativeCheck: NarrativeCheck[];

  bullCase: string[];
  bearCase: string[];
  /** Which side the document supports more, and why — without overstating certainty. */
  netRead: string;

  whatToWatchNext: WatchItem[];
  scores?: AnalysisScores;
  plainEnglishExplanation: string;

  /** Stages that completed successfully (LM or deterministic). */
  stagesDone: AnalysisStage[];
  /** True when generated without the Prompt API (extractive tier): deterministic signals only. */
  degraded: boolean;
  generatedAt: number;
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
 * Every overlay (sentiment, flags, redline, citation deep-links) uses this to convert
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
