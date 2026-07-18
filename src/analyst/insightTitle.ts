// ============================================================
// Relic — Insight card titles
// ------------------------------------------------------------
// Titles must be short topic labels unique to the takeaway — never a truncated
// copy of the summary/body, and never PDF chrome ("28 Table of Contents …").
// Used by the deterministic builder and by finalizeInsight so LM + extractive
// paths cannot ship prefix-of-body titles.
// ============================================================

import type { InsightCategory } from '@/types';

const TITLE_MAX = 72;

/** Trim to a card-friendly headline without mid-word cuts. */
export function truncateTitle(s: string, max = TITLE_MAX): string {
  const cleaned = s.replace(/\s+/g, ' ').trim().replace(/[,:;]\s*$/, '');
  if (cleaned.length <= max) return cleaned;
  const sliced = cleaned.slice(0, max);
  const sp = sliced.lastIndexOf(' ');
  return `${(sp > 40 ? sliced.slice(0, sp) : sliced).trim()}…`;
}

/** Strip PDF/edgar page-header chrome that often prefixes extracted sentences. */
export function stripFilingNoise(text: string): string {
  return text
    .replace(/\s+/g, ' ')
    .replace(/(?:^|\s)\d{1,4}\s+Table of Contents\s+/gi, ' ')
    .replace(/^Table of Contents\s+/gi, '')
    .trim();
}

