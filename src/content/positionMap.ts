/**
 * Relic positionMap — Session 1 linchpin.
 *
 * LIVE IMPLEMENTATION. src/content/ingest/position-map.ts (DomPositionMap) is a
 * thin class façade that delegates here; do not confuse the two or delete this.
 *
 * buildPositionMap(root) performs a single recursive DFS over the filing DOM,
 * producing:
 *   • positionMap.text  — one canonical normalized string
 *   • positionMap.segments — linear Segment[] mapping every char back to its
 *                            Text node + intra-node offset
 *   • tableRanges        — [start, end) ranges of TABLE elements in text
 *
 * Normalization rules (exact spec):
 *   • Block elements (P DIV LI UL OL TABLE TR TD TH SECTION ARTICLE H1-H6
 *     BLOCKQUOTE HR TBODY THEAD) → \n\n boundary entering AND leaving
 *   • BR → \n
 *   • \s and \u00A0 runs → single space (collapsed-whitespace boundary)
 *   • Skip: SCRIPT STYLE HEAD NOSCRIPT TEMPLATE SVG IX:HEADER
 *   • Skip: hidden / aria-hidden / display:none / visibility:hidden / <ix:hidden>
 *   • Include: ix:nonFraction / ix:nonNumeric text (treat as inline)
 *   • Trim leading/trailing whitespace from entire document (build-clean, no post-process)
 *
 * Segment invariant: within one segment, normPos − normStart === nodePos − nodeStart.
 * New segment starts at: each text node, each collapsed-WS boundary, each synthetic NL.
 *
 * positionMap API:
 *   toDomRange([a,b])     → live multi-node DOM Range  (binary-search over segments)
 *   toClientRects([a,b])  → DOMRect[] from range.getClientRects()
 *   fromNode(node,offset) → normPos  (indexed by Text node for O(k) lookup)
 *   fromPoint(x,y)        → normPos  via caretRangeFromPoint
 *   rebuild(root)         → new PositionMap
 */

import type { BuildResult, PositionMap, Segment } from '../types/index.js';
import { toDocRange as liftToDocRange } from '../lib/docRange.js';

// ── constants ─────────────────────────────────────────────────────────────────

const BLOCK_TAGS = new Set([
  'P', 'DIV', 'LI', 'UL', 'OL', 'TABLE', 'TR', 'TD', 'TH',
  'SECTION', 'ARTICLE', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
  'BLOCKQUOTE', 'HR', 'TBODY', 'THEAD',
]);

const SKIP_TAGS = new Set([
  'SCRIPT', 'STYLE', 'HEAD', 'NOSCRIPT', 'TEMPLATE', 'SVG',
  'IX:HEADER', 'IXHEADER',  // XBRL header metadata
]);

// ── internal state ────────────────────────────────────────────────────────────

interface BuildState {
  chars: string[];
  segs: Segment[];
  normPos: number;

  // Pending whitespace that hasn't been emitted yet (build-clean)
  pendingNL: 0 | 1 | 2;     // max pending newline level; 0 = none
  pendingSpace: boolean;     // need a single space before next non-WS char
  spaceNode: Text | null;    // source Text node for the pending space
  spaceNodeOff: number;      // offset in spaceNode for the pending space

  // Have we emitted any real (non-synthetic) character?  Used to trim leading WS.
  hasContent: boolean;

  // In-progress (open) segment — always from the currently-processing text node
  openNode: Text | null;
  openNodeStart: number;   // offset in Text.data where this seg started
  openNormStart: number;   // normPos when this seg started
  openLen: number;         // chars emitted into this seg so far

  // TABLE depth tracking
  tableDepth: number;
  tablePendStart: number;  // normPos at outermost TABLE entry (after pending NL)
  tableRanges: Array<[number, number]>;
}

// ── helpers ───────────────────────────────────────────────────────────────────

