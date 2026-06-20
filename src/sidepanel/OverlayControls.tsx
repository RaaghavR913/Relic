// ============================================================
// Disclora — overlay control surface (Session 7)
// ------------------------------------------------------------
// Master on/off toggle for the sentiment heatmap overlay plus an accessible legend.
//
// WCAG AA: every colour swatch is paired with a non-colour cue (underline style)
// and a text label; the legend is keyboard-reachable inside a <details>.
// ============================================================

import { m, AnimatePresence, useReducedMotion } from 'framer-motion';
import { useState } from 'react';
import { useOverlayPrefs } from './overlayPrefs';

// ── toggle switch ─────────────────────────────────────────────────────────────

function Switch({
  checked,
  onChange,
  label,
  on,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  on: string; // active colour class
}) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      aria-label={`${label} overlay ${checked ? 'on' : 'off'}`}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-500 ${
        checked ? on : 'bg-zinc-700'
      }`}
    >
      <span
        className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white shadow-sm transition-transform ${
          checked ? 'translate-x-4' : 'translate-x-0.5'
        }`}
      />
    </button>
  );
}

// ── legend rows ───────────────────────────────────────────────────────────────

function LegendSwatch({ style }: { style: React.CSSProperties }) {
  return <span className="inline-block h-3 w-5 shrink-0 rounded-sm" style={style} aria-hidden="true" />;
}

function SentimentLegend() {
  return (
    <div className="flex flex-col gap-1.5">
      <p className="text-[10px] font-medium uppercase tracking-wider text-zinc-600">Sentiment</p>
      <div className="flex flex-wrap gap-x-4 gap-y-1.5 text-[11px] text-zinc-400">
        <span className="flex items-center gap-1.5">
          <LegendSwatch style={{ background: 'rgba(34,197,94,0.32)', borderBottom: '2px solid rgba(34,197,94,0.9)' }} />
          Positive <span className="text-zinc-600">(solid underline)</span>
        </span>
        <span className="flex items-center gap-1.5">
          <LegendSwatch style={{ background: 'rgba(239,68,68,0.32)', borderBottom: '2px dashed rgba(239,68,68,0.9)' }} />
          Negative <span className="text-zinc-600">(wavy underline)</span>
        </span>
        <span className="flex items-center gap-1.5">
          <LegendSwatch style={{ background: 'rgba(161,161,170,0.15)' }} />
          Neutral
        </span>
        <span className="w-full text-zinc-600">Opacity = confidence · table regions excluded</span>
      </div>
    </div>
  );
}

const FLAG_LEGEND: Array<{ label: string; marker: string; style: React.CSSProperties }> = [
  { label: 'Uncertainty', marker: '- -', style: { background: 'rgba(245,158,11,0.22)', borderBottom: '2px dashed rgba(245,158,11,0.9)' } },
  { label: 'Weak modal', marker: '···', style: { background: 'rgba(14,165,233,0.18)', borderBottom: '2px dotted rgba(14,165,233,0.9)' } },
  { label: 'Litigious', marker: '══', style: { background: 'rgba(239,68,68,0.22)', borderBottom: '3px double rgba(239,68,68,0.9)' } },
  { label: 'Negative', marker: '~~~', style: { background: 'rgba(244,63,94,0.20)', borderBottom: '2px solid rgba(244,63,94,0.7)' } },
];

function FlagLegend() {
  return (
    <div className="flex flex-col gap-1.5">
      <p className="text-[10px] font-medium uppercase tracking-wider text-zinc-600">Language flags</p>
      <div className="flex flex-wrap gap-x-4 gap-y-1.5 text-[11px] text-zinc-400">
        {FLAG_LEGEND.map((f) => (
          <span key={f.label} className="flex items-center gap-1.5">
            <LegendSwatch style={f.style} />
            {f.label}{' '}
            <span aria-hidden="true" className="font-mono tracking-widest text-zinc-600">{f.marker}</span>
          </span>
        ))}
      </div>
    </div>
  );
}

// ── main control surface ──────────────────────────────────────────────────────

export function OverlayControls() {
  const reduced = useReducedMotion() ?? false;
  const { prefs, setHeatmap } = useOverlayPrefs();
  const [legendOpen, setLegendOpen] = useState(false);

  return (
    <section
      aria-label="Page overlay controls"
      className="rounded-xl bg-zinc-900 p-3 ring-1 ring-zinc-800 [&_span]:font-['SF_Pro_Display',-apple-system,BlinkMacSystemFont,sans-serif]"
    >
      <div className="flex items-center justify-between gap-3">
        <button
          onClick={() => setLegendOpen((v) => !v)}
          aria-expanded={legendOpen}
          className="flex shrink-0 items-center gap-1 text-[11px] text-zinc-500 transition hover:text-zinc-300 focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-500"
        >
          <span>Legend</span>
          <svg className={`h-3 w-3 transition-transform ${legendOpen ? 'rotate-180' : ''}`} viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
            <path fillRule="evenodd" d="M5.22 8.22a.75.75 0 011.06 0L10 11.94l3.72-3.72a.75.75 0 111.06 1.06l-4.25 4.25a.75.75 0 01-1.06 0L5.22 9.28a.75.75 0 010-1.06z" clipRule="evenodd" />
          </svg>
        </button>
        <div className="flex shrink-0 items-center gap-4">
          <label className="flex items-center gap-2 text-[11px] text-zinc-300">
            Heatmap
            <Switch checked={prefs.heatmap} onChange={setHeatmap} label="Sentiment heatmap" on="bg-green-600" />
          </label>
        </div>
      </div>

      {prefs.heatmap && (
        <p className="mt-2 text-[10px] text-zinc-600">
          Heatmap shows once you run analysis in the <span className="text-zinc-400">Sentiment</span> tab.
        </p>
      )}

      <AnimatePresence initial={false}>
        {legendOpen && (
          <m.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={reduced ? { duration: 0 } : { duration: 0.18 }}
            className="overflow-hidden"
          >
            <div className="mt-2 flex flex-col gap-3 border-t border-zinc-800 pt-2.5">
              <SentimentLegend />
              <FlagLegend />
            </div>
          </m.div>
        )}
      </AnimatePresence>
    </section>
  );
}
