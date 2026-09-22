// ============================================================
// Relic — one-click PDF renderer (Export)
// ------------------------------------------------------------
// Renders the artifacts gathered from the on-device caches into a real,
// selectable-text PDF using jsPDF's built-in (standard-14) fonts — no font
// embedding, no rasterization, no network. A tiny cursor-based layout engine
// (Pdf) handles wrapping + pagination so each section flows across pages.
//
// jsPDF's standard fonts cover CP1252; `clean()` folds the handful of unicode
// punctuation marks filings use (smart quotes, dashes, bullets) down to safe
// equivalents so nothing renders as tofu.
// ============================================================

import { jsPDF } from 'jspdf';
import type { FilingAnalysis, FilingInsight, ScorePoint, XbrlUnit } from '@/types';
import {
  type FilingExportData,
  type SentimentAgg,
  type Tone,
  LABEL_TONE,
  READ_TONE,
  aggregateSentiment,
  clean,
  fmtDate,
  fmtDateTime,
  labelText,
  pctOf,
  reportFilename,
  sentimentConsensus,
  summaryItems,
} from './report';
import { stampExportMetadata } from './metadata';

// `clean` lives in ./report now, so ./metadata can share it without a cycle;
// re-exported here to keep this module's public surface unchanged.
export { clean } from './report';

type RGB = [number, number, number];

const COLORS: Record<Tone | 'ink' | 'muted' | 'line' | 'accent', RGB> = {
  ink: [26, 26, 26],
  muted: [110, 110, 115],
  line: [223, 223, 227],
  accent: [10, 125, 75],
  pos: [21, 128, 61],
  neg: [185, 28, 28],
  warn: [180, 83, 9],
  info: [3, 105, 161],
  mut: [82, 82, 91],
};

const PAGE = { w: 595.28, h: 841.89 }; // A4 portrait, pt
const MARGIN = 48;


interface TextOpts {
  size?: number;
  style?: 'normal' | 'bold' | 'italic';
  font?: 'helvetica' | 'times';
  color?: RGB;
  indent?: number;
  gapAfter?: number;
  lineFactor?: number;
}

/** Cursor-based layout over jsPDF: wraps text, advances y, breaks pages. */
class Pdf {
  readonly doc: jsPDF;
  private y = MARGIN;
  private readonly x = MARGIN;
  private readonly contentW = PAGE.w - MARGIN * 2;

  constructor() {
    this.doc = new jsPDF({ unit: 'pt', format: 'a4', compress: true });
  }

  private ensure(h: number): void {
    if (this.y + h > PAGE.h - MARGIN) {
      this.doc.addPage();
      this.y = MARGIN;
    }
  }

  gap(h = 6): void {
    this.y += h;
  }

  /** Draw a wrapped block of text at the current cursor. Returns nothing. */
  text(str: string, opts: TextOpts = {}): void {
    const size = opts.size ?? 10;
    const { doc } = this;
    doc.setFont(opts.font ?? 'helvetica', opts.style ?? 'normal');
    doc.setFontSize(size);
    doc.setTextColor(...(opts.color ?? COLORS.ink));
    const indent = opts.indent ?? 0;
    const lines = doc.splitTextToSize(clean(str), this.contentW - indent) as string[];
    const lineH = size * (opts.lineFactor ?? 1.4);
    for (const line of lines) {
      this.ensure(lineH);
      doc.text(line, this.x + indent, this.y, { baseline: 'top' });
      this.y += lineH;
    }
    if (opts.gapAfter) this.gap(opts.gapAfter);
  }

  /** A "Lead-in: rest" line where the lead-in is coloured/bold and inline. */
  leadIn(lead: string, rest: string, opts: { color?: RGB; size?: number } = {}): void {
    const size = opts.size ?? 9.5;
    const { doc } = this;
    doc.setFontSize(size);
    doc.setFont('helvetica', 'bold');
    const leadW = doc.getTextWidth(clean(lead) + ' ');
    const lineH = size * 1.4;
    // First line: lead-in then as much of the rest as fits.
    doc.setFont('helvetica', 'normal');
    const restLines = doc.splitTextToSize(clean(rest), this.contentW - leadW) as string[];
    const first = restLines.shift() ?? '';
    this.ensure(lineH);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(...(opts.color ?? COLORS.accent));
    doc.text(clean(lead) + ' ', this.x, this.y, { baseline: 'top' });
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(...COLORS.muted);
    doc.text(first, this.x + leadW, this.y, { baseline: 'top' });
    this.y += lineH;
    // Continuation lines wrap to the full width.
    for (const line of doc.splitTextToSize(restLines.join(' '), this.contentW) as string[]) {
      if (!line) continue;
      this.ensure(lineH);
      doc.text(line, this.x, this.y, { baseline: 'top' });
      this.y += lineH;
    }
  }