function isIxHidden(el: Element): boolean {
  const t = el.tagName.toUpperCase();
  return t === 'IX:HIDDEN' || t === 'IXHIDDEN';
}

function isHidden(el: Element): boolean {
  if ((el as HTMLElement).hidden) return true;
  if (el.getAttribute('aria-hidden') === 'true') return true;
  const style = (el as HTMLElement).style;
  if (style.display === 'none' || style.visibility === 'hidden') return true;
  try {
    const win = el.ownerDocument.defaultView;
    if (win) {
      const cs = win.getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') return true;
    }
  } catch {
    // getComputedStyle may throw on detached/SVG nodes; safe to skip
  }
  return false;
}

/** Close the currently-open segment (if any) and push it to segs. */
function closeSeg(s: BuildState): void {
  if (s.openNode !== null && s.openLen > 0) {
    s.segs.push({
      node: s.openNode,
      nodeStart: s.openNodeStart,
      length: s.openLen,
      normStart: s.openNormStart,
    });
  }
  s.openNode = null;
  s.openLen = 0;
}

/** Emit pending structural newlines as a synthetic segment. */
function emitSynthNL(s: BuildState): void {
  closeSeg(s);
  const nl = s.pendingNL === 1 ? '\n' : '\n\n';
  s.segs.push({ node: null, nodeStart: 0, length: nl.length, normStart: s.normPos, synthetic: true });
  for (const ch of nl) s.chars.push(ch);
  s.normPos += nl.length;
  s.pendingNL = 0;
  s.pendingSpace = false;
  s.spaceNode = null;
}

/** Emit a single pending collapsed-whitespace space as a segment. */
function emitSynthSpace(s: BuildState): void {
  // openSeg should already be closed (we close it on WS encounter)
  if (s.spaceNode !== null) {
    s.segs.push({ node: s.spaceNode, nodeStart: s.spaceNodeOff, length: 1, normStart: s.normPos });
  } else {
    s.segs.push({ node: null, nodeStart: 0, length: 1, normStart: s.normPos, synthetic: true });
  }
  s.chars.push(' ');
  s.normPos += 1;
  s.pendingSpace = false;
  s.spaceNode = null;
}

/** Flush any pending whitespace into the output (only after first real char). */
function flushPending(s: BuildState): void {
  if (!s.hasContent) return;
  if (s.pendingNL > 0) emitSynthNL(s);
  else if (s.pendingSpace) emitSynthSpace(s);
}

/** Schedule a structural newline (capped at \n\n). NL supersedes pending space. */
function scheduleNL(s: BuildState, level: 1 | 2): void {
  s.pendingNL = (Math.max(s.pendingNL, level) as 0 | 1 | 2);
  if (s.pendingNL > 0) { s.pendingSpace = false; s.spaceNode = null; }
}

/** Process one Text node: map every char to segments respecting WS collapsing. */
function processTextNode(node: Text, s: BuildState): void {
  const data = node.data;
  for (let i = 0; i < data.length; i++) {
    const ch = data[i] as string;
    // Treat \s and \u00A0 as whitespace per spec
    if (ch === '\u00A0' || (ch.length === 1 && /\s/.test(ch))) {
      // Whitespace — close any open seg and possibly schedule a pending space
      if (s.openNode !== null) closeSeg(s);
      if (s.hasContent && s.pendingNL === 0 && !s.pendingSpace) {
        s.pendingSpace = true;
        s.spaceNode = node;
        s.spaceNodeOff = i;
      }
    } else {
      // Real character
      if (s.hasContent) {
        flushPending(s);
      } else {
        // Still at document start → discard accumulated pending (trim leading WS)
        s.pendingNL = 0;
        s.pendingSpace = false;
        s.spaceNode = null;
        s.hasContent = true;
      }
      // Open or extend the current segment (always from the current text node)
      if (s.openNode === null) {
        s.openNode = node;
        s.openNodeStart = i;
        s.openNormStart = s.normPos;
        s.openLen = 0;
      }
      s.chars.push(ch);
      s.openLen++;
      s.normPos++;
    }
  }
  // End of text node → always close whatever is open
  closeSeg(s);
}