/** Compact "$50.3B" / "12%" from filing prose for use in a topic headline. */
export function compactFigureFromText(text: string): string | null {
  const money = text.match(
    /\$\s?([\d,]+(?:\.\d+)?)\s*(billion|million|trillion|B|M|T)?\b/i,
  );
  if (money) {
    const n = parseFloat(money[1]!.replace(/,/g, ''));
    if (!Number.isFinite(n)) return null;
    const unit = (money[2] ?? '').toLowerCase();
    if (unit.startsWith('b') || unit === 'billion') return `$${n.toFixed(n >= 100 ? 0 : 1)}B`;
    if (unit.startsWith('m') || unit === 'million') return `$${n.toFixed(n >= 100 ? 0 : 1)}M`;
    if (unit.startsWith('t') || unit === 'trillion') return `$${n.toFixed(2)}T`;
    if (n >= 1e9) return `$${(n / 1e9).toFixed(1)}B`;
    if (n >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
    if (n >= 1e3) return `$${n.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
    return `$${n.toFixed(2)}`;
  }
  const pct = text.match(/(\d+(?:\.\d+)?)\s?%/);
  return pct ? `${pct[1]}%` : null;
}

/**
 * Topic labels for common filing motifs. These are headlines, not quotes —
 * they must not be contiguous prefixes of the source sentence (the summary).
 */
const TOPIC_RULES: ReadonlyArray<{ re: RegExp; topic: string }> = [
  { re: /held outside|outside of the U\.?S/i, topic: 'Cash held outside the U.S.' },
  { re: /principal source of liquidity|liquidity and capital resources/i, topic: 'Liquidity position' },
  { re: /cash equivalents|marketable (?:debt|equity) securities|cash,\s*cash equivalents/i, topic: 'Cash & marketable securities' },
  { re: /operating cash flow|cash (?:provided|generated) by operating/i, topic: 'Operating cash flow' },
  { re: /free cash flow/i, topic: 'Free cash flow' },
  { re: /gross margin/i, topic: 'Gross margin' },
  { re: /operating (?:income|margin|loss)/i, topic: 'Operating income' },
  { re: /Compute\s*&\s*Networking|Compute and Networking/i, topic: 'Compute & Networking' },
  { re: /\bGraphics segment\b|\bGraphics\b.{0,40}operating/i, topic: 'Graphics segment' },
  { re: /concentrat\w+ of (?:our )?revenue|depend\w+ on .{0,40}customers/i, topic: 'Revenue concentration' },
  { re: /cost of revenue|cost of sales/i, topic: 'Cost of revenue' },
  { re: /share repurchas|bought back|buyback/i, topic: 'Share repurchases' },
  { re: /quarterly (?:cash )?dividend|future payment of a .{0,20}dividend|dividend on our/i, topic: 'Dividend policy' },
  { re: /supply and demand|supply chain|monitor the environment for potential impacts/i, topic: 'Supply & demand conditions' },
  { re: /forward.looking|inherently uncertain|investors are cautioned/i, topic: 'Forward-looking statement caution' },
  { re: /Risk Factors.{0,60}(?:Annual Report|Form 10-K)/i, topic: 'Incorporation of 10-K risk factors' },
  { re: /Risk Factors.{0,60}(?:Quarterly Report|Form 10-Q)/i, topic: 'Cross-reference to 10-Q risk factors' },
  { re: /we discuss many of these risks|uncertainties and other factors in this/i, topic: 'Risk cross-reference' },
  { re: /litigation|lawsuits?/i, topic: 'Litigation risk' },
  { re: /regulat\w+ risk|regulatory/i, topic: 'Regulatory risk' },
  { re: /macroeconomic|adverse macro/i, topic: 'Macroeconomic risk' },
  { re: /\brevenues?\b.{0,30}(?:increas|decreas|grew|declin)|\b(?:increas|decreas)\w* .{0,20}revenue/i, topic: 'Revenue' },
];

const CATEGORY_TOPIC: Partial<Record<InsightCategory, string>> = {
  Revenue: 'Revenue',
  Margins: 'Margins',
  'Cash Flow': 'Cash flow',
  'Balance Sheet': 'Balance sheet',
  Shares: 'Share count & capital return',
  Risk: 'Risk disclosure',
  'Management Commentary': 'Management commentary',
  Guidance: 'Guidance',
  Operations: 'Operations',
  'Legal/Regulatory': 'Legal & regulatory',
  'Customer Demand': 'Customer demand',
  Valuation: 'Valuation',
};

function norm(s: string): string {
  return s.replace(/…$/, '').replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * True when `title` is (or contains) a cut of the summary — the redundancy bug —
 * or carries PDF chrome that should never headline a card.
 */
export function isBadInsightTitle(title: string, summary: string): boolean {
  const t = norm(title);
  const s = norm(summary);
  if (t.length < 4) return true;
  if (/table of contents/.test(t)) return true;
  // Bare page-number lead ("28 We continue…") is almost always chrome bleed.
  if (/^\d{1,4}\b/.test(t) && t.length > 12) return true;
  if (!s) return false;
  if (s.startsWith(t)) return true;
  // Long titles that appear anywhere in the body are quotes, not labels.
  if (t.length >= 20 && s.includes(t)) return true;
  // Mid-sentence fragment: starts mid-thought with a date/figure clause.
  if (/^(?:january|february|march|april|may|june|july|august|september|october|november|december)\b/.test(t)
    && s.includes(t.slice(0, Math.min(t.length, 32)))) {
    return true;
  }
  return false;
}

/** Build a topic headline from body text + category — never a prose prefix. */
export function topicTitleFromText(text: string, category: InsightCategory): string {
  const cleaned = stripFilingNoise(text);
  const figure = compactFigureFromText(cleaned);

  for (const rule of TOPIC_RULES) {
    if (!rule.re.test(cleaned)) continue;
    const titled = figure ? `${rule.topic} · ${figure}` : rule.topic;
    if (!isBadInsightTitle(titled, cleaned) && !isBadInsightTitle(titled, text)) {
      return truncateTitle(titled);
    }
  }

  const base = CATEGORY_TOPIC[category] ?? category;
  const fallback = figure ? `${base} · ${figure}` : base;
  return truncateTitle(fallback);
}

/**
 * Guarantee a card title is a unique topic label for this summary.
 * Rewrites LM or legacy titles that quote / truncate the body.
 */
export function ensureInsightTitle(
  title: string,
  summary: string,
  category: InsightCategory,
): string {
  const raw = title.replace(/\s+/g, ' ').trim();
  const body = summary.replace(/\s+/g, ' ').trim();
  const cleanedBody = stripFilingNoise(body);

  if (
    raw &&
    !isBadInsightTitle(raw, body) &&
    !isBadInsightTitle(raw, cleanedBody)
  ) {
    return truncateTitle(raw);
  }
  return topicTitleFromText(cleanedBody || body, category);
}

/** Ensure colliding titles across a list stay distinct without quoting the body. */
export function uniquifyInsightTitles<T extends { title: string; summary: string }>(
  insights: T[],
): T[] {
  const counts = new Map<string, number>();
  for (const ins of insights) {
    const k = ins.title.toLowerCase();
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const used = new Map<string, number>();
  return insights.map((ins) => {
    const k = ins.title.toLowerCase();
    if ((counts.get(k) ?? 0) <= 1) return ins;
    const n = (used.get(k) ?? 0) + 1;
    used.set(k, n);
    if (n === 1) return ins;
    const fig = compactFigureFromText(ins.summary);
    if (fig && !ins.title.includes(fig)) {
      return { ...ins, title: truncateTitle(`${ins.title} · ${fig}`) };
    }
    return { ...ins, title: `${ins.title} (${n})` };
  });
}
