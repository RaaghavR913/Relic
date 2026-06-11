// ============================================================
// FilingLens — Analyst pipeline: relevance-driven excerpt selection
// ------------------------------------------------------------
// Gemini Nano's context window is small, so each analysis stage gets a
// keyword-targeted excerpt budget instead of the whole filing. Sentences are
// scored per dimension (revenue, margins, …); numeric sentences rank higher
// because investors care about figures. Selected sentences are re-emitted in
// document order so the model sees coherent prose.
//
// Deterministic — no model calls. PRIVACY: pure text processing, on-device.
// ============================================================

import type { DocumentModel, Section } from '@/types';

export type Dimension =
  | 'overview'
  | 'revenue'
  | 'margins'
  | 'cashflow'
  | 'balancesheet'
  | 'shares'
  | 'risk'
  | 'management';

// Sections most likely to contain investor-relevant prose, by id prefix.
const PRIORITY_SECTION_PREFIXES = [
  'item_7_mdna', 'part_ii_item_7', 'item_2_mdna',
  'item_1a_risk', 'part_i_item_1a', 'part_ii_item_1a',
  'item_8', 'item_1_business', 'part_i_item_1',
];

const KEYWORDS: Record<Exclude<Dimension, 'overview'>, RegExp> = {
  revenue:
    /\b(revenues?|net sales|total sales|sales (?:grew|growth|increased?|decreased?|declined?)|bookings|billings|backlog|subscription|recurring|arr|average selling price|pricing|volume|units shipped|same.store|organic growth|segment)\b/i,
  margins:
    /\b(gross margin|operating margin|net margin|margins?|profitab\w*|operating income|operating loss|operating expenses?|opex|cost of (?:goods|revenue|sales)|sg&a|research and development expense|restructur\w*|cost reduction|efficiency|operating leverage|net income|net loss|earnings per share|eps)\b/i,
  cashflow:
    /\b(cash flows?|operating cash|free cash flow|capex|capital expenditures?|working capital|cash and cash equivalents|cash position|cash (?:used|provided|generated)|liquidity)\b/i,
  balancesheet:
    /\b(debt|borrowings|notes payable|credit facilit\w*|revolver|covenants?|interest expense|maturit\w*|refinanc\w*|liabilit\w*|stockholders.? equity|cash balance|leverage|impair\w*|goodwill|going concern)\b/i,
  shares:
    /\b(share repurchases?|buybacks?|dividends?|share count|shares outstanding|dilut\w*|stock.based compensation|equity awards?|issuances?|secondary offering|stock split|capital return)\b/i,
  risk:
    /\b(risks?|uncertain\w*|adverse\w*|litigation|lawsuits?|regulat\w*|investigations?|competit\w*|concentration|depend\w* on|cybersecurity|going concern|material weakness|tariffs?|supply chain)\b/i,
  management:
    /\b(we believe|we expect|we anticipate|we intend|we remain|we continue to|our strategy|outlook|guidance|momentum|demand|confident|well.positioned|on track|record (?:revenue|quarter|year))\b/i,
};

// Sentences worth keeping must carry signal: a figure, a percentage, or a $ amount
// earns a bonus; bare boilerplate scores low and falls out of the budget.
const NUMERIC = /(?:\$\s?[\d,.]+|\d+(?:\.\d+)?\s?%|\b\d{2,}\b)/;

interface ScoredSentence {
  text: string;
  score: number;
  /** Position for restoring document order. */
  order: number;
}

/** Split section text into rough sentences. Keeps it dependency-free. */
export function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+(?=[A-Z(“"$\d])/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 30 && s.length <= 600);
}

function sectionPriority(section: Section): number {
  const idx = PRIORITY_SECTION_PREFIXES.findIndex((p) => section.id.startsWith(p));
  return idx === -1 ? PRIORITY_SECTION_PREFIXES.length : idx;
}

/**
 * Select up to `maxChars` of the most relevant sentences for the given
 * dimensions, returned in document order. Empty string when nothing matches —
 * callers use that to skip the model call entirely (sparse docs like a Form 4).
 */
export function selectRelevantText(
  doc: DocumentModel,
  dims: ReadonlyArray<Exclude<Dimension, 'overview'>>,
  maxChars: number,
): string {
  const regexes = dims.map((d) => KEYWORDS[d]);
  const scored: ScoredSentence[] = [];
  let order = 0;

  const sections = [...doc.sections].sort(
    (a, b) => sectionPriority(a) - sectionPriority(b) || a.order - b.order,
  );

  for (const section of sections) {
    const prio = sectionPriority(section);
    for (const sentence of splitSentences(section.text)) {
      order++;
      let score = 0;
      for (const re of regexes) {
        if (re.test(sentence)) score += 2;
      }
      if (score === 0) continue;
      if (NUMERIC.test(sentence)) score += 2;
      // Light boost for sentences from priority sections.
      score += prio < PRIORITY_SECTION_PREFIXES.length ? 1 : 0;
      scored.push({ text: sentence, score, order });
    }
  }

  scored.sort((a, b) => b.score - a.score || a.order - b.order);

  const picked: ScoredSentence[] = [];
  let used = 0;
  for (const s of scored) {
    if (used + s.text.length + 1 > maxChars) continue;
    picked.push(s);
    used += s.text.length + 1;
    if (used >= maxChars * 0.95) break;
  }

  picked.sort((a, b) => a.order - b.order);
  return picked.map((s) => s.text).join(' ');
}

/**
 * Lead excerpts for the snapshot/takeaway stages: the opening of each priority
 * section (or the longest sections when none match), capped at `maxChars`.
 */
export function selectOverviewText(doc: DocumentModel, maxChars: number): string {
  const sections = [...doc.sections].sort(
    (a, b) => sectionPriority(a) - sectionPriority(b) || b.text.length - a.text.length,
  );

  const parts: string[] = [];
  let used = 0;
  for (const section of sections) {
    const body = section.text.trim();
    if (!body) continue;
    const budget = Math.min(Math.floor(maxChars / 3), maxChars - used);
    if (budget < 200) break;
    const slice = body.length > budget ? body.slice(0, budget) + '…' : body;
    parts.push(`[${section.label}]\n${slice}`);
    used += slice.length + section.label.length + 4;
    if (used >= maxChars) break;
  }
  return parts.join('\n\n');
}