  heading(level: 1 | 2 | 3, str: string): void {
    if (level === 2) this.gap(10);
    const size = level === 1 ? 22 : level === 2 ? 14 : 10;
    const color = level === 3 ? COLORS.muted : COLORS.ink;
    this.ensure(size * 1.6);
    this.text(str, { size, style: 'bold', font: 'times', color, lineFactor: 1.2 });
    if (level === 2) {
      this.ensure(8);
      this.doc.setDrawColor(...COLORS.line);
      this.doc.setLineWidth(1);
      this.doc.line(this.x, this.y, this.x + this.contentW, this.y);
      this.gap(8);
    } else {
      this.gap(2);
    }
  }

  bullet(str: string): void {
    const size = 9.5;
    const { doc } = this;
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(size);
    doc.setTextColor(...COLORS.ink);
    const lineH = size * 1.4;
    const lines = doc.splitTextToSize(clean(str), this.contentW - 14) as string[];
    lines.forEach((line, i) => {
      this.ensure(lineH);
      if (i === 0) doc.text('-', this.x + 2, this.y, { baseline: 'top' });
      doc.text(line, this.x + 14, this.y, { baseline: 'top' });
      this.y += lineH;
    });
  }

  /** A row of small label chips (border + tinted text). Wraps across width. */
  chips(items: Array<{ text: string; tone: Tone }>): void {
    const size = 8.5;
    const padX = 5;
    const h = 14;
    const { doc } = this;
    doc.setFontSize(size);
    doc.setFont('helvetica', 'bold');
    let cx = this.x;
    this.ensure(h + 4);
    const top = this.y;
    for (const it of items) {
      const label = clean(it.text);
      const w = doc.getTextWidth(label) + padX * 2;
      if (cx + w > this.x + this.contentW) {
        cx = this.x;
        this.y += h + 4;
        this.ensure(h + 4);
      }
      const color = COLORS[it.tone];
      doc.setDrawColor(...color);
      doc.setLineWidth(0.7);
      doc.roundedRect(cx, this.y, w, h, 3, 3, 'S');
      doc.setTextColor(...color);
      doc.text(label, cx + padX, this.y + h / 2, { baseline: 'middle' });
      cx += w + 5;
    }
    this.y = (this.y === top ? top : this.y) + h + 6;
  }