/** Recursive DFS over the DOM. */
function dfs(node: Node, s: BuildState): void {
  // ── text node ──
  if (node.nodeType === Node.TEXT_NODE) {
    processTextNode(node as Text, s);
    return;
  }

  if (node.nodeType !== Node.ELEMENT_NODE) return;

  const el = node as Element;
  const tag = el.tagName.toUpperCase();

  // Skip entire subtrees
  if (SKIP_TAGS.has(tag)) return;
  if (isIxHidden(el)) return;
  if (isHidden(el)) return;

  // BR → single newline (no children to recurse)
  if (tag === 'BR') {
    if (s.hasContent) scheduleNL(s, 1);
    return;
  }

  const isBlock = BLOCK_TAGS.has(tag);
  const isTable = tag === 'TABLE';

  if (isBlock) scheduleNL(s, 2);

  // Track table start (outermost TABLE only)
  if (isTable) {
    s.tableDepth++;
    if (s.tableDepth === 1) {
      // Will be finalized once we actually emit the first table char;
      // approximate: current normPos + any pending structural NLs
      s.tablePendStart = s.normPos + s.pendingNL;
    }
  }

  for (let child = node.firstChild; child !== null; child = child.nextSibling) {
    dfs(child, s);
  }

  if (isTable) {
    s.tableDepth--;
    if (s.tableDepth === 0) {
      s.tableRanges.push([s.tablePendStart, s.normPos]);
    }
  }

  if (isBlock) scheduleNL(s, 2);
}

// ── binary search ─────────────────────────────────────────────────────────────

/** Returns the index of the segment whose [normStart, normStart+length) contains pos,
 *  or -1 if no segment covers pos. */
function bsearchIdx(segs: ReadonlyArray<Segment>, pos: number): number {
  let lo = 0, hi = segs.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const seg = segs[mid]!;
    if (pos < seg.normStart) hi = mid - 1;
    else if (pos >= seg.normStart + seg.length) lo = mid + 1;
    else return mid;
  }
  return -1;
}

/**
 * Resolve a normalized position to a (Text node, intra-node offset) for use as
 * the START of a Range.setStart call.  Walks forward from the found segment index
 * to skip any synthetic segments.
 */
function resolveStart(
  segs: ReadonlyArray<Segment>,
  pos: number,
): [Text, number] | null {
  let idx = bsearchIdx(segs, pos);
  if (idx === -1) {
    // pos may be before the first segment (shouldn't happen after trim, but safe)
    idx = 0;
  }
  // Walk forward to find the first non-synthetic real segment at or after pos
  for (let i = idx; i < segs.length; i++) {
    const seg = segs[i]!;
    if (!seg.synthetic && seg.node !== null) {
      const nodeOff = seg.nodeStart + Math.max(0, pos - seg.normStart);
      return [seg.node, Math.min(nodeOff, seg.nodeStart + seg.length)];
    }
  }
  return null;
}

/**
 * Resolve a normalized position to a (Text node, intra-node offset) for use as
 * the END of a Range.setEnd call (exclusive boundary — "before char at pos").
 * Walks backward to skip synthetic segments.
 */
