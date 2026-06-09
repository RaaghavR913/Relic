// ============================================================
// FilingLens — Flag overlay manager (Session 5)
// ------------------------------------------------------------
// FlagOverlayManager wires LanguageFlag[] → CSS Custom Highlights + floating tooltip.
//
// Highlights: one CSS Custom Highlight layer per flag type (fl-flag-uncertainty,
// fl-flag-weak_modal, fl-flag-litigious, fl-flag-negative). Each uses a distinct
// underline style (dashed / dotted / double / wavy) for WCAG AA non-colour cue.
//
// Tooltip: a single fixed-position <div> shown via mousemove. Cursor position is
// converted to a normalised document offset via positionMap.fromPoint(); if that
// offset falls inside any flag's range the tooltip appears. This approach requires
// no span injection, consistent with the rendering contract in demo.ts.
//
// Stacking over Session 4 sentiment: flag layers use Highlight.priority = 2,
// sentiment uses priority = 1. See LAYER_PRIORITY in demo.ts.
// ============================================================

import type { LanguageFlag, PositionMap } from '@/types';
import type { FlagType } from '@/flagging/lexiconLoader';
import { type HighlightController, type HighlightLayer } from './demo';

// ── constants ─────────────────────────────────────────────────────────────────

const FLAG_LAYER: Record<FlagType, HighlightLayer> = {
  uncertainty: 'flag-uncertainty',
  weak_modal:  'flag-weak_modal',
  litigious:   'flag-litigious',
  negative:    'flag-negative',
};

// All 4 flag layers as an array for bulk-clear convenience.
const ALL_FLAG_LAYERS = Object.values(FLAG_LAYER) as HighlightLayer[];

/**
 * Short text label displayed in the tooltip header per flag type.
 * Also serves as the accessible aria-label on the tooltip when shown.
 */
const FLAG_LABEL: Record<FlagType, string> = {
  uncertainty: 'Uncertainty',
  weak_modal:  'Weak Modal',
  litigious:   'Litigious',
  negative:    'Negative',
};

/**
 * Marker pattern (not a colour) to distinguish flag types visually in the tooltip.
 * These Unicode characters also appear in the side panel legend.
 * Screen readers announce them as their Unicode name; they are supplemented by
 * the text label so colour-blind and AT users get the same information.
 */
const FLAG_MARKER: Record<FlagType, string> = {
  uncertainty: '- -',   // dashed, mirroring the dashed underline
  weak_modal:  '···',   // dotted, mirroring the dotted underline
  litigious:   '══',    // double, mirroring the double underline
  negative:    '~~~',   // wavy, mirroring the wavy underline
};

const TOOLTIP_ID = 'fl-flag-tooltip';

// ── FlagOverlayManager ────────────────────────────────────────────────────────

/**
 * Manages CSS Custom Highlight layers for all four flag types and a floating
 * tooltip that appears when the user hovers over a flagged phrase.
 *
 * Lifecycle:
 *   new FlagOverlayManager(doc, controller)
 *   .activate(flags, positionMap)   // paint highlights + mount tooltip listener
 *   .deactivate()                   // clear highlights + remove tooltip
 */
export class FlagOverlayManager {
  private readonly doc: Document;
  private readonly controller: HighlightController;

  private flags: LanguageFlag[] = [];
  private positionMap: PositionMap | null = null;
  private tooltip: HTMLDivElement | null = null;
  private mouseMoveHandler: ((e: MouseEvent) => void) | null = null;
  private mouseLeaveHandler: (() => void) | null = null;

  constructor(doc: Document, controller: HighlightController) {
    this.doc = doc;
    this.controller = controller;
  }

  /** Paint highlights for all flags and mount the hover tooltip. */
  activate(flags: LanguageFlag[], positionMap: PositionMap): void {
    this.flags = flags;
    this.positionMap = positionMap;
    this.renderHighlights();
    this.mountTooltip();
  }

  /** Clear all flag highlights and remove the tooltip from the DOM. */
  deactivate(): void {
    for (const layer of ALL_FLAG_LAYERS) {
      this.controller.clear(layer);
    }
    this.unmountTooltip();
    this.flags = [];
    this.positionMap = null;
  }

  /**
   * Return the document-space range of the first flag matching the given
   * sectionId and optional type. Used by the side panel to scroll-to.
   */
  firstFlagRange(
    sectionId: string,
    type?: FlagType,
  ): [number, number] | null {
    const match = this.flags.find(
      (f) => f.sectionId === sectionId && (type === undefined || f.type === type),
    );
    return match?.range ?? null;
  }

  // ── private ─────────────────────────────────────────────────────────────────