  /** A label + 5-step bar + value, e.g. a snapshot score. */
  scoreBar(name: string, value: ScorePoint, inverted = false): void {
    const { doc } = this;
    const h = 7;
    const rowH = 15;
    this.ensure(rowH);
    const labelW = 150;
    const trackX = this.x + labelW;
    const valW = 30;
    const trackW = this.contentW - labelW - valW - 6;
    // good = how "positive" the value is (riskLevel is inverted).
    const good = inverted ? 6 - value : value;
    const tone: Tone = good >= 4 ? 'pos' : good === 3 ? 'warn' : 'neg';
    const midY = this.y + rowH / 2;
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8.5);
    doc.setTextColor(...COLORS.muted);
    doc.text(clean(name), this.x, midY, { baseline: 'middle' });
    // track
    doc.setFillColor(236, 236, 239);
    doc.roundedRect(trackX, midY - h / 2, trackW, h, 2, 2, 'F');
    // fill
    doc.setFillColor(...COLORS[tone]);
    doc.roundedRect(trackX, midY - h / 2, (trackW * value) / 5, h, 2, 2, 'F');
    doc.setTextColor(...COLORS.muted);
    doc.text(`${value}/5`, this.x + this.contentW - valW, midY, { baseline: 'middle' });
    this.y += rowH;
  }

  /** Stacked positive/neutral/negative sentiment bar with a legend. */
  sentimentBar(agg: SentimentAgg): void {
    if (agg.total === 0) return;
    const { doc } = this;
    const h = 12;
    this.ensure(h + 18);
    const w = this.contentW;
    let cx = this.x;
    const seg = (n: number, c: RGB) => {
      const sw = (w * n) / agg.total;
      if (sw <= 0) return;
      doc.setFillColor(...c);
      doc.rect(cx, this.y, sw, h, 'F');
      cx += sw;
    };
    seg(agg.positive, [34, 197, 94]);
    seg(agg.neutral, [161, 161, 170]);
    seg(agg.negative, [239, 68, 68]);
    this.y += h + 3;
    doc.setFontSize(8.5);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(...COLORS.pos);
    doc.text(`${pctOf(agg.positive, agg.total)}% positive`, this.x, this.y, { baseline: 'top' });
    doc.setTextColor(...COLORS.muted);
    doc.text(`${pctOf(agg.neutral, agg.total)}% neutral`, this.x + w / 2 - 28, this.y, { baseline: 'top' });
    doc.setTextColor(...COLORS.neg);
    doc.text(`${pctOf(agg.negative, agg.total)}% negative`, this.x + w - doc.getTextWidth(`${pctOf(agg.negative, agg.total)}% negative`), this.y, { baseline: 'top' });
    this.y += 14;
  }

  /** Simple 5-column sentiment table (section + pos/neu/neg/count). */
  sentimentTable(rows: Array<[string, string, string, string, string]>): void {
    const { doc } = this;
    const size = 8.5;
    const rowH = 15;
    const cols = [this.contentW - 230, 60, 60, 60, 50];
    const drawRow = (cells: string[], header: boolean) => {
      this.ensure(rowH);
      doc.setFont('helvetica', header ? 'bold' : 'normal');
      doc.setFontSize(size);
      doc.setTextColor(...(header ? COLORS.muted : COLORS.ink));
      let cx = this.x;
      cells.forEach((cell, i) => {
        const right = i > 0;
        const colW = cols[i]!;
        const tx = right ? cx + colW - doc.getTextWidth(clean(cell)) - 6 : cx;
        doc.text(clean(cell), tx, this.y + rowH / 2, { baseline: 'middle' });
        cx += colW;
      });
      this.y += rowH;
      doc.setDrawColor(...COLORS.line);
      doc.setLineWidth(0.5);
      doc.line(this.x, this.y, this.x + this.contentW, this.y);
    };
    drawRow(['Section', 'Pos', 'Neu', 'Neg', 'Sentences'], true);
    for (const r of rows) drawRow(r, false);
    this.gap(4);
  }

  /** 4-column fundamentals table (metric + current/prior/YoY, right-aligned). */
  fundamentalsTable(rows: Array<[string, string, string, string]>): void {
    const { doc } = this;
    const size = 8.5;
    const rowH = 15;
    const cols = [this.contentW - 220, 90, 90, 40];
    const drawRow = (cells: string[], header: boolean, toneCol3?: Tone) => {
      this.ensure(rowH);
      doc.setFont('helvetica', header ? 'bold' : 'normal');
      doc.setFontSize(size);
      let cx = this.x;
      cells.forEach((cell, i) => {
        const right = i > 0;
        const colW = cols[i]!;
        doc.setTextColor(
          ...(header ? COLORS.muted : i === 3 && toneCol3 ? COLORS[toneCol3] : COLORS.ink),
        );
        const tx = right ? cx + colW - doc.getTextWidth(clean(cell)) - 6 : cx;
        doc.text(clean(cell), tx, this.y + rowH / 2, { baseline: 'middle' });
        cx += colW;
      });
      this.y += rowH;
      doc.setDrawColor(...COLORS.line);
      doc.setLineWidth(0.5);
      doc.line(this.x, this.y, this.x + this.contentW, this.y);
    };
    drawRow(['Metric', 'Current', 'Prior', 'YoY'], true);
    for (const r of rows) {
      const yoy = r[3];
      const tone: Tone | undefined = yoy.startsWith('+') ? 'pos' : yoy.startsWith('-') ? 'neg' : undefined;
      drawRow(r, false, tone);
    }
    this.gap(4);
  }

  /** A filled callout box (cover disclaimer / degraded note). */
  box(str: string, fill: RGB, textColor: RGB): void {
    const size = 8.5;
    const padX = 8, padY = 6;
    const { doc } = this;
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(size);
    const lines = doc.splitTextToSize(clean(str), this.contentW - padX * 2) as string[];
    const lineH = size * 1.4;
    const boxH = lines.length * lineH + padY * 2;
    this.ensure(boxH);
    doc.setFillColor(...fill);
    doc.roundedRect(this.x, this.y, this.contentW, boxH, 4, 4, 'F');
    doc.setTextColor(...textColor);
    let ty = this.y + padY;
    for (const line of lines) {
      doc.text(line, this.x + padX, ty, { baseline: 'top' });
      ty += lineH;
    }
    this.y += boxH;
  }

  rule(): void {
    this.gap(2);
    this.ensure(2);
    this.doc.setDrawColor(...COLORS.line);
    this.doc.setLineWidth(0.5);
    this.doc.line(this.x, this.y, this.x + this.contentW, this.y);
    this.gap(6);
  }

  /** Page footer (page x of y) stamped after the whole doc is laid out. */
  stampFooters(footer: string): void {
    const { doc } = this;
    const pages = doc.getNumberOfPages();
    for (let p = 1; p <= pages; p++) {
      doc.setPage(p);
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(7.5);
      doc.setTextColor(...COLORS.muted);
      doc.text(clean(footer), MARGIN, PAGE.h - 24, { baseline: 'top' });
      doc.text(`Page ${p} of ${pages}`, PAGE.w - MARGIN - doc.getTextWidth(`Page ${p} of ${pages}`), PAGE.h - 24, { baseline: 'top' });
    }
  }
}

