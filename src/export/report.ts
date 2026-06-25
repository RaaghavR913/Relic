// ============================================================
// Disclora — offline report builder (Export)
// ------------------------------------------------------------
// Pure, dependency-free renderer: turns the artifacts gathered from the
// on-device caches (investor analysis, section summaries, sentiment, YoY
// redline) into ONE self-contained, print-optimized HTML document.
//
// Why HTML, not a bundled PDF library: the extension is fully on-device with a
// strict CSP (script-src 'self') and a deliberately lean dependency list. A
// self-contained HTML file opens offline, prints to a clean PDF via the
// browser's "Save as PDF", and opens in Word as a .doc — with zero new deps and
// nothing leaving the device. The collected text never goes to the network.
//
// This module is PURE (no IndexedDB, no chrome.* at runtime) so it unit-tests
// against a synthetic FilingExportData. The cache reads live in ./collect.ts.
// ============================================================

import type {
  DocumentModel,
  FilingAnalysis,
  FilingInsight,
  InsightLabel,
  OverallRead,
  ScorePoint,
  Section,
  SentenceSentiment,
} from '@/types';
import type { SummaryEntry } from '@/summarizer/summaryStore';
import type { RedlineEntry } from '@/redline/redlineStore';

/** Everything the report renders — gathered from caches by ./collect.ts. */
export interface FilingExportData {
  doc: DocumentModel;
  /** ms epoch the report was generated. */
  generatedAt: number;
  /** Extension version, for the footer (passed in so this module stays chrome-free). */
  appVersion: string;
  analysis: FilingAnalysis | null;
  /** Section summaries, in document order, only those present in cache. */
  summaries: Array<{ section: Section; entry: SummaryEntry }>;
  sentiment: SentenceSentiment[] | null;
  redline: RedlineEntry | null;
}

/** True when there is at least one analysis artifact worth exporting. */
export function hasExportableData(d: FilingExportData): boolean {
  return Boolean(
    d.analysis ||
      d.summaries.length > 0 ||
      (d.sentiment && d.sentiment.length > 0) ||
      (d.redline && (d.redline.diffs.length > 0 || d.redline.alignment.length > 0)),
  );
}

