// ============================================================
// Relic — CSS Custom Highlight API controller + Session 1 dev demo.
// ------------------------------------------------------------
// Rendering contract (spec §5): overlays are painted with the CSS Custom Highlight API
// (ONE Highlight per overlay type, styled via ::highlight()), NEVER by wrapping ranges
// in spans. Interactive overlays use PositionMap.toClientRects() hit-zones.
//
// HighlightController owns one named Highlight per overlay type. Layer names:
//   demo, flag-{uncertainty|weak_modal|litigious|negative} (Session 5),
//   redline (Session 6), qa.
//
// Stacking: CSS Custom Highlight API paints in Highlight.priority order (higher = top).
//   demo(0) < flags(2) < redline(3) < qa(4)
// This ensures QA highlights win over everything else for the active answer range.
//
// demoHighlight(positionMap, substring, ...) proves multi-node mapping works: it finds a
// substring of positionMap.text, lifts it to a DOM Range that may span multiple text
// nodes (e.g. across an inline <b>/XBRL tag), and registers it under the 'demo' highlight.
// ============================================================

import type { PositionMap } from '@/types';

/**
 * Overlay layers, each rendered as a distinct CSS Custom Highlight.
 * Session 5 replaces the single 'flag' layer with four typed sub-layers so
 * each flag type gets a distinct underline pattern (WCAG AA: not colour alone).
 */
export type HighlightLayer =
  | 'demo'
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
 * Session 5 flags use priority 2 so a flagged phrase stays visible under the
 * redline and QA layers.
 */
export const LAYER_PRIORITY: Record<HighlightLayer, number> = {
  demo:               0,
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
// Session 5 flag layers use FOUR different text-decoration-style values:
//   uncertainty  → dashed  (amber tint)
//   weak_modal   → dotted  (sky tint)
//   litigious    → double  (red tint)
//   negative     → wavy    (rose tint)
// These underline styles remain distinguishable in greyscale and for colour-blind users.
const LAYER_CSS: Record<HighlightLayer, string> = {
  demo:
    'background-color: rgba(255, 213, 0, 0.45); color: inherit; text-decoration: underline dotted;',
  // ── Session 5 flag types ─────────────────────────────────────────────────
  'flag-uncertainty':
    'background-color: rgba(245, 158, 11, 0.44); color: inherit; text-decoration: underline dashed; text-decoration-thickness: 2px; text-underline-offset: 2px;',
  'flag-weak_modal':
    'background-color: rgba(14, 165, 233, 0.40); color: inherit; text-decoration: underline dotted; text-decoration-thickness: 2px; text-underline-offset: 2px;',
  'flag-litigious':
    'background-color: rgba(239, 68, 68, 0.42); color: inherit; text-decoration: underline double; text-decoration-thickness: 2px; text-underline-offset: 2px;',
  'flag-negative':
    'background-color: rgba(244, 63, 94, 0.40); color: inherit; text-decoration: underline wavy; text-decoration-thickness: 2px; text-underline-offset: 2px;',
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