// ── content blocks ───────────────────────────────────────────────────────────

function insightBlock(pdf: Pdf, ins: FilingInsight): void {
  pdf.chips([{ text: labelText(ins.label), tone: LABEL_TONE[ins.label] ?? 'mut' }]);
  pdf.text(ins.title, { size: 10.5, style: 'bold' });
  if (ins.summary) pdf.text(ins.summary, { size: 10 });
  if (ins.whyItMatters) pdf.leadIn('Why it matters:', ins.whyItMatters);
  if (ins.investorMeaning) pdf.leadIn('Investor view:', ins.investorMeaning);
  if (ins.evidence) pdf.text(`"${ins.evidence}"`, { size: 9, style: 'italic', color: COLORS.muted, indent: 10 });
  pdf.text(
    `${ins.category}  -  severity ${ins.severity}  -  ${ins.timeHorizon}  -  confidence ${ins.confidence}`,
    { size: 8, color: COLORS.muted },
  );
  pdf.rule();
}

function insightList(pdf: Pdf, insights: FilingInsight[], emptyNote: string): void {
  if (insights.length === 0) {
    pdf.text(emptyNote, { size: 9.5, style: 'italic', color: COLORS.muted, gapAfter: 4 });
    return;
  }
  for (const ins of insights) insightBlock(pdf, ins);
}

function snapshot(pdf: Pdf, a: FilingAnalysis): void {
  pdf.chips([
    { text: labelText(a.overallRead), tone: READ_TONE[a.overallRead] ?? 'mut' },
    { text: a.documentType, tone: 'mut' },
    { text: `Confidence: ${a.confidence}`, tone: 'mut' },
    { text: a.investorSnapshot.timeHorizon, tone: 'mut' },
  ]);
  pdf.text(a.oneSentenceSummary, { size: 12, style: 'italic', color: COLORS.ink, gapAfter: 6 });
  pdf.leadIn('Main financial theme:', a.investorSnapshot.mainFinancialTheme, { color: COLORS.ink });
  pdf.leadIn('Most important investor question:', a.investorSnapshot.mostImportantInvestorQuestion, { color: COLORS.ink });
  if (a.scores) {
    pdf.gap(6);
    pdf.scoreBar('Revenue strength', a.scores.revenueStrength);
    pdf.scoreBar('Margin quality', a.scores.marginQuality);
    pdf.scoreBar('Cash flow quality', a.scores.cashFlowQuality);
    pdf.scoreBar('Balance sheet', a.scores.balanceSheetStrength);
    pdf.scoreBar('Risk level', a.scores.riskLevel, true);
    pdf.scoreBar('Mgmt credibility', a.scores.managementCredibility);
    pdf.scoreBar('Shareholder friendly', a.scores.shareholderFriendliness);
  }
}

