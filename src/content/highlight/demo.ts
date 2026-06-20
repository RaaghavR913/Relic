// ============================================================
// Disclora — CSS Custom Highlight API controller + Session 1 dev demo.
// ------------------------------------------------------------
// Rendering contract (spec §5): overlays are painted with the CSS Custom Highlight API
// (ONE Highlight per overlay type, styled via ::highlight()), NEVER by wrapping ranges
// in spans. Interactive overlays use PositionMap.toClientRects() hit-zones.
//
// HighlightController owns one named Highlight per overlay type. Layer names:
//   demo, sentiment (Session 4), flag-{uncertainty|weak_modal|litigious|negative}
//   (Session 5), redline (Session 6), qa.
//
// Stacking: CSS Custom Highlight API paints in Highlight.priority order (higher = top).
//   demo(0) < sentiment(1) < flags(2) < redline(3) < qa(4)
// This ensures flag markers are visible above the sentiment heatmap and QA highlights
// win over everything else for the active answer range.
//
// demoHighlight(positionMap, substring, ...) proves multi-node mapping works: it finds a
// substring of positionMap.text, lifts it to a DOM Range that may span multiple text
// nodes (e.g. across an inline <b>/XBRL tag), and registers it under the 'demo' highlight.
// ============================================================

import type { PositionMap, SentenceSentiment } from '@/types';

/**
 * Session 4 sentiment sub-layers: 3 confidence-intensity buckets × 2 polarities + neutral.
 *
 * Score bucketing (score = FinBERT confidence):
 *   < 0.65  → tier 1 (low opacity)
 *   0.65–0.85 → tier 2 (medium opacity)
 *   ≥ 0.85  → tier 3 (high opacity)
 *
 * Non-colour cues (WCAG AA: not colour alone):
 *   positive → solid green underline
 *   negative → wavy red underline
 *   neutral  → no underline (confidence below threshold)
 */
export type SentimentHighlightLayer =
  | 'sent-pos-1'
  | 'sent-pos-2'
  | 'sent-pos-3'
  | 'sent-neg-1'
  | 'sent-neg-2'
  | 'sent-neg-3'
  | 'sent-neu';

/** All 7 sentiment layer names — used for bulk clear. */
export const SENTIMENT_LAYERS: SentimentHighlightLayer[] = [
  'sent-pos-1', 'sent-pos-2', 'sent-pos-3',
  'sent-neg-1', 'sent-neg-2', 'sent-neg-3',
  'sent-neu',
];

/**
 * Overlay layers, each rendered as a distinct CSS Custom Highlight.
 * Session 4 introduces 7 sentiment sub-layers for intensity bucketing.
 * Session 5 replaces the single 'flag' layer with four typed sub-layers so
 * each flag type gets a distinct underline pattern (WCAG AA: not colour alone).
 */
export type HighlightLayer =
  | 'demo'
  | 'sentiment'
  | SentimentHighlightLayer
  | 'flag-uncertainty'
  | 'flag-weak_modal'
  | 'flag-litigious'
  | 'flag-negative'
  | 'redline'
  | 'qa';

const HIGHLIGHT_PREFIX = 'fl-';

/**
 * Stacking priority per layer. CSS Custom Highlight API paints higher-priority
 * highlights on top of lower-priority ones when ranges overlap (spec §4.2).
 * Session 4 sentiment sub-layers use priority 1; Session 5 flags use priority 2
 * so a flagged phrase is always visible even when a sentiment colour is also present.
 */
export const LAYER_PRIORITY: Record<HighlightLayer, number> = {
  demo:               0,
  sentiment:          1,
  'sent-pos-1':       1,
  'sent-pos-2':       1,
  'sent-pos-3':       1,
  'sent-neg-1':       1,
  'sent-neg-2':       1,
  'sent-neg-3':       1,
  'sent-neu':         1,
  'flag-uncertainty': 2,
  'flag-weak_modal':  2,
  'flag-litigious':   2,
  'flag-negative':    2,
  redline:            3,
  qa:                 4,
};