/** Safe download filename, e.g. `Disclora-MU-10-Q-2026-05-28.html`. */
export function reportFilename(d: FilingExportData): string {
  const id = d.doc.ticker || d.doc.companyName || 'filing';
  const period = d.doc.periodOfReport ? d.doc.periodOfReport.slice(0, 10) : '';
  const safe = ['Disclora', id, d.doc.filingType, period]
    .filter(Boolean)
    .join('-')
    .replace(/[^a-z0-9._-]+/gi, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return `${safe || 'Disclora-report'}.html`;
}

// ── small helpers ──────────────────────────────────────────────────────────────

/** HTML-escape — every piece of filing/analysis text passes through this. */
function esc(s: string | number | undefined | null): string {
  if (s === undefined || s === null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fmtDate(iso?: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
}

function fmtDateTime(ms: number): string {
  const d = new Date(ms);
  return d.toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

/** The internal 'Neutral' label is shown to users as 'Info' (mirrors AnalystPanel). */
function labelText(label: string): string {
  return label === 'Neutral' ? 'Info' : label;
}

const LABEL_CLASS: Record<InsightLabel, string> = {
  Bullish: 'pos',
  Bearish: 'neg',
  Mixed: 'warn',
  Neutral: 'mut',
  'Watch Item': 'info',
  'Red Flag': 'neg',
  'Quality Signal': 'pos',
  'Weakness Signal': 'warn',
  Unclear: 'mut',
};

const READ_CLASS: Record<OverallRead, string> = {
  Bullish: 'pos',
  Bearish: 'neg',
  Mixed: 'warn',
  Neutral: 'mut',
};

function chip(label: string, cls: string): string {
  return `<span class="chip chip-${cls}">${esc(labelText(label))}</span>`;
}

// ── analysis blocks ──────────────────────────────────────────────────────────

function insightHtml(ins: FilingInsight): string {
  const parts: string[] = [`<div class="insight">`];
  parts.push(
    `<div class="insight-head"><span class="insight-title">${esc(ins.title)}</span>${chip(
      ins.label,
      LABEL_CLASS[ins.label] ?? 'mut',
    )}</div>`,
  );
  if (ins.summary) parts.push(`<p>${esc(ins.summary)}</p>`);
  if (ins.whyItMatters) parts.push(`<p class="note"><b>Why it matters:</b> ${esc(ins.whyItMatters)}</p>`);
  if (ins.investorMeaning) parts.push(`<p class="note"><b>Investor view:</b> ${esc(ins.investorMeaning)}</p>`);
  if (ins.evidence) parts.push(`<blockquote>${esc(ins.evidence)}</blockquote>`);
  parts.push(
    `<p class="meta">${esc(ins.category)} · severity ${esc(ins.severity)} · ${esc(
      ins.timeHorizon,
    )} · confidence ${esc(ins.confidence)}</p>`,
  );
  parts.push(`</div>`);
  return parts.join('');
}

function insightListHtml(insights: FilingInsight[], emptyNote: string): string {
  if (insights.length === 0) return `<p class="empty">${esc(emptyNote)}</p>`;
  return insights.map(insightHtml).join('');
}

function scoreBarHtml(name: string, value: ScorePoint, inverted = false): string {
  // riskLevel is inverted: high value = bad. For colour, high-good → green.
  const good = inverted ? 6 - value : value;
  const cls = good >= 4 ? 'pos' : good === 3 ? 'warn' : 'neg';
  const pct = (value / 5) * 100;
  return `<div class="score-row">
    <span class="score-name">${esc(name)}</span>
    <span class="score-track"><span class="score-fill score-${cls}" style="width:${pct}%"></span></span>
    <span class="score-val">${value}/5</span>
  </div>`;
}

function snapshotHtml(a: FilingAnalysis): string {
  const s = a.investorSnapshot;
  const scores = a.scores
    ? `<div class="scores">
        ${scoreBarHtml('Revenue strength', a.scores.revenueStrength)}
        ${scoreBarHtml('Margin quality', a.scores.marginQuality)}
        ${scoreBarHtml('Cash flow quality', a.scores.cashFlowQuality)}
        ${scoreBarHtml('Balance sheet', a.scores.balanceSheetStrength)}
        ${scoreBarHtml('Risk level', a.scores.riskLevel, true)}
        ${scoreBarHtml('Mgmt credibility', a.scores.managementCredibility)}
        ${scoreBarHtml('Shareholder friendly', a.scores.shareholderFriendliness)}
      </div>`
    : '';
  return `
    <div class="snapshot">
      <div class="snapshot-badges">
        ${chip(a.overallRead, READ_CLASS[a.overallRead] ?? 'mut')}
        <span class="chip chip-mut">${esc(a.documentType)}</span>
        <span class="chip chip-mut">Confidence: ${esc(a.confidence)}</span>
        <span class="chip chip-mut">${esc(s.timeHorizon)}</span>
      </div>
      <p class="lede">${esc(a.oneSentenceSummary)}</p>
      <dl class="snapshot-dl">
        <dt>Main financial theme</dt><dd>${esc(s.mainFinancialTheme)}</dd>
        <dt>Most important investor question</dt><dd>${esc(s.mostImportantInvestorQuestion)}</dd>
      </dl>
      ${scores}
    </div>`;
}

function narrativeHtml(a: FilingAnalysis): string {
  if (a.managementNarrativeCheck.length === 0) return '';
  const cls = (x: string): string =>
    x === 'Supported' ? 'pos' : x === 'Not Supported' ? 'neg' : 'warn';
  const rows = a.managementNarrativeCheck
    .map(
      (n) => `<div class="insight">
        <p class="insight-title">“${esc(n.claim)}”</p>
        <p>${esc(n.evidence)}</p>
        <p>${chip(n.assessment, cls(n.assessment))}</p>
        ${n.investorMeaning ? `<p class="note"><b>Investor view:</b> ${esc(n.investorMeaning)}</p>` : ''}
      </div>`,
    )
    .join('');
  return sectionHtml('Management narrative check', rows);
}

function bullBearHtml(a: FilingAnalysis): string {
  if (a.bullCase.length === 0 && a.bearCase.length === 0) return '';
  const ul = (items: string[]): string =>
    `<ul>${items.map((b) => `<li>${esc(b)}</li>`).join('')}</ul>`;
  const inner = `
    ${a.bullCase.length ? `<div class="case case-pos"><h3>Bull case</h3>${ul(a.bullCase)}</div>` : ''}
    ${a.bearCase.length ? `<div class="case case-neg"><h3>Bear case</h3>${ul(a.bearCase)}</div>` : ''}
    ${a.netRead ? `<p class="note"><b>Net read:</b> ${esc(a.netRead)}</p>` : ''}`;
  return sectionHtml('Bull case vs bear case', inner);
}

function watchNextHtml(a: FilingAnalysis): string {
  if (a.whatToWatchNext.length === 0) return '';
  const rows = a.whatToWatchNext
    .map(
      (w) => `<div class="insight">
        <p class="insight-title">${esc(w.item)}</p>
        ${w.whyItMatters ? `<p>${esc(w.whyItMatters)}</p>` : ''}
        ${w.relatedMetric ? `<p class="meta">Metric: ${esc(w.relatedMetric)}</p>` : ''}
      </div>`,
    )
    .join('');
  return sectionHtml('What to watch next', rows);
}

// ── summaries ────────────────────────────────────────────────────────────────

/** Render the section summary text: analyst note (builtin) or key sentences (extractive). */
function summaryBodyHtml(section: Section, entry: SummaryEntry): string {
  if (entry.register === 'builtin' && entry.analyst.trim()) {
    // Builtin analyst note: lightweight markdown (bullets + **bold**) → paragraphs.
    const lines = entry.analyst.split('\n').map((line) => line.trim()).filter(Boolean);
    return lines
      .map((line) => {
        const bullet = /^[*\-•]\s+/.test(line);
        const text = esc(line.replace(/^[*\-•]\s+/, '').replace(/\*\*(.*?)\*\*/g, '$1'));
        return bullet ? `<li>${text}</li>` : `<p>${text}</p>`;
      })
      .join('');
  }
  // Extractive / fallback: each cached anchor is a key sentence from the section.
  const anchors = entry.plainAnchors ?? [];
  if (anchors.length > 0) {
    return `<ul>${anchors
      .map(([start, end]) => `<li>${esc(section.text.slice(start, end))}</li>`)
      .join('')}</ul>`;
  }
  return entry.analyst ? `<p>${esc(entry.analyst)}</p>` : '';
}

function summariesHtml(data: FilingExportData): string {
  if (data.summaries.length === 0) return '';
  const rows = data.summaries
    .map(
      ({ section, entry }) => `<div class="summary-block">
        <h3>${esc(section.label)}</h3>
        ${summaryBodyHtml(section, entry)}
      </div>`,
    )
    .join('');
  return sectionHtml('Section summaries', rows);
}

// ── sentiment ────────────────────────────────────────────────────────────────

interface Agg { positive: number; negative: number; neutral: number; total: number }

function aggregate(results: SentenceSentiment[]): Agg {
  let positive = 0, negative = 0, neutral = 0;
  for (const r of results) {
    if (r.label === 'positive') positive++;
    else if (r.label === 'negative') negative++;
    else neutral++;
  }
  return { positive, negative, neutral, total: results.length };
}

function pct(n: number, total: number): number {
  return total === 0 ? 0 : Math.round((n / total) * 100);
}

/** Plain-language read of the aggregate (mirrors SentimentPanel.consensusSummary). */
function consensus(agg: Agg): string {
  const { positive, negative, neutral, total } = agg;
  if (total === 0) return '';
  const posP = pct(positive, total), negP = pct(negative, total), neuP = pct(neutral, total);
  const net = posP - negP;
  const composition =
    neuP >= 60 ? 'overwhelmingly neutral, as is typical of measured disclosure language'
    : neuP >= 40 ? 'largely neutral, with pockets of directional tone'
    : 'unusually opinionated for a filing, with little neutral language';
  const lean =
    net >= 8 ? `Positive statements (${posP}%) outweigh negative ones (${negP}%), giving the filing an optimistic tilt.`
    : net <= -8 ? `Negative statements (${negP}%) outweigh positive ones (${posP}%), pointing to a cautious, risk-heavy tone.`
    : `Positive (${posP}%) and negative (${negP}%) statements are roughly balanced, leaving no strong directional bias.`;
  return `The filing's tone is ${composition}. ${lean}`;
}

function sentimentBarHtml(agg: Agg): string {
  const p = pct(agg.positive, agg.total), n = pct(agg.negative, agg.total), u = pct(agg.neutral, agg.total);
  return `<div class="sent-bar" role="img" aria-label="${p}% positive, ${n}% negative, ${u}% neutral">
      <span class="sent-pos" style="width:${(agg.positive / agg.total) * 100}%"></span>
      <span class="sent-neu" style="width:${(agg.neutral / agg.total) * 100}%"></span>
      <span class="sent-neg" style="width:${(agg.negative / agg.total) * 100}%"></span>
    </div>
    <div class="sent-legend"><span class="t-pos">${p}% positive</span><span>${u}% neutral</span><span class="t-neg">${n}% negative</span></div>`;
}

function sentimentHtml(data: FilingExportData): string {
  const results = data.sentiment;
  if (!results || results.length === 0) return '';
  const overall = aggregate(results);
  if (overall.total === 0) return '';

  const labelOf = new Map(data.doc.sections.map((s) => [s.id, s.label]));
  const bySection = new Map<string, SentenceSentiment[]>();
  for (const r of results) {
    const arr = bySection.get(r.sectionId) ?? [];
    arr.push(r);
    bySection.set(r.sectionId, arr);
  }
  const rows = [...bySection.entries()]
    .map(([id, arr]) => {
      const a = aggregate(arr);
      return `<tr>
        <td>${esc(labelOf.get(id) ?? id.replace(/_/g, ' '))}</td>
        <td class="num t-pos">${pct(a.positive, a.total)}%</td>
        <td class="num">${pct(a.neutral, a.total)}%</td>
        <td class="num t-neg">${pct(a.negative, a.total)}%</td>
        <td class="num">${a.total}</td>
      </tr>`;
    })
    .join('');

  const inner = `
    <p class="meta">${overall.total} sentences scored on-device (FinBERT).</p>
    ${sentimentBarHtml(overall)}
    <p class="note">${esc(consensus(overall))}</p>
    <table class="data-table">
      <thead><tr><th>Section</th><th class="num">Pos</th><th class="num">Neu</th><th class="num">Neg</th><th class="num">Sentences</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
  return sectionHtml('Sentiment analysis', inner);
}

// ── redline (YoY changes) ────────────────────────────────────────────────────

function redlineHtml(data: FilingExportData): string {
  const r = data.redline;
  if (!r) return '';

  if (r.status === 'no_prior') {
    return sectionHtml(
      'Year-over-year changes',
      `<p class="empty">No prior comparable ${esc(data.doc.filingType)} was found on EDGAR for this company.</p>`,
    );
  }
  if (r.status === 'unsupported_form') {
    return sectionHtml(
      'Year-over-year changes',
      `<p class="empty">A year-over-year comparison isn't available for ${esc(data.doc.filingType)} filings.</p>`,
    );
  }
  if (r.diffs.length === 0 && r.alignment.length === 0) return '';

  const labelOf = new Map(data.doc.sections.map((s) => [s.id, s.label]));
  const MAX = 6;

  const priorNote = r.prior
    ? `<p class="meta">Compared against ${esc(r.prior.form)} filed ${esc(
        r.prior.filingDate,
      )} (period ${esc(r.prior.reportDate)}). Source: ${esc(r.prior.url)}</p>`
    : '';

  const added = r.alignment.filter((a) => a.status === 'added');
  const removed = r.alignment.filter((a) => a.status === 'removed');
  const structural =
    added.length || removed.length
      ? `<div class="struct"><h3>Structural changes</h3>
          ${added.map((a) => `<p class="t-pos">+ New section: ${esc(a.label)}</p>`).join('')}
          ${removed.map((a) => `<p class="t-neg">− Removed section: ${esc(a.label)}</p>`).join('')}
        </div>`
      : '';

  const diffs = r.diffs
    .map((d) => {
      const label = labelOf.get(d.sectionId) ?? d.sectionId.replace(/_/g, ' ');
      const addedSpans = d.added.slice(0, MAX).map((s) => `<p class="diff-add">+ ${esc(s.text)}</p>`).join('');
      const removedSpans = d.removed.slice(0, MAX).map((s) => `<p class="diff-del">− ${esc(s.text)}</p>`).join('');
      const more =
        d.added.length > MAX || d.removed.length > MAX
          ? `<p class="meta">+${Math.max(0, d.added.length - MAX)} more additions, ${Math.max(
              0,
              d.removed.length - MAX,
            )} more removals not shown.</p>`
          : '';
      return `<div class="summary-block">
        <h3>${esc(label)} <span class="meta">· ${Math.round(d.magnitude * 100)}% changed</span></h3>
        ${d.summary ? `<p>${esc(d.summary)}</p>` : ''}
        ${addedSpans}${removedSpans}${more}
      </div>`;
    })
    .join('');

  return sectionHtml('Year-over-year changes', `${priorNote}${structural}${diffs}`);
}

// ── section wrapper + document shell ─────────────────────────────────────────

function sectionHtml(title: string, inner: string): string {
  return `<section class="block"><h2>${esc(title)}</h2>${inner}</section>`;
}

/** Build the complete self-contained report document. */
export function buildFilingReportHtml(data: FilingExportData): string {
  const { doc, analysis: a } = data;
  const title = `${doc.companyName ?? 'Filing'}${doc.ticker ? ` (${doc.ticker})` : ''} — ${doc.filingType}`;

  const metaLine = [
    doc.filingType,
    doc.periodOfReport ? `Period ${fmtDate(doc.periodOfReport)}` : '',
    doc.filedAt ? `Filed ${fmtDate(doc.filedAt)}` : '',
    `${doc.sections.length} sections`,
  ].filter(Boolean).map(esc).join(' &middot; ');

  const degradedNote = a?.degraded
    ? `<p class="degraded">Generated in extractive mode (Chrome built-in AI unavailable) — investor cards are derived from on-device deterministic signals.</p>`
    : '';

  const analysisBlocks = a
    ? [
        sectionHtml('Investor snapshot', snapshotHtml(a)),
        sectionHtml('Top investor takeaways', insightListHtml(a.topTakeaways, 'Not enough information in this document.')),
        sectionHtml(
          'What this means',
          `<h3>For revenue</h3>${insightListHtml(a.revenueImpact, 'Not enough information.')}
           <h3>For margins &amp; profitability</h3>${insightListHtml(a.marginImpact, 'Not enough information.')}
           <h3>For cash flow &amp; balance sheet</h3>${insightListHtml([...a.cashFlowImpact, ...a.balanceSheetHealth], 'Not enough information.')}
           <h3>For shares &amp; investor sentiment</h3>${insightListHtml(a.shareImpact, 'Not enough information.')}`,
        ),
        sectionHtml('Risk signals', insightListHtml(a.riskSignals, 'No material investor risks surfaced beyond boilerplate.')),
        narrativeHtml(a),
        bullBearHtml(a),
        watchNextHtml(a),
      ].join('')
    : `<section class="block"><p class="empty">No investor analysis is cached for this document. Open the Analyst tab to generate it, then export again.</p></section>`;

  const body = [
    analysisBlocks,
    summariesHtml(data),
    sentimentHtml(data),
    redlineHtml(data),
  ].join('');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(`Disclora report — ${title}`)}</title>
<style>${REPORT_CSS}</style>
</head>
<body>
<main class="page">
  <header class="cover">
    <div class="brand">Disclora</div>
    <h1>${esc(doc.companyName ?? 'Unknown company')}${doc.ticker ? ` <span class="ticker">${esc(doc.ticker)}</span>` : ''}</h1>
    <p class="cover-meta">${metaLine}</p>
    <p class="cover-src">${esc(doc.source.url)}</p>
    ${degradedNote}
    <p class="disclaimer">AI-generated investor analysis — informational only, not investment advice. Verify every figure and quote against the original filing.</p>
  </header>
  ${body}
  <footer class="report-footer">
    Generated by Disclora v${esc(data.appVersion)} on ${esc(fmtDateTime(data.generatedAt))}. All analysis ran on-device; nothing left your browser.
  </footer>
</main>
</body>
</html>`;
}

// ── print-optimized stylesheet (light theme; "Save as PDF" friendly) ─────────

const REPORT_CSS = `
:root{--ink:#1b1b1b;--muted:#666;--line:#e4e4e7;--accent:#0a7d4b;--pos:#15803d;--neg:#b91c1c;--warn:#b45309;--info:#0369a1;}
*{box-sizing:border-box;}
html{-webkit-print-color-adjust:exact;print-color-adjust:exact;}
body{margin:0;background:#f4f4f5;color:var(--ink);font:13px/1.55 -apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;}
.page{max-width:820px;margin:24px auto;background:#fff;padding:44px 52px;box-shadow:0 1px 6px rgba(0,0,0,.12);}
h1,h2,h3{font-family:Georgia,'Times New Roman',serif;color:#111;line-height:1.25;}
h1{font-size:26px;margin:.2em 0;}
h2{font-size:18px;margin:0 0 12px;padding-bottom:6px;border-bottom:2px solid var(--line);}
h3{font-size:13px;margin:16px 0 6px;color:#333;text-transform:uppercase;letter-spacing:.04em;}
p{margin:.45em 0;}
.cover{border-bottom:3px solid var(--ink);padding-bottom:18px;margin-bottom:8px;}
.brand{font-family:Georgia,serif;font-weight:700;font-size:15px;letter-spacing:.02em;color:var(--accent);}
.ticker{color:var(--muted);font-size:18px;}
.cover-meta{color:#444;font-size:12.5px;}
.cover-src{color:var(--muted);font-size:11px;word-break:break-all;margin-top:2px;}
.disclaimer{margin-top:12px;font-size:11px;color:#7a5b00;background:#fff7e6;border:1px solid #f0e0b0;border-radius:6px;padding:8px 10px;}
.degraded{margin-top:10px;font-size:11.5px;color:#444;background:#f4f4f5;border-radius:6px;padding:7px 10px;}
.block{margin-top:26px;}
.lede{font-size:15px;font-style:italic;color:#222;margin:4px 0 12px;}
.chip{display:inline-block;font-size:10.5px;font-weight:600;padding:1px 7px;border-radius:10px;border:1px solid;margin:0 4px 4px 0;vertical-align:middle;}
.chip-pos{color:var(--pos);border-color:var(--pos);background:#ecfdf3;}
.chip-neg{color:var(--neg);border-color:var(--neg);background:#fef2f2;}
.chip-warn{color:var(--warn);border-color:var(--warn);background:#fffaeb;}
.chip-info{color:var(--info);border-color:var(--info);background:#eff8ff;}
.chip-mut{color:#52525b;border-color:#d4d4d8;background:#fafafa;}
.snapshot-badges{margin-bottom:4px;}
.snapshot-dl{display:grid;grid-template-columns:auto 1fr;gap:2px 14px;margin:10px 0;font-size:12.5px;}
.snapshot-dl dt{font-weight:600;color:#444;}
.snapshot-dl dd{margin:0;color:#222;}
.scores{margin-top:12px;border-top:1px solid var(--line);padding-top:10px;}
.score-row{display:flex;align-items:center;gap:10px;margin:4px 0;font-size:11.5px;}
.score-name{width:150px;color:#444;}
.score-track{flex:1;height:7px;background:#ececef;border-radius:4px;overflow:hidden;}
.score-fill{display:block;height:100%;border-radius:4px;}
.score-pos{background:var(--pos);}.score-warn{background:var(--warn);}.score-neg{background:var(--neg);}
.score-val{width:30px;text-align:right;color:#666;font-variant-numeric:tabular-nums;}
.insight{border:1px solid var(--line);border-radius:8px;padding:10px 12px;margin:8px 0;background:#fcfcfd;}
.insight-head{display:flex;justify-content:space-between;gap:8px;align-items:baseline;}
.insight-title{font-weight:600;color:#1a1a1a;}
.insight p{font-size:12.5px;}
.note{color:#444;font-size:12px;}
.note b{color:var(--accent);}
.meta{color:#888;font-size:10.5px;}
.empty{color:#888;font-style:italic;font-size:12px;}
blockquote{margin:6px 0;padding:2px 0 2px 10px;border-left:3px solid var(--line);color:#555;font-style:italic;font-size:11.5px;}
.case{border-radius:8px;padding:8px 12px;margin:8px 0;}
.case h3{margin-top:2px;}
.case-pos{background:#ecfdf3;border:1px solid #b7e4c7;}
.case-neg{background:#fef2f2;border:1px solid #f3c0c0;}
.case ul{margin:4px 0 0;padding-left:18px;}
.case li{margin:3px 0;}
.summary-block{border:1px solid var(--line);border-radius:8px;padding:10px 12px;margin:8px 0;}
.summary-block ul{margin:4px 0;padding-left:18px;}
.summary-block li{margin:3px 0;}
.sent-bar{display:flex;height:14px;border-radius:7px;overflow:hidden;background:#ececef;margin:6px 0 4px;}
.sent-pos{background:#22c55e;}.sent-neu{background:#a1a1aa;}.sent-neg{background:#ef4444;}
.sent-legend{display:flex;justify-content:space-between;font-size:10.5px;color:#666;}
.t-pos{color:var(--pos);}.t-neg{color:var(--neg);}
.data-table{width:100%;border-collapse:collapse;margin-top:10px;font-size:11.5px;}
.data-table th,.data-table td{border-bottom:1px solid var(--line);padding:5px 8px;text-align:left;}
.data-table .num{text-align:right;font-variant-numeric:tabular-nums;}
.struct{margin:8px 0;}
.struct p{font-size:12px;margin:2px 0;}
.diff-add{background:#ecfdf3;border-left:3px solid var(--pos);padding:3px 8px;margin:3px 0;font-size:11.5px;color:#14532d;border-radius:0 4px 4px 0;}
.diff-del{background:#fef2f2;border-left:3px solid var(--neg);padding:3px 8px;margin:3px 0;font-size:11.5px;color:#7f1d1d;text-decoration:line-through;border-radius:0 4px 4px 0;}
.report-footer{margin-top:32px;padding-top:12px;border-top:1px solid var(--line);font-size:10.5px;color:#999;}
@media print{
  body{background:#fff;}
  .page{margin:0;max-width:none;box-shadow:none;padding:0;}
  .block,.insight,.summary-block,.case,.snapshot{page-break-inside:avoid;}
  h2{page-break-after:avoid;}
  @page{margin:18mm 16mm;}
}
`;
