import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './preview.css';
import { installChromeMock } from './chrome-mock';
import { scenarioFromSearch } from './mock-data';

const scenario = scenarioFromSearch(window.location.search);
installChromeMock(scenario);

const root = document.getElementById('root');
if (!root) throw new Error('Relic settings preview: #root missing');

const { default: SettingsApp } = await import('@/settings/SettingsApp');

createRoot(root).render(
  <StrictMode>
    <div className="border-b border-amber-900/60 bg-amber-950/90 px-3 py-2">
      <a
        href={`/preview.html${window.location.search}`}
        className="inline-flex rounded px-2 py-1 text-[11px] font-medium text-amber-100 ring-1 ring-inset ring-amber-500/40 transition hover:bg-amber-900/40"
      >
        ← Side panel preview
      </a>
    </div>
    <SettingsApp />
  </StrictMode>,
);