// WCAG AA compliance: every layer pairs a background fill with a non-colour cue
// (distinct underline style OR outline) so overlays NEVER rely on colour alone.
// `color: inherit` preserves the page's text contrast.
//
// Session 4 sentiment sub-layers:
//   positive (3 tiers) → solid green underline, increasing opacity
//   negative (3 tiers) → wavy red underline, increasing opacity
//   neutral             → subtle grey, no underline
//
// Session 5 flag layers use FOUR different text-decoration-style values:
//   uncertainty  → dashed  (amber tint)
//   weak_modal   → dotted  (sky tint)
//   litigious    → double  (red tint)
//   negative     → wavy    (rose tint)
// These underline styles remain distinguishable in greyscale and for colour-blind users.
const LAYER_CSS: Record<HighlightLayer, string> = {
  demo:
    'background-color: rgba(255, 213, 0, 0.45); color: inherit; text-decoration: underline dotted;',
  // Legacy single-layer sentinel — not used for rendering in Session 4+.
  sentiment:
    'background-color: rgba(99, 179, 237, 0.08); color: inherit;',
  // ── Session 4: positive (solid underline, 3 intensity tiers) ─────────────
  'sent-pos-1':
    'background-color: rgba(34,197,94,0.10); color: inherit; text-decoration-line: underline; text-decoration-style: solid; text-decoration-color: rgba(34,197,94,0.45);',
  'sent-pos-2':
    'background-color: rgba(34,197,94,0.20); color: inherit; text-decoration-line: underline; text-decoration-style: solid; text-decoration-color: rgba(34,197,94,0.65);',
  'sent-pos-3':
    'background-color: rgba(34,197,94,0.32); color: inherit; text-decoration-line: underline; text-decoration-style: solid; text-decoration-color: rgba(34,197,94,0.90);',
  // ── Session 4: negative (wavy underline, 3 intensity tiers) ──────────────
  'sent-neg-1':
    'background-color: rgba(239,68,68,0.10); color: inherit; text-decoration-line: underline; text-decoration-style: wavy; text-decoration-color: rgba(239,68,68,0.45);',
  'sent-neg-2':
    'background-color: rgba(239,68,68,0.20); color: inherit; text-decoration-line: underline; text-decoration-style: wavy; text-decoration-color: rgba(239,68,68,0.65);',
  'sent-neg-3':
    'background-color: rgba(239,68,68,0.32); color: inherit; text-decoration-line: underline; text-decoration-style: wavy; text-decoration-color: rgba(239,68,68,0.90);',
  // ── Session 4: neutral (subtle grey, no underline) ───────────────────────
  'sent-neu':
    'background-color: rgba(161,161,170,0.08); color: inherit;',
  // ── Session 5 flag types ─────────────────────────────────────────────────
  'flag-uncertainty':
    'background-color: rgba(245, 158, 11, 0.22); color: inherit; text-decoration: underline dashed;',
  'flag-weak_modal':
    'background-color: rgba(14, 165, 233, 0.18); color: inherit; text-decoration: underline dotted;',
  'flag-litigious':
    'background-color: rgba(239, 68, 68, 0.22); color: inherit; text-decoration: underline double;',
  'flag-negative':
    'background-color: rgba(244, 63, 94, 0.20); color: inherit; text-decoration: underline wavy;',
  redline:
    'background-color: rgba(72, 187, 120, 0.28); color: inherit;',
  qa:
    'background-color: rgba(159, 122, 234, 0.30); color: inherit; outline: 1px solid rgba(159,122,234,0.6);',
};

function highlightCss(): string {
  return (Object.keys(LAYER_CSS) as HighlightLayer[])
    .map((layer) => `::highlight(${HIGHLIGHT_PREFIX}${layer}) { ${LAYER_CSS[layer]} }`)
    .join('\n');
}

/** True if the CSS Custom Highlight API is available in this document context. */
export function highlightApiAvailable(): boolean {
  return typeof CSS !== 'undefined' && 'highlights' in CSS && typeof Highlight !== 'undefined';
}

/**
 * Owns the CSS Custom Highlights for a given Document (top page or filing iframe).
 * One Highlight object per layer; setRanges replaces a layer's ranges wholesale.
 * Highlight.priority is set from LAYER_PRIORITY so overlapping layers composite correctly.
 */
export class HighlightController {
  private doc: Document;
  private highlights = new Map<HighlightLayer, Highlight>();
  private stylesInjected = false;

  constructor(doc: Document) {
    this.doc = doc;
  }

  private ensureStyles(): void {
    if (this.stylesInjected) return;
    const existing = this.doc.getElementById('fl-highlight-css');
    if (!existing) {
      const style = this.doc.createElement('style');
      style.id = 'fl-highlight-css';
      style.textContent = highlightCss();
      (this.doc.head ?? this.doc.documentElement).appendChild(style);
    }
    this.stylesInjected = true;
  }

  /** Replace all ranges for a layer. Empty array clears the layer. */
  setRanges(layer: HighlightLayer, ranges: Range[]): void {
    if (!highlightApiAvailable()) return;
    this.ensureStyles();
    const name = `${HIGHLIGHT_PREFIX}${layer}`;
    if (ranges.length === 0) {
      CSS.highlights.delete(name);
      this.highlights.delete(layer);
      return;
    }
    const hl = new Highlight(...ranges);
    // Priority controls paint order when highlights overlap. Higher = on top.
    hl.priority = LAYER_PRIORITY[layer];
    CSS.highlights.set(name, hl);
    this.highlights.set(layer, hl);
  }

