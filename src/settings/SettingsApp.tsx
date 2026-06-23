// ============================================================
// Disclora — extension settings & how-it-works page
// ------------------------------------------------------------
// Opened from the side-panel header (chrome.runtime.openOptionsPage).
// ============================================================

import { useCallback, type ReactNode } from 'react';
import { useCapabilities } from '@/runtime/useCapabilities';
import { WORKS_TIERS } from '@/shared/worksTiers';
import { Switch } from '@/sidepanel/OverlayControls';
import { useOverlayPrefs } from '@/sidepanel/overlayPrefs';
import {
  Banner,
  BrandLogo,
  LockIcon,
  TierBadge,
  VERSION_ACCENT,
  stateColor,
  stateLabel,
} from '@/sidepanel/ui';

const ONBOARDED_KEY = 'disclora:onboarded';

const HOW_IT_WORKS: ReadonlyArray<{ step: string; detail: string }> = [
  {
    step: 'Open a filing',
    detail:
      'Navigate to an SEC EDGAR .htm filing or a supported mirror page. Disclora activates in the side panel when it detects readable document content.',
  },
  {
    step: 'Analyze the page',
    detail:
      'Click Analyze this page if Disclora has not already ingested the document. Parsing, section detection, and language flags run entirely on your device.',
  },
  {
    step: 'Use the tabs',
    detail:
      'Analyst builds an investor-style read. Summary condenses each section. Sentiment scores overall tone with FinBERT. Changes compares against the prior-year filing.',
  },
  {
    step: 'Highlight on the page',
    detail:
      'Language-flag underlines paint directly on the filing, marking uncertainty, weak-modal, litigious, and negative phrasing. Toggle them below.',
  },
];

const BUNDLED_MODELS = [
  { name: 'Encoder', role: 'Extractive summary & redline matching', size: '~23 MB' },
  { name: 'FinBERT', role: 'Financial sentiment & tone analysis', size: '~106 MB' },
];

function Section({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="rounded-xl bg-zinc-900 p-4 ring-1 ring-zinc-800">
      <h2 className="text-[13px] font-semibold uppercase tracking-wide text-zinc-200">{title}</h2>
      <div className="mt-3">{children}</div>
    </section>
  );
}

export default function SettingsApp() {
  const { caps } = useCapabilities();
  const { prefs, loaded, setFlags } = useOverlayPrefs();
  const version = chrome.runtime.getManifest().version;

  const replayOnboarding = useCallback(() => {
    chrome.storage.local.remove(ONBOARDED_KEY).catch(() => {});
  }, []);

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 selection:bg-sky-500/30">
      <header className="border-b border-zinc-800 px-6 py-5">
        <div className="mx-auto flex max-w-2xl items-center gap-3">
          <BrandLogo className="h-8 w-8" />
          <div>
            <h1 className="text-lg font-semibold tracking-tight text-zinc-100">Disclora</h1>
            <p className="text-sm text-zinc-500">How it works &amp; settings</p>
          </div>
          <span
            className="ml-auto text-sm font-[system-ui,-apple-system,BlinkMacSystemFont,sans-serif]"
            style={{ color: VERSION_ACCENT }}
          >
            v{version}
          </span>
        </div>
      </header>

      <main className="mx-auto flex max-w-2xl flex-col gap-4 px-6 py-6">
        <Section title="How it works">
          <ol className="flex flex-col gap-3">
            {HOW_IT_WORKS.map((item, i) => (
              <li key={item.step} className="flex gap-3 text-sm leading-relaxed text-zinc-400">
                <span
                  className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-zinc-800 text-xs font-semibold text-zinc-300"
                  aria-hidden="true"
                >
                  {i + 1}
                </span>
                <span>
                  <span className="font-medium text-zinc-200">{item.step}</span>
                  <span className="mt-0.5 block">{item.detail}</span>
                </span>
              </li>
            ))}
          </ol>
        </Section>

        <Section title="Where Disclora works best">
          <ul className="flex flex-col gap-3 text-sm leading-relaxed text-zinc-400">
            {WORKS_TIERS.map((t) => (
              <li key={t.label}>
                <span className="font-medium text-zinc-200">{t.label}</span>
                <span className="mt-0.5 block">{t.detail}</span>
              </li>
            ))}
          </ul>
        </Section>

        <Section title="Page overlays">
          <p className="mb-3 text-sm leading-relaxed text-zinc-400">
            Control on-page highlights for the active browser tab. Changes apply immediately.
          </p>
          <div className="flex flex-col gap-3">
            <label className="flex items-center justify-between gap-3 text-sm text-zinc-300">
              <span>
                <span className="font-medium text-zinc-200">Language flags</span>
                <span className="mt-0.5 block text-xs text-zinc-500">
                  Underlines for uncertainty, weak modal, litigious, and negative phrasing.
                </span>
              </span>
              <Switch
                checked={loaded ? prefs.flags : true}
                onChange={setFlags}
                label="Language flags"
                on="bg-sky-600"
              />
            </label>
          </div>
        </Section>

        <Section title="Private by design">
          <p className="mb-2 flex items-center gap-1.5 text-sm font-medium text-zinc-200">
            <LockIcon className="h-4 w-4 text-emerald-400" />
            Your research stays on your computer
          </p>
          <ul className="flex flex-col gap-1.5 text-sm leading-relaxed text-zinc-400">
            <li>No filing text, summaries, or notes are uploaded.</li>
            <li>ML models ship inside the extension — no Hugging Face requests at runtime.</li>
            <li>
              Disclora only connects to <span className="text-zinc-300">*.sec.gov</span> when
              fetching prior-year filings for redline comparison.
            </li>
          </ul>
        </Section>

        <Section title="Models bundled with the extension">
          <ul className="flex flex-col gap-2">
            {BUNDLED_MODELS.map((m) => (
              <li key={m.name} className="flex items-center gap-2 text-sm">
                <span className="flex-1">
                  <span className="font-medium text-zinc-200">{m.name}</span>
                  <span className="block text-xs text-zinc-500">{m.role}</span>
                </span>
                <span className="shrink-0 rounded bg-zinc-800 px-1.5 py-0.5 text-xs text-zinc-400">
                  {m.size}
                </span>
              </li>
            ))}
          </ul>
        </Section>

        {caps && (
          <Section title="Generation mode">
            <div className="flex items-center gap-2">
              <TierBadge tier={caps.generationTier} />
              <span className="ml-auto text-xs text-zinc-500">Detected on this device</span>
            </div>
            {caps.generationTier === 'builtin' ? (
              <div className="mt-3 flex items-center justify-between rounded-lg bg-zinc-800/50 px-3 py-2 text-sm">
                <span className="text-zinc-300">Gemini Nano</span>
                <span className={stateColor(caps.promptApi)}>{stateLabel(caps.promptApi)}</span>
              </div>
            ) : (
              <Banner tone="positive" icon="✓" className="mt-3">
                Built-in AI is not available here, so Disclora runs in extractive mode. Sentiment,
                flags, and year-over-year changes are fully available on-device.
              </Banner>
            )}
          </Section>
        )}

        <Section title="Advanced">
          <p className="mb-3 text-sm leading-relaxed text-zinc-400">
            Show the first-run welcome screen again the next time you open the side panel.
          </p>
          <button
            type="button"
            onClick={replayOnboarding}
            className="rounded-md bg-zinc-800 px-3 py-2 text-sm font-medium text-zinc-200 ring-1 ring-zinc-700 transition hover:bg-zinc-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-500"
          >
            Replay onboarding
          </button>
        </Section>
      </main>
    </div>
  );
}
