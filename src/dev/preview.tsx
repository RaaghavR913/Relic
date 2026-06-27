import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { LazyMotion, domMax } from 'framer-motion';
import './preview.css';
import { installChromeMock } from './chrome-mock';
import { scenarioFromSearch, type PreviewScenario } from './mock-data';

const SCENARIOS: Array<{ id: PreviewScenario; label: string }> = [
  { id: 'filing', label: 'Filing loaded' },
  { id: 'empty', label: 'No filing' },
  { id: 'onboarding', label: 'First run' },
];

function DevToolbar({ active }: { active: PreviewScenario }) {
  return (
    <div
      className="sticky top-0 z-50 border-b border-amber-900/60 bg-amber-950/90 px-3 py-2 backdrop-blur-sm"
      role="toolbar"
      aria-label="UI preview controls"
    >
      <p className="mb-1.5 text-[10px] font-medium uppercase tracking-widest text-amber-400/80">
        Dev preview — edits hot-reload
      </p>
      <div className="flex flex-wrap gap-1">
        {SCENARIOS.map((s) => {
          const selected = s.id === active;
          return (
            <a
              key={s.id}
              href={`?scenario=${s.id}`}
              className={`rounded px-2 py-1 text-[11px] font-medium transition ${
                selected
                  ? 'bg-amber-500/20 text-amber-200 ring-1 ring-inset ring-amber-500/40'
                  : 'text-amber-100/70 hover:bg-amber-900/40 hover:text-amber-100'
              }`}
            >
              {s.label}
            </a>
          );
        })}
      </div>
    </div>
  );
}

const scenario = scenarioFromSearch(window.location.search);
installChromeMock(scenario);

const root = document.getElementById('root');
if (!root) throw new Error('Relic preview: #root missing');

// ui.tsx reads chrome.runtime at module scope — load App only after the mock is installed.
const { default: App } = await import('@/sidepanel/App');

createRoot(root).render(
  <LazyMotion features={domMax} strict>
    <StrictMode>
      <DevToolbar active={scenario} />
      <App />
    </StrictMode>
  </LazyMotion>,
);