function analysisSections(pdf: Pdf, a: FilingAnalysis): void {
  pdf.heading(2, 'Investor snapshot');
  snapshot(pdf, a);

  pdf.heading(2, 'Top investor takeaways');
  insightList(pdf, a.topTakeaways, 'Not enough information in this document.');

  pdf.heading(2, 'What this means');
  pdf.heading(3, 'For revenue');
  insightList(pdf, a.revenueImpact, 'Not enough information.');
  pdf.heading(3, 'For margins & profitability');
  insightList(pdf, a.marginImpact, 'Not enough information.');
  pdf.heading(3, 'For cash flow & balance sheet');
  insightList(pdf, [...a.cashFlowImpact, ...a.balanceSheetHealth], 'Not enough information.');
  pdf.heading(3, 'For shares & investor sentiment');
  insightList(pdf, a.shareImpact, 'Not enough information.');

  pdf.heading(2, 'Risk signals');
  insightList(pdf, a.riskSignals, 'No material investor risks surfaced beyond boilerplate.');

  if (a.managementNarrativeCheck.length > 0) {
    pdf.heading(2, 'Management narrative check');
    for (const n of a.managementNarrativeCheck) {
      pdf.text(`"${n.claim}"`, { size: 10, style: 'bold' });
      pdf.text(n.evidence, { size: 9.5 });
      const tone: Tone = n.assessment === 'Supported' ? 'pos' : n.assessment === 'Not Supported' ? 'neg' : 'warn';
      pdf.chips([{ text: n.assessment, tone }]);
      if (n.investorMeaning) pdf.leadIn('Investor view:', n.investorMeaning);
      pdf.rule();
    }
  }

  if (a.bullCase.length > 0 || a.bearCase.length > 0) {
    pdf.heading(2, 'Bull case vs bear case');
    if (a.bullCase.length > 0) {
      pdf.text('Bull case', { size: 9.5, style: 'bold', color: COLORS.pos });
      for (const b of a.bullCase) pdf.bullet(b);
      pdf.gap(4);
    }
    if (a.bearCase.length > 0) {
      pdf.text('Bear case', { size: 9.5, style: 'bold', color: COLORS.neg });
      for (const b of a.bearCase) pdf.bullet(b);
      pdf.gap(4);
    }
    if (a.netRead) pdf.leadIn('Net read:', a.netRead, { color: COLORS.ink });
  }

  if (a.whatToWatchNext.length > 0) {
    pdf.heading(2, 'What to watch next');
    for (const w of a.whatToWatchNext) {
      pdf.text(w.item, { size: 10, style: 'bold' });
      if (w.whyItMatters) pdf.text(w.whyItMatters, { size: 9.5, color: COLORS.muted });
      if (w.relatedMetric) pdf.text(`Metric: ${w.relatedMetric}`, { size: 8, color: COLORS.muted });
      pdf.gap(4);
    }
  }
}

function summariesSection(pdf: Pdf, data: FilingExportData): void {
  if (data.summaries.length === 0) return;
  pdf.heading(2, 'Section summaries');
  for (const { section, entry } of data.summaries) {
    pdf.heading(3, section.label);
    for (const item of summaryItems(section, entry)) {
      if (item.bullet) pdf.bullet(item.text);
      else pdf.text(item.text, { size: 9.5, gapAfter: 2 });
    }
    pdf.gap(4);
  }
}

// ── fundamentals (XBRL) ─────────────────────────────────────────────────────

