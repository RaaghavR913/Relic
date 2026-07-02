// ============================================================
// Relic — Fundamentals card (Analyst tab)
// ------------------------------------------------------------
// Renders the deterministic line items parsed from the filing's own inline XBRL
// (src/content/ingest/xbrl.ts) — exact figures straight from the source, not model
// output, so nothing here needs evidence verification. Shown only when the
// filing carried inline XBRL facts; otherwise this renders nothing.
// ============================================================

import type { DocumentModel, XbrlFact, XbrlMetric, XbrlUnit } from '@/types';

// Mirrors the jump-to-source pattern used for verified insight evidence
// (see AnalystPanel.tsx) — a direct tabs.sendMessage to the content script.
async function highlightEvidence(range: [number, number]): Promise<void> {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tabId = tabs[0]?.id;
  if (tabId === undefined) return;
  await chrome.tabs.sendMessage(tabId, {
    target: 'content',
    type: 'HIGHLIGHT_RANGE',
    charRange: range, // already DOCUMENT-space
  });
}

// ── formatting ────────────────────────────────────────────────────────────────

function fmtUsd(v: number): string {
  const abs = Math.abs(v);
  const sign = v < 0 ? '-' : '';
  if (abs >= 1e12) return `${sign}$${(abs / 1e12).toFixed(2)}T`;
  if (abs >= 1e9) return `${sign}$${(abs / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `${sign}$${(abs / 1e3).toFixed(1)}K`;
  return `${sign}$${abs.toFixed(2)}`;
}

function fmtShares(v: number): string {
  const abs = Math.abs(v);
  if (abs >= 1e9) return `${(abs / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${(abs / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `${(abs / 1e3).toFixed(1)}K`;
  return abs.toFixed(0);
}

function fmtValue(v: number, unit: XbrlUnit): string {
  switch (unit) {
    case 'USD': return fmtUsd(v);
    case 'USD/shares': return `$${v.toFixed(2)}`;
    case 'shares': return fmtShares(v);
    case 'pure': return `${(v * 100).toFixed(1)}%`;
    default: return v.toLocaleString();
  }
}

function fmtPct(v: number): string {
  const pct = v * 100;
  const sign = pct > 0 ? '+' : '';
  return `${sign}${pct.toFixed(1)}%`;
}

function fmtDate(iso?: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function deltaColor(v: number | undefined): string {
  if (v === undefined) return 'text-zinc-600';
  if (v > 0) return 'text-emerald-400';
  if (v < 0) return 'text-red-400';
  return 'text-zinc-500';
}

// ── rows ──────────────────────────────────────────────────────────────────────

function FactRow({ fact }: { fact: XbrlFact }) {
  return (
    <tr className="border-t border-zinc-800/60">
      <td className="py-1.5 pr-2 text-[11px] text-zinc-400">{fact.label}</td>
      <td className="py-1.5 px-2 text-right text-[11px] font-medium tabular-nums text-zinc-200">
        {fmtValue(fact.currentValue, fact.unit)}
      </td>
      <td className="py-1.5 px-2 text-right text-[11px] tabular-nums text-zinc-500">
        {fact.priorValue !== undefined ? fmtValue(fact.priorValue, fact.unit) : '—'}
      </td>
      <td className={`py-1.5 pl-2 text-right text-[11px] font-medium tabular-nums ${deltaColor(fact.yoyPct)}`}>
        {fact.yoyPct !== undefined ? fmtPct(fact.yoyPct) : '—'}
      </td>
      <td className="py-1.5 pl-1.5 text-right">
        {fact.range && (
          <button
            onClick={() => void highlightEvidence(fact.range!).catch(() => {})}
            title="Show in document"
            aria-label={`Show ${fact.label} in document`}
            className="text-[10px] text-zinc-600 transition hover:text-sky-400 focus-visible:outline focus-visible:outline-sky-500"
          >
            ↗
          </button>
        )}
      </td>
    </tr>
  );
}

function MetricRow({ metric }: { metric: XbrlMetric }) {
  const delta = metric.prior !== undefined ? metric.current - metric.prior : undefined;
  return (
    <tr className="border-t border-zinc-800/60">
      <td className="py-1.5 pr-2 text-[11px] text-zinc-400">{metric.label}</td>
      <td className="py-1.5 px-2 text-right text-[11px] font-medium tabular-nums text-zinc-200">
        {(metric.current * 100).toFixed(1)}%
      </td>
      <td className="py-1.5 px-2 text-right text-[11px] tabular-nums text-zinc-500">
        {metric.prior !== undefined ? `${(metric.prior * 100).toFixed(1)}%` : '—'}
      </td>
      <td className={`py-1.5 pl-2 text-right text-[11px] font-medium tabular-nums ${deltaColor(delta)}`}>
        {delta !== undefined ? `${delta > 0 ? '+' : ''}${(delta * 100).toFixed(1)}pt` : '—'}
      </td>
      <td className="py-1.5 pl-1.5" />
    </tr>
  );
}

// ── panel ─────────────────────────────────────────────────────────────────────

export function FundamentalsPanel({ doc }: { doc: DocumentModel }) {
  const xbrl = doc.xbrl;
  if (!xbrl || xbrl.facts.length === 0) return null;

  return (
    <section
      aria-labelledby="fundamentals-heading"
      className="rounded-xl bg-zinc-900 p-3.5 ring-1 ring-zinc-800"
    >
      <div className="flex items-center justify-between gap-2">
        <p
          id="fundamentals-heading"
          className="text-[13px] font-medium uppercase tracking-widest text-zinc-500 font-[Times,serif]"
        >
          Fundamentals
        </p>
        {xbrl.periodEnd && (
          <span className="text-[10px] text-zinc-600 font-['Roboto',-apple-system,BlinkMacSystemFont,sans-serif]">
            {fmtDate(xbrl.periodEnd)}
            {xbrl.priorPeriodEnd ? ` vs ${fmtDate(xbrl.priorPeriodEnd)}` : ''}
          </span>
        )}
      </div>
      <div className="mt-2.5 overflow-x-auto">
        <table className="w-full border-collapse font-['Roboto',-apple-system,BlinkMacSystemFont,sans-serif]">
          <thead>
            <tr>
              <th className="pb-1 text-left text-[9px] font-semibold uppercase tracking-wider text-zinc-600">Metric</th>
              <th className="pb-1 px-2 text-right text-[9px] font-semibold uppercase tracking-wider text-zinc-600">Current</th>
              <th className="pb-1 px-2 text-right text-[9px] font-semibold uppercase tracking-wider text-zinc-600">Prior</th>
              <th className="pb-1 pl-2 text-right text-[9px] font-semibold uppercase tracking-wider text-zinc-600">YoY</th>
              <th className="pb-1 pl-1.5" aria-hidden="true" />
            </tr>
          </thead>
          <tbody>
            {xbrl.facts.map((f) => <FactRow key={f.concept} fact={f} />)}
            {xbrl.metrics.map((m) => <MetricRow key={m.label} metric={m} />)}
          </tbody>
        </table>
      </div>
    </section>
  );
}
