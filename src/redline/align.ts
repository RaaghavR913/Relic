// ============================================================
// FilingLens — Section alignment (Session 6)
// ------------------------------------------------------------
// Pure functions — no Chrome APIs. Matches sections of the CURRENT filing to the
// PRIOR comparable filing by canonical id, tolerating cross-year renumbering and
// known merges via an alias table. Sections present on only one side are reported
// as 'added' (new this year) or 'removed' (dropped this year).
//
// v1 diffing focuses on item_1a_risk_factors and item_7_mdna, but alignment
// covers ALL sections so the UI can surface added/removed sections too.
// ============================================================

import type { Section } from '@/types';

export type AlignStatus = 'matched' | 'added' | 'removed';

export interface SectionAlignment {
  /** Canonical id of the current section (or the prior section if current-only-removed). */
  id: string;
  label: string;
  status: AlignStatus;
  current?: Section;
  prior?: Section;
}

/** Default sections to compute a full redline for in v1. */
export const DEFAULT_FOCUS_IDS: readonly string[] = [
  // 10-K
  'item_1a_risk_factors',
  'item_7_mdna',
  // 10-Q equivalents
  'part_ii_item_1a_risk_factors',
  'item_2_mdna',
  // S-1 (also aliased to item_1a_risk_factors / item_7_mdna via ALIAS_GROUPS,
  // but offscreen.ts filters on raw ids so these must appear here explicitly)
  's1_risk_factors',
  's1_mdna',
  's1_business',
  // 20-F (foreign private issuers) — parallels the 10-K/S-1 focus set:
  //   risk factors, the operating & financial review (MD&A equivalent), and the
  //   business description. The 20-F segmenter (segment.ts ITEMS_20F) emits these
  //   ids; without them a 20-F redline produced an empty diff (silent no-op, M1).
  '20f_item_3d_risk_factors',       // ↔ item_1a_risk_factors
  '20f_item_5_operating_review',    // ↔ item_7_mdna (Operating and Financial Review)
  '20f_item_4_company_information',  // ↔ business description (Information on the Company)
  // DEF 14A (proxy)
  'proxy_exec_compensation',
  'proxy_cd_a',
  'proxy_governance',
  // 8-K — most frequently filed items
  'item_2_02_results_of_operations',
  'item_5_02_officer_changes',
  'item_1_01_material_agreements',
  'item_8_01_other',
];

/**
 * Alias groups: ids that should be treated as the same logical section across
 * years / renumbering. The FIRST id in each group is the canonical representative.
 * Same-form YoY comparisons rarely need these (ids are stable), but a registrant
 * that renumbered (e.g. folded an item into another) still aligns.
 */
const ALIAS_GROUPS: string[][] = [
  // "Selected Financial Data" (Item 6) was reclassified as "Reserved" in 2021.
  ['item_6_mdna_selected', 'item_6_reserved', 'item_6_selected_financial_data'],
  // MD&A appears under different item numbers across forms (20-F calls it the
  // "Operating and Financial Review and Prospects").
  ['item_7_mdna', 'item_2_mdna', 's1_mdna', '20f_item_5_operating_review'],
  // Risk Factors across forms (20-F nests them under Item 3.D).
  ['item_1a_risk_factors', 'part_ii_item_1a_risk_factors', 's1_risk_factors', '20f_item_3d_risk_factors'],
];

const ALIAS_CANON = new Map<string, string>();
for (const group of ALIAS_GROUPS) {
  const canon = group[0]!;
  for (const id of group) ALIAS_CANON.set(id, canon);
}

function canonicalId(id: string): string {
  return ALIAS_CANON.get(id) ?? id;
}

export interface AlignOptions {
  /** Restrict the returned alignments to these canonical ids. Default: all. */
  focusIds?: readonly string[];
}

/**
 * Align current sections to prior sections. Returns one entry per logical section
 * (union of both sides), ordered by the current section's order (added-only
 * sections keep the prior order; removed sections sort to the end of their slot).
 */
export function alignSections(
  current: Section[],
  prior: Section[],
  opts: AlignOptions = {},
): SectionAlignment[] {
  const priorByCanon = new Map<string, Section>();
  for (const s of prior) priorByCanon.set(canonicalId(s.id), s);

  const seenPrior = new Set<string>();
  const out: SectionAlignment[] = [];

  // Walk current sections first (preserves current document order).
  for (const cur of current) {
    const key = canonicalId(cur.id);
    const match = priorByCanon.get(key);
    if (match) {
      seenPrior.add(key);
      out.push({ id: cur.id, label: cur.label, status: 'matched', current: cur, prior: match });
    } else {
      out.push({ id: cur.id, label: cur.label, status: 'added', current: cur });
    }
  }

  // Any prior section never matched is a removed section.
  for (const pri of prior) {
    const key = canonicalId(pri.id);
    if (seenPrior.has(key)) continue;
    // Guard against duplicate prior ids mapping to the same canon.
    seenPrior.add(key);
    out.push({ id: pri.id, label: pri.label, status: 'removed', prior: pri });
  }

  if (!opts.focusIds) return out;
  const focus = new Set(opts.focusIds.map(canonicalId));
  return out.filter((a) => focus.has(canonicalId(a.id)));
}

/** The matched alignments whose canonical id is in the focus set. */
export function focusMatches(
  alignments: SectionAlignment[],
  focusIds: readonly string[] = DEFAULT_FOCUS_IDS,
): SectionAlignment[] {
  const focus = new Set(focusIds.map(canonicalId));
  return alignments.filter((a) => focus.has(canonicalId(a.id)));
}

/**
 * Select the alignments to compute a full redline for, by RAW id (not canonical):
 * an alignment is in focus if its own id — or its current/prior section id — is in
 * the focus set. This is the set `computeRedline` diffs; when it is EMPTY for a
 * filing, the form has no Changes-tab coverage and the caller must surface an
 * explicit 'unsupported_form' status rather than an empty (misleading) diff (M1).
 */
export function focusAlignments(
  alignments: SectionAlignment[],
  focusIds: readonly string[] = DEFAULT_FOCUS_IDS,
): SectionAlignment[] {
  const focus = new Set(focusIds);
  return alignments.filter(
    (a) =>
      focus.has(a.id) ||
      (a.current ? focus.has(a.current.id) : false) ||
      (a.prior ? focus.has(a.prior.id) : false),
  );
}