  private renderHighlights(): void {
    // Group flags by type — one Highlight object per type layer.
    const byType = new Map<FlagType, LanguageFlag[]>();
    for (const flag of this.flags) {
      if (!byType.has(flag.type)) byType.set(flag.type, []);
      byType.get(flag.type)!.push(flag);
    }

    for (const type of Object.keys(FLAG_LAYER) as FlagType[]) {
      const typeFlags = byType.get(type) ?? [];
      const ranges: Range[] = [];
      for (const flag of typeFlags) {
        const domRange = this.positionMap!.toDomRange(flag.range);
        if (domRange) ranges.push(domRange);
      }
      this.controller.setRanges(FLAG_LAYER[type], ranges);
    }
  }

  private mountTooltip(): void {
    this.unmountTooltip();

    // Inject a single reusable tooltip div into the filing document's body.
    // `pointer-events: none` so it never interferes with text selection or clicks.
    const tip = this.doc.createElement('div');
    tip.id = TOOLTIP_ID;
    tip.setAttribute('role', 'tooltip');
    tip.setAttribute('aria-hidden', 'true');
    Object.assign(tip.style, {
      position:      'fixed',
      zIndex:        '2147483647',
      pointerEvents: 'none',
      display:       'none',
      maxWidth:      '300px',
      padding:       '7px 11px',
      borderRadius:  '6px',
      background:    '#18181b',        // zinc-900 — matches side panel palette
      color:         '#d4d4d8',        // zinc-300
      font:          '12px/1.55 system-ui, -apple-system, sans-serif',
      border:        '1px solid #3f3f46', // zinc-700
      whiteSpace:    'normal',
      wordBreak:     'break-word',
    });
    (this.doc.body ?? this.doc.documentElement).appendChild(tip);
    this.tooltip = tip;

    const onMove = (e: MouseEvent): void => this.handleMouseMove(e);
    const onLeave = (): void => { if (this.tooltip) this.tooltip.style.display = 'none'; };

    this.doc.addEventListener('mousemove', onMove, { passive: true });
    this.doc.addEventListener('mouseleave', onLeave, { passive: true });
    this.mouseMoveHandler = onMove;
    this.mouseLeaveHandler = onLeave;
  }

  private unmountTooltip(): void {
    if (this.tooltip) {
      this.tooltip.remove();
      this.tooltip = null;
    }
    if (this.mouseMoveHandler) {
      this.doc.removeEventListener('mousemove', this.mouseMoveHandler);
      this.mouseMoveHandler = null;
    }
    if (this.mouseLeaveHandler) {
      this.doc.removeEventListener('mouseleave', this.mouseLeaveHandler);
      this.mouseLeaveHandler = null;
    }
  }

  private handleMouseMove(e: MouseEvent): void {
    const tip = this.tooltip;
    const pm  = this.positionMap;
    if (!tip || !pm) return;

    // Convert screen coordinate → normalised document offset.
    const normPos = pm.fromPoint(e.clientX, e.clientY);
    if (normPos === null) {
      tip.style.display = 'none';
      return;
    }

    // Linear scan is fine: flag counts are typically < 1000 per document.
    const flag = this.flags.find((f) => normPos >= f.range[0] && normPos < f.range[1]);
    if (!flag) {
      tip.style.display = 'none';
      return;
    }

    // Position the tooltip near the cursor; keep it inside the viewport.
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const tipW = 310; // slightly more than maxWidth for safety
    const tipH = 72;
    const x = Math.min(e.clientX + 14, vw - tipW);
    const y = Math.min(e.clientY + 22, vh - tipH);

    const marker = FLAG_MARKER[flag.type];
    const label  = FLAG_LABEL[flag.type];

    // Inner HTML is safe: `flag.term` and `flag.note` come from bundled lexicons only;
    // no user-supplied or filing-page content is interpolated here.
    tip.innerHTML =
      `<span style="font-size:10px;font-weight:600;letter-spacing:.04em;` +
      `text-transform:uppercase;color:#71717a;display:block;margin-bottom:4px">` +
      `<span aria-hidden="true" style="letter-spacing:.2em">${marker}</span> ${label}` +
      `</span>` +
      `<strong style="color:#f4f4f5">${escHtml(flag.term)}</strong>` +
      `<span style="color:#a1a1aa"> — </span>` +
      `<span style="color:#d4d4d8">${escHtml(flag.note)}</span>`;

    tip.setAttribute('aria-label', `${label}: ${flag.term} — ${flag.note}`);
    tip.setAttribute('aria-hidden', 'false');
    tip.style.left    = `${x}px`;
    tip.style.top     = `${y}px`;
    tip.style.display = 'block';
  }
}

// ── utilities ─────────────────────────────────────────────────────────────────

function escHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
