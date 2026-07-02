// ============================================================
// Relic — first-run experience (Session 7, light)
// ------------------------------------------------------------
// Shown once (gated by chrome.storage.local 'relic:onboarded'):
//   • Privacy explainer — 100% on-device.
//   • Bundled models: embeddings + FinBERT ship inside the extension (no network
//     fetch at runtime). Gemini Nano is downloaded + managed by Chrome itself.
//   • Detected generation tier, framed positively for extractive.
//   • Progressive enablement note: sentiment/flags work before generation is ready.
// ============================================================

import { m, useReducedMotion } from 'framer-motion';
import type { Capabilities } from '@/runtime/capabilities';
import { TierBadge, Banner, BrandLogo, LockIcon, stateLabel, stateColor } from './ui';

const ENCODER_MODELS = [
  { name: 'Encoder', role: 'Extractive summary & redline matching' },
  { name: 'FinBERT', role: 'Financial sentiment & tone analysis' },
];

function Check() {
  return (
    <svg viewBox="0 0 20 20" fill="currentColor" className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-400" aria-hidden="true">
      <path fillRule="evenodd" d="M16.7 5.3a1 1 0 010 1.4l-7.5 7.5a1 1 0 01-1.4 0l-3.5-3.5a1 1 0 111.4-1.4l2.8 2.8 6.8-6.8a1 1 0 011.4 0z" clipRule="evenodd" />
    </svg>
  );
}

export function FirstRun({ caps, onDone }: { caps: Capabilities; onDone: () => void }) {
  const reduced = useReducedMotion() ?? false;
  const builtin = caps.generationTier === 'builtin';
  const nanoState = caps.promptApi;

  return (
    <m.div
      initial={reduced ? false : { opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3 }}
      className="flex flex-col gap-4"
    >
      {/* Hero */}
      <div className="flex flex-col items-center gap-2 pt-2 text-center">
        <BrandLogo className="h-12 w-12" />
        <h1 className="text-[17px] font-semibold text-zinc-100 font-[Georgia,serif]">Welcome to Relic</h1>
        <p className="max-w-xs text-base leading-relaxed text-zinc-400 font-[Georgia,serif]">
          Understand company filings like an investor.
        </p>
      </div>

      {/* Privacy explainer */}
      <section className="rounded-xl bg-zinc-900 p-4 ring-1 ring-zinc-800 text-[13px] font-['Roboto',-apple-system,BlinkMacSystemFont,sans-serif]">
        <p className="mb-2 flex items-center gap-1.5 font-semibold uppercase text-zinc-200">
          <LockIcon className="h-3.5 w-3.5 text-emerald-400" /> Private by design
        </p>
        <ul className="flex flex-col gap-1.5 text-xs leading-relaxed text-zinc-400">
          <li className="flex gap-2"><Check /> Your research stays on your computer.</li>
          <li className="flex gap-2"><Check /> No filing text, summaries, or notes are uploaded.</li>
          <li className="flex gap-2"><Check /> Relic only connects to SEC EDGAR for the filings you are already viewing.</li>
        </ul>
      </section>

      {/* Downloads */}
      <section className="rounded-xl bg-zinc-900 p-4 ring-1 ring-zinc-800 text-[13px] font-['Roboto',-apple-system,BlinkMacSystemFont,sans-serif]">
        <p className="mb-2 font-semibold uppercase text-zinc-200">
          Models bundled with the extension
        </p>
        <ul className="flex flex-col gap-2">
          {ENCODER_MODELS.map((m) => (
            <li key={m.name} className="text-xs">
              <span className="font-medium text-zinc-200">{m.name}</span>
              <span className="block text-zinc-500">{m.role}</span>
            </li>
          ))}
        </ul>
      </section>

      {/* Generation tier */}
      <section className="rounded-xl bg-zinc-900 p-4 ring-1 ring-zinc-800 text-[13px] font-['Roboto',-apple-system,BlinkMacSystemFont,sans-serif]">
        <div className="mb-2 flex items-center gap-2">
          <p className="font-semibold uppercase text-zinc-200">Generation mode</p>
          <span className="ml-auto"><TierBadge tier={caps.generationTier} /></span>
        </div>

        {builtin ? (
          <>
            <p className="text-xs leading-relaxed text-zinc-400 font-['Roboto',-apple-system,BlinkMacSystemFont,sans-serif]">
              Relic analyzes SEC filings privately on your device, turning them into clear summaries,
              analyst notes, and change narratives powered by Gemini Nano with zero cloud.
            </p>
            <div className="mt-2 flex items-center justify-between rounded-lg bg-zinc-800/50 px-3 py-2 text-xs">
              <span className="text-zinc-300">Gemini Nano</span>
              <span className={stateColor(nanoState)}>{stateLabel(nanoState)}</span>
            </div>
            {(nanoState === 'downloadable' || nanoState === 'downloading') && (
              <p className="mt-2 text-[10px] leading-relaxed text-zinc-600">
                Chrome will download and manage Gemini Nano the first time you generate an analyst note —
                you’ll see its progress then. Language flags and sentiment analysis work right away in the meantime.
              </p>
            )}
          </>
        ) : (
          <Banner tone="positive" icon="✓">
            Built-in AI isn’t available on this device, so Relic runs in <strong>extractive mode</strong>:
            summaries become the filing’s most important sentences. Sentiment scores, language-flag underlines, and the year-over-year
            Redline are fully available — all on-device.
          </Banner>
        )}
      </section>

      {/* Progressive enablement note */}
      <p className="px-1 text-[13px] leading-relaxed text-emerald-400 font-[system-ui,-apple-system,BlinkMacSystemFont,sans-serif]">
        Info: Language flags underline the filing immediately; sentiment scores run on demand in the Sentiment tab. Generative features switch on
        automatically once the model is ready.
      </p>

      {/* CTA */}
      <button
        onClick={onDone}
        className="w-full rounded-lg bg-sky-600 py-2.5 text-base font-semibold font-[Georgia,serif] text-white transition hover:bg-sky-500 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-500"
      >
        Get Started
      </button>
    </m.div>
  );
}