function pdfFmtUsd(v: number): string {
  const abs = Math.abs(v);
  const sign = v < 0 ? '-' : '';
  if (abs >= 1e12) return `${sign}$${(abs / 1e12).toFixed(2)}T`;
  if (abs >= 1e9) return `${sign}$${(abs / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `${sign}$${(abs / 1e3).toFixed(1)}K`;
  return `${sign}$${abs.toFixed(2)}`;
}

function pdfFmtShares(v: number): string {
  const abs = Math.abs(v);
  if (abs >= 1e9) return `${(abs / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${(abs / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `${(abs / 1e3).toFixed(1)}K`;
  return abs.toFixed(0);
}

function pdfFmtValue(v: number, unit: XbrlUnit): string {
  switch (unit) {
    case 'USD': return pdfFmtUsd(v);
    case 'USD/shares': return `$${v.toFixed(2)}`;
    case 'shares': return pdfFmtShares(v);
    case 'pure': return `${(v * 100).toFixed(1)}%`;
    default: return v.toLocaleString();
  }
}

function pdfFmtPct(v: number): string {
  const pct = v * 100;
  return `${pct > 0 ? '+' : ''}${pct.toFixed(1)}%`;
}

function fundamentalsSection(pdf: Pdf, data: FilingExportData): void {
  const xbrl = data.doc.xbrl;
  if (!xbrl || xbrl.facts.length === 0) return;

  pdf.heading(2, 'Fundamentals (XBRL)');
  const period = [
    xbrl.periodEnd ? fmtDate(xbrl.periodEnd) : '',
    xbrl.priorPeriodEnd ? `vs ${fmtDate(xbrl.priorPeriodEnd)}` : '',
  ].filter(Boolean).join('   ');
  pdf.text(
    `From the filing's own XBRL data - exact figures, not AI-generated.${period ? `  ${period}` : ''}`,
    { size: 8.5, style: 'italic', color: COLORS.muted, gapAfter: 4 },
  );

  const rows: Array<[string, string, string, string]> = xbrl.facts.map((f) => [
    f.label,
    pdfFmtValue(f.currentValue, f.unit),
    f.priorValue !== undefined ? pdfFmtValue(f.priorValue, f.unit) : '-',
    f.yoyPct !== undefined ? pdfFmtPct(f.yoyPct) : '-',
  ]);
  for (const m of xbrl.metrics) {
    const delta = m.prior !== undefined ? m.current - m.prior : undefined;
    rows.push([
      m.label,
      `${(m.current * 100).toFixed(1)}%`,
      m.prior !== undefined ? `${(m.prior * 100).toFixed(1)}%` : '-',
      delta !== undefined ? `${delta > 0 ? '+' : ''}${(delta * 100).toFixed(1)}pt` : '-',
    ]);
  }
  pdf.fundamentalsTable(rows);
}

function sentimentSection(pdf: Pdf, data: FilingExportData): void {
  const results = data.sentiment;
  if (!results || results.length === 0) return;
  const overall = aggregateSentiment(results);
  if (overall.total === 0) return;

  pdf.heading(2, 'Sentiment analysis');
  pdf.text(`${overall.total} sentences scored on-device (FinBERT).`, { size: 8.5, color: COLORS.muted, gapAfter: 4 });
  pdf.sentimentBar(overall);
  pdf.text(sentimentConsensus(overall), { size: 9.5, color: COLORS.muted, gapAfter: 6 });

  const labelOf = new Map(data.doc.sections.map((s) => [s.id, s.label]));
  const bySection = new Map<string, typeof results>();
  for (const r of results) {
    const arr = bySection.get(r.sectionId) ?? [];
    arr.push(r);
    bySection.set(r.sectionId, arr);
  }
  const rows = [...bySection.entries()].map(([id, arr]) => {
    const a = aggregateSentiment(arr);
    return [
      labelOf.get(id) ?? id.replace(/_/g, ' '),
      `${pctOf(a.positive, a.total)}%`,
      `${pctOf(a.neutral, a.total)}%`,
      `${pctOf(a.negative, a.total)}%`,
      `${a.total}`,
    ] as [string, string, string, string, string];
  });
  pdf.sentimentTable(rows);
}

function redlineSection(pdf: Pdf, data: FilingExportData): void {
  const r = data.redline;
  if (!r) return;

  if (r.status === 'no_prior') {
    pdf.heading(2, 'Redline — year-over-year changes');
    pdf.text(`No prior comparable ${data.doc.filingType} was found on EDGAR for this company.`, { size: 9.5, style: 'italic', color: COLORS.muted });
    return;
  }
  if (r.status === 'unsupported_form') {
    pdf.heading(2, 'Redline — year-over-year changes');
    pdf.text(`A year-over-year comparison isn't available for ${data.doc.filingType} filings.`, { size: 9.5, style: 'italic', color: COLORS.muted });
    return;
  }
  if (r.diffs.length === 0 && r.alignment.length === 0) return;

  pdf.heading(2, 'Redline — year-over-year changes');
  if (r.prior) {
    pdf.text(
      `Compared against ${r.prior.form} filed ${r.prior.filingDate} (period ${r.prior.reportDate}).`,
      { size: 8.5, color: COLORS.muted },
    );
    pdf.text(`Source: ${r.prior.url}`, { size: 8, color: COLORS.muted, gapAfter: 4 });
  }

  const added = r.alignment.filter((a) => a.status === 'added');
  const removed = r.alignment.filter((a) => a.status === 'removed');
  if (added.length || removed.length) {
    pdf.heading(3, 'Structural changes');
    for (const a of added) pdf.text(`+ New section: ${a.label}`, { size: 9, color: COLORS.pos });
    for (const a of removed) pdf.text(`- Removed section: ${a.label}`, { size: 9, color: COLORS.neg });
    pdf.gap(4);
  }

  const labelOf = new Map(data.doc.sections.map((s) => [s.id, s.label]));
  const MAX = 6;
  for (const d of r.diffs) {
    const label = labelOf.get(d.sectionId) ?? d.sectionId.replace(/_/g, ' ');
    pdf.heading(3, `${label}  -  ${Math.round(d.magnitude * 100)}% changed`);
    if (d.summary) pdf.text(d.summary, { size: 9.5 });
    for (const s of d.added.slice(0, MAX)) pdf.text(`+ ${s.text}`, { size: 9, color: COLORS.pos, indent: 6 });
    for (const s of d.removed.slice(0, MAX)) pdf.text(`- ${s.text}`, { size: 9, color: COLORS.neg, indent: 6 });
    if (d.added.length > MAX || d.removed.length > MAX) {
      pdf.text(
        `+${Math.max(0, d.added.length - MAX)} more additions, ${Math.max(0, d.removed.length - MAX)} more removals not shown.`,
        { size: 8, color: COLORS.muted },
      );
    }
    pdf.gap(4);
  }
}

// ── public API ───────────────────────────────────────────────────────────────

/** Render the full export into a jsPDF document. */
export function buildFilingReportPdf(data: FilingExportData): jsPDF {
  const pdf = new Pdf();
  const { doc, analysis: a } = data;

  // Cover.
  pdf.text('RELIC', { size: 10, style: 'bold', color: COLORS.accent, lineFactor: 1.2 });
  pdf.text(`${doc.companyName ?? 'Unknown company'}${doc.ticker ? `  (${doc.ticker})` : ''}`, {
    size: 22, style: 'bold', font: 'times', lineFactor: 1.2, gapAfter: 2,
  });
  const metaLine = [
    doc.filingType,
    doc.periodOfReport ? `Period ${fmtDate(doc.periodOfReport)}` : '',
    doc.filedAt ? `Filed ${fmtDate(doc.filedAt)}` : '',
    `${doc.sections.length} sections`,
  ].filter(Boolean).join('   -   ');
  pdf.text(metaLine, { size: 9.5, color: COLORS.muted });
  pdf.text(doc.source.url, { size: 8, color: COLORS.muted, gapAfter: 6 });
  if (a?.degraded) {
    pdf.box(
      'Generated in extractive mode (Chrome built-in AI unavailable) - investor cards are derived from on-device deterministic signals.',
      [244, 244, 245], COLORS.ink,
    );
    pdf.gap(4);
  }

  // Body.
  fundamentalsSection(pdf, data);
  if (a) {
    analysisSections(pdf, a);
  } else {
    pdf.heading(2, 'Investor analysis');
    pdf.text('No investor analysis is cached for this document. Open the Analyst tab to generate it, then export again.', {
      size: 9.5, style: 'italic', color: COLORS.muted,
    });
  }
  summariesSection(pdf, data);
  sentimentSection(pdf, data);
  redlineSection(pdf, data);

  pdf.stampFooters(
    `Generated by Relic v${data.appVersion} on ${fmtDateTime(data.generatedAt)} - all analysis ran on-device.`,
  );

  // Identity block + structured XMP sidecar. Renders nothing; makes the export
  // self-describing to the OS and machine-readable to a reader (see ./metadata).
  stampExportMetadata(pdf.doc, data);
  return pdf.doc;
}

/** Build the PDF and trigger a one-click download to the user's Downloads. */
export function downloadFilingReportPdf(data: FilingExportData): void {
  buildFilingReportPdf(data).save(reportFilename(data, 'pdf'));
}
