// ============================================================
// Disclora — shared side-panel controls
// ============================================================

import { useState } from 'react';
import { useOverlayPrefs, FLAG_CATEGORIES } from './overlayPrefs';
import { CATEGORY_META } from '@/shared/flagMeta';

export function Switch({
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
      aria-label={`${label} ${checked ? 'on' : 'off'}`}
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

/**
 * Compact on-page highlight controls for the side panel: the master language-flag
 * switch in the header, with per-category + boilerplate toggles behind a chevron.
 * Mirrors the Settings page's Page-highlights section so the same controls are
 * reachable without leaving the panel. Default collapsed to save vertical space.
 */
export function OverlayControlsPanel() {
  const { prefs, loaded, setFlags, setType, setBoilerplate } = useOverlayPrefs();
  const [open, setOpen] = useState(false);
  const flagsOn = loaded ? prefs.flags : true;

  return (
    <section
      aria-label="Page highlights"
      className="rounded-lg bg-zinc-900/60 ring-1 ring-inset ring-zinc-800 text-[12px] font-['Roboto',-apple-system,BlinkMacSystemFont,sans-serif]"
    >
      <div className="flex items-center gap-2 px-3 py-2.5">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="flex flex-1 items-center gap-1.5 text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-500"
        >
          <span className="font-semibold text-zinc-200">Page highlights</span>
          <svg
            className={`h-3 w-3 text-zinc-600 transition-transform ${open ? 'rotate-180' : ''}`}
            viewBox="0 0 20 20"
            fill="currentColor"
            aria-hidden="true"
          >
            <path fillRule="evenodd" d="M5.22 8.22a.75.75 0 011.06 0L10 11.94l3.72-3.72a.75.75 0 111.06 1.06l-4.25 4.25a.75.75 0 01-1.06 0L5.22 9.28a.75.75 0 010-1.06z" clipRule="evenodd" />
          </svg>
        </button>
        <Switch checked={flagsOn} onChange={setFlags} label="Language flags" on="bg-sky-600" />
      </div>

      {open && (
        <div className={`px-3 pb-2.5 ${flagsOn ? '' : 'opacity-50'}`}>
          {FLAG_CATEGORIES.map((cat) => (
            <label key={cat} className="flex items-center justify-between gap-2 py-1.5 text-zinc-300">
              <span className={`underline decoration-zinc-500 underline-offset-[3px] ${CATEGORY_META[cat].underline}`}>
                {CATEGORY_META[cat].label}
              </span>
              <Switch
                checked={loaded ? prefs.types[cat] : true}
                onChange={(v) => setType(cat, v)}
                label={CATEGORY_META[cat].label}
                on="bg-sky-600"
              />
            </label>
          ))}
          <label className="mt-1 flex items-center justify-between gap-2 border-t border-zinc-800/70 pt-2 text-zinc-300">
            <span>Include boilerplate</span>
            <Switch
              checked={loaded ? prefs.boilerplate : false}
              onChange={setBoilerplate}
              label="Include boilerplate"
              on="bg-sky-600"
            />
          </label>
        </div>
      )}
    </section>
  );
}
