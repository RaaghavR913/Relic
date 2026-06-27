// ============================================================
// Relic — language-flag category presentation
// ------------------------------------------------------------
// Shared display metadata for the four flag categories: a human label, an
// example trigger phrase, and the Tailwind text-decoration utility that mirrors
// the on-page underline style (a non-color cue, per WCAG AA). Used by the
// settings page and the side-panel overlay controls so both stay in sync with
// the underline styles painted by the content script (flagOverlay.ts).
// ============================================================

import type { FlagCategory } from '@/sidepanel/overlayPrefs';

export const CATEGORY_META: Record<
  FlagCategory,
  { label: string; example: string; underline: string }
> = {
  uncertainty: { label: 'Uncertainty', example: 'may, could, potential', underline: 'decoration-dashed' },
  weak_modal:  { label: 'Weak modal',  example: 'should, intend, believe', underline: 'decoration-dotted' },
  litigious:   { label: 'Litigious',   example: 'claim, breach, suit', underline: 'decoration-double' },
  negative:    { label: 'Negative',    example: 'decline, loss, impairment', underline: 'decoration-wavy' },
};
