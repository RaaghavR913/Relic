// ============================================================
// FilingLens — first-run experience (Session 7, light)
// ------------------------------------------------------------
// Shown once (gated by chrome.storage.local 'filinglens:onboarded'):
//   • Privacy explainer — 100% on-device.
//   • Bundled models: embeddings + FinBERT ship inside the extension (no network
//     fetch at runtime). Gemini Nano is downloaded + managed by Chrome itself.
//   • Detected generation tier, framed positively for extractive.
//   • Progressive enablement note: sentiment/flags work before generation is ready.
// ============================================================

import { motion, useReducedMotion } from 'framer-motion';
import type { Capabilities } from '@/runtime/capabilities';
import { TierBadge, Banner, BrandLogo, LockIcon, stateLabel, stateColor } from './ui';

const ENCODER_MODELS = [
  { name: 'mxbai-embed-xsmall', role: 'Extractive summary & redline embeddings', size: '~23 MB' },
  { name: 'FinBERT', role: 'Sentence-level financial sentiment', size: '~106 MB' },
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
    <motion.div
      initial={reduced ? false : { opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3 }}
      className="flex flex-col gap-4"
    >
      {/* Hero */}
      <div className="flex flex-col items-center gap-2 pt-2 text-center">
        <BrandLogo className="h-12 w-12" />
        <h1 className="text-base font-semibold text-zinc-100">Welcome to FilingLens</h1>
        <p className="max-w-xs text-xs leading-relaxed text-zinc-400">
          Plain-English summaries, sentiment, language flags, and year-over-year
          changes — analyzed entirely on your device.
        </p>
      </div>

      {/* Privacy explainer */}
      <section className="rounded-xl bg-zinc-900 p-4 ring-1 ring-zinc-800">
        <p className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-zinc-200">
          <LockIcon className="h-3.5 w-3.5 text-emerald-400" /> Private by design
        </p>
        <ul className="flex flex-col gap-1.5 text-[11px] leading-relaxed text-zinc-400">
          <li className="flex gap-2"><Check /> No filing text or analysis ever leaves your computer.</li>
          <li className="flex gap-2"><Check /> The only network calls are to SEC EDGAR — the filings you’re already viewing.</li>
          <li className="flex gap-2"><Check /> The AI models ship inside the extension — nothing is fetched from third parties.</li>
        </ul>
      </section>

      {/* Downloads */}
      <section className="rounded-xl bg-zinc-900 p-4 ring-1 ring-zinc-800">
        <p className="mb-2 text-[10px] font-medium uppercase tracking-widest text-zinc-500">
          Models bundled with the extension
        </p>
        <ul className="flex flex-col gap-2">
          {ENCODER_MODELS.map((m) => (
            <li key={m.name} className="flex items-center gap-2 text-[11px]">
              <span className="flex-1">
                <span className="font-medium text-zinc-200">{m.name}</span>
                <span className="block text-zinc-500">{m.role}</span>
              </span>
              <span className="shrink-0 rounded bg-zinc-800 px-1.5 py-0.5 font-mono text-[10px] text-zinc-400">{m.size}</span>
            </li>
          ))}
        </ul>
        <p className="mt-2 text-[10px] leading-relaxed text-zinc-600">
          Included in the extension and loaded locally the first time you use sentiment or extractive summaries — no download, no network request.
        </p>
      </section>

      {/* Generation tier */}
      <section className="rounded-xl bg-zinc-900 p-4 ring-1 ring-zinc-800">
        <div className="mb-2 flex items-center gap-2">
          <p className="text-[10px] font-medium uppercase tracking-widest text-zinc-500">Generation mode</p>
          <span className="ml-auto"><TierBadge tier={caps.generationTier} /></span>
        </div>

        {builtin ? (
          <>
            <p className="text-[11px] leading-relaxed text-zinc-400">
              Chrome’s built-in AI is available — summaries, analyst notes, and change narratives are
              synthesized on-device by Gemini Nano.
            </p>
            <div className="mt-2 flex items-center justify-between rounded-lg bg-zinc-800/50 px-3 py-2 text-[11px]">
              <span className="text-zinc-300">Gemini Nano</span>
              <span className={stateColor(nanoState)}>{stateLabel(nanoState)}</span>
            </div>
            {(nanoState === 'downloadable' || nanoState === 'downloading') && (
              <p className="mt-2 text-[10px] leading-relaxed text-zinc-600">
                Chrome will download and manage Gemini Nano the first time you generate an analyst note —
                you’ll see its progress then. Sentiment and flags work right away in the meantime.
              </p>
            )}
          </>
        ) : (
          <Banner tone="positive" icon="✓">
            Built-in AI isn’t available on this device, so FilingLens runs in <strong>extractive mode</strong>:
            summaries become the filing’s most important sentences. Sentiment, flags, and year-over-year
            changes are fully available — all on-device.
          </Banner>
        )}
      </section>

      {/* Progressive enablement note */}
      <p className="px-1 text-[10px] leading-relaxed text-zinc-600">
        Tip: Sentiment and language flags are available immediately. Generative features switch on
        automatically once their model is ready.
      </p>

      {/* CTA */}
      <button
        onClick={onDone}
        className="w-full rounded-lg bg-sky-600 py-2.5 text-sm font-semibold text-white transition hover:bg-sky-500 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-500"
      >
        Get started
      </button>
    </motion.div>
  );
}