function resolveEnd(
  segs: ReadonlyArray<Segment>,
  pos: number,
): [Text, number] | null {
  // We want the segment that contains the character just before pos (pos−1),
  // then set the end offset one past it.
  const target = Math.max(0, pos - 1);
  let idx = bsearchIdx(segs, target);

  if (idx === -1) {
    // pos is beyond all segments (e.g. pos === text.length) — use last segment's end
    for (let i = segs.length - 1; i >= 0; i--) {
      const seg = segs[i]!;
      if (!seg.synthetic && seg.node !== null) {
        return [seg.node, seg.nodeStart + seg.length];
      }
    }
    return null;
  }

  // Walk backward to find a non-synthetic segment
  for (let i = idx; i >= 0; i--) {
    const seg = segs[i]!;
    if (!seg.synthetic && seg.node !== null) {
      // nodeOff = offset inside the node text that corresponds to normPos=pos
      const nodeOff = seg.nodeStart + Math.min(pos - seg.normStart, seg.length);
      return [seg.node, nodeOff];
    }
  }
  return null;
}

// ── factory ───────────────────────────────────────────────────────────────────

function createPositionMap(
  text: string,
  segs: Segment[],
  root: Element | Document,
): PositionMap {
  // Index segments by Text node for O(k) fromNode lookup (k = segs per node, usually 1-3)
  const nodeIndex = new Map<Text, Segment[]>();
  for (const seg of segs) {
    if (seg.node !== null) {
      let list = nodeIndex.get(seg.node);
      if (!list) { list = []; nodeIndex.set(seg.node, list); }
      list.push(seg);
    }
  }

  const pm: PositionMap = {
    text,
    segments: segs,

    toDomRange([a, b]) {
      if (a > b || b < 0 || a > text.length) return null;
      const startPair = resolveStart(segs, a);
      const endPair   = resolveEnd(segs, b);
      if (!startPair || !endPair) return null;
      const doc = startPair[0].ownerDocument ?? document;
      try {
        const range = doc.createRange();
        range.setStart(startPair[0], startPair[1]);
        range.setEnd(endPair[0], endPair[1]);
        return range;
      } catch {
        return null;
      }
    },

    toClientRects([a, b]) {
      const range = this.toDomRange([a, b]);
      return range ? Array.from(range.getClientRects()) : [];
    },

    fromNode(node, offset) {
      const list = nodeIndex.get(node);
      if (!list) return null;
      for (const seg of list) {
        if (offset >= seg.nodeStart && offset < seg.nodeStart + seg.length) {
          return seg.normStart + (offset - seg.nodeStart);
        }
      }
      return null;
    },

    fromPoint(x, y) {
      const doc = (root instanceof Document ? root : root.ownerDocument) ?? document;
      // caretRangeFromPoint is Chrome/WebKit; caretPositionFromPoint is the standard
      const r = (doc as Document & { caretRangeFromPoint?(x: number, y: number): Range | null })
        .caretRangeFromPoint?.(x, y);
      if (!r) return null;
      const container = r.startContainer;
      if (container.nodeType !== Node.TEXT_NODE) return null;
      return pm.fromNode(container as Text, r.startOffset);
    },

    toDocRange(base, range) {
      return liftToDocRange(base, range);
    },

    rebuild(newRoot) {
      return buildPositionMap(newRoot).positionMap;
    },
  };

  return pm;
}

// ── public entry point ────────────────────────────────────────────────────────

/**
 * Build the normalized text and position map for a filing DOM root.
 * Pass document.body (or the selected frame's body for EDGAR iframes).
 */
export function buildPositionMap(root: Element | Document): BuildResult {
  const docRoot =
    root instanceof Document
      ? (root.body ?? root.documentElement)
      : root;

  const s: BuildState = {
    chars: [],
    segs: [],
    normPos: 0,
    pendingNL: 0,
    pendingSpace: false,
    spaceNode: null,
    spaceNodeOff: 0,
    hasContent: false,
    openNode: null,
    openNodeStart: 0,
    openNormStart: 0,
    openLen: 0,
    tableDepth: 0,
    tablePendStart: 0,
    tableRanges: [],
  };

  dfs(docRoot, s);
  closeSeg(s);  // safety: flush anything still open

  const text = s.chars.join('');
  const positionMap = createPositionMap(text, s.segs, root);

  return { positionMap, tableRanges: s.tableRanges };
}