  /**
   * Add ranges to an existing layer without replacing previous ones.
   * Uses Highlight.add() for zero-copy progressive updates.
   * Preferred for Session 4 sentiment highlights that arrive section-by-section.
   */
  addRanges(layer: HighlightLayer, ranges: Range[]): void {
    if (!highlightApiAvailable() || ranges.length === 0) return;
    this.ensureStyles();
    const name = `${HIGHLIGHT_PREFIX}${layer}`;
    const existing = this.highlights.get(layer);
    if (existing) {
      for (const r of ranges) existing.add(r);
    } else {
      const hl = new Highlight(...ranges);
      hl.priority = LAYER_PRIORITY[layer];
      CSS.highlights.set(name, hl);
      this.highlights.set(layer, hl);
    }
  }

  /** Clear one layer, or all layers when no argument is given. */
  clear(layer?: HighlightLayer): void {
    if (!highlightApiAvailable()) return;
    if (layer) {
      CSS.highlights.delete(`${HIGHLIGHT_PREFIX}${layer}`);
      this.highlights.delete(layer);
      return;
    }
    for (const l of this.highlights.keys()) {
      CSS.highlights.delete(`${HIGHLIGHT_PREFIX}${l}`);
    }
    this.highlights.clear();
  }
}

// ── Session 4: sentiment highlight helpers ────────────────────────────────────

/**
 * Map a sentiment result to the correct CSS highlight layer based on label and
 * confidence score.
 *
 * Score buckets (aligned with LAYER_CSS intensity tiers):
 *   score < 0.65   → tier 1 (low)
 *   0.65 ≤ score < 0.85 → tier 2 (medium)
 *   score ≥ 0.85   → tier 3 (high)
 */
export function getSentimentLayer(
  label: 'positive' | 'negative' | 'neutral',
  score: number,
): SentimentHighlightLayer {
  if (label === 'neutral') return 'sent-neu';
  const tier = score >= 0.85 ? 3 : score >= 0.65 ? 2 : 1;
  const pole = label === 'positive' ? 'pos' : 'neg';
  return `sent-${pole}-${tier}` as SentimentHighlightLayer;
}

/**
 * Progressively add sentiment highlight ranges to the filing.
 * Calls addRanges() per layer so section-by-section updates do not flicker.
 * Results must carry DOCUMENT-space `range` values.
 * Respects prefers-reduced-motion by using static CSS (no JS animations).
 */
export function applySentimentHighlights(
  positionMap: PositionMap,
  controller: HighlightController,
  results: SentenceSentiment[],
): void {
  const grouped = new Map<SentimentHighlightLayer, Range[]>();

  for (const sent of results) {
    const domRange = positionMap.toDomRange(sent.range);
    if (!domRange) continue;
    const layer = getSentimentLayer(sent.label, sent.score);
    const arr = grouped.get(layer);
    if (arr) {
      arr.push(domRange);
    } else {
      grouped.set(layer, [domRange]);
    }
  }

  for (const [layer, ranges] of grouped) {
    controller.addRanges(layer, ranges);
  }
}

/** Clear all 7 sentiment highlight layers at once. */
export function clearSentimentLayers(controller: HighlightController): void {
  for (const layer of SENTIMENT_LAYERS) {
    controller.clear(layer);
  }
}

// ── dev demo ────────────────────────────────────────────────────────────────

export interface DemoResult {
  /** Whether the substring was found and a DOM Range produced. */
  ok: boolean;
  /** [start, end) document-space offsets of the matched substring (if found). */
  range: [number, number] | null;
  /** True when start and end live in different text nodes (proves multi-node mapping). */
  multiNode: boolean;
  /** Number of client rects the range produced (>1 ⇒ wraps across lines/nodes). */
  rectCount: number;
  message: string;
}

/**
 * Find `substring` in positionMap.text, lift it to a (possibly multi-node) DOM Range,
 * and paint it via the 'demo' highlight layer. Returns diagnostics proving the mapping.
 */
export function demoHighlight(
  positionMap: PositionMap,
  substring: string,
  _doc: Document,
  controller: HighlightController,
): DemoResult {
  const needle = substring.trim();
  if (!needle) {
    return { ok: false, range: null, multiNode: false, rectCount: 0, message: 'empty substring' };
  }

  const start = positionMap.text.indexOf(needle);
  if (start < 0) {
    return {
      ok: false,
      range: null,
      multiNode: false,
      rectCount: 0,
      message: `substring not found in document text`,
    };
  }
  const range: [number, number] = [start, start + needle.length];

  const domRange = positionMap.toDomRange(range);
  if (!domRange) {
    return { ok: false, range, multiNode: false, rectCount: 0, message: 'toDomRange returned null' };
  }

  controller.setRanges('demo', [domRange]);

  const multiNode = domRange.startContainer !== domRange.endContainer;
  const rectCount = positionMap.toClientRects(range).length;

  return {
    ok: true,
    range,
    multiNode,
    rectCount,
    message: `highlighted [${range[0]},${range[1]}] — ${multiNode ? 'multi-node ✓' : 'single node'}, ${rectCount} rect(s)`,
  };
}
