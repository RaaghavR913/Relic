// ============================================================
// Disclora — header Export control
// ------------------------------------------------------------
// One click gathers every cached artifact for the current filing (investor
// analysis, section summaries, sentiment, YoY redline) and downloads a single
// self-contained HTML report — openable offline and "Save as PDF"-ready.
// Everything runs on-device; nothing is sent to the network.
// ============================================================

import { useCallback, useState } from 'react';
import type { DocumentModel } from '@/types';
import { collectFilingExportData } from '@/export/collect';
import { buildFilingReportHtml, hasExportableData, reportFilename } from '@/export/report';

type State = 'idle' | 'busy' | 'empty' | 'error';

/** Trigger a client-side download of an HTML string (extension page; no network). */
function downloadHtml(filename: string, html: string): void {
  const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Give the download a moment to start before reclaiming the object URL.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

function DownloadIcon({ className = 'h-3.5 w-3.5' }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={className} aria-hidden="true">
      <path d="M12 3v12" strokeLinecap="round" strokeLinejoin="round" />
      <path d="m7 11 5 5 5-5" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M5 21h14" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function ExportButton({ doc }: { doc: DocumentModel }) {
  const [state, setState] = useState<State>('idle');

  const onClick = useCallback(async () => {
    if (state === 'busy') return;
    setState('busy');
    try {
      const data = await collectFilingExportData(doc);
      if (!hasExportableData(data)) {
        setState('empty');
        setTimeout(() => setState('idle'), 3500);
        return;
      }
      downloadHtml(reportFilename(data), buildFilingReportHtml(data));
      setState('idle');
    } catch (err) {
      console.warn('Disclora export failed', err);
      setState('error');
      setTimeout(() => setState('idle'), 3500);
    }
  }, [doc, state]);

  const label =
    state === 'busy' ? 'Preparing…'
    : state === 'empty' ? 'Nothing to export yet'
    : state === 'error' ? 'Export failed'
    : 'Export';

  return (
    <button
      type="button"
      onClick={() => void onClick()}
      disabled={state === 'busy'}
      title="Download all analysis for this filing (HTML · print to PDF)"
      aria-label="Export all analysis for this filing"
      className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1 text-[11px] font-medium text-zinc-300 transition hover:border-sky-500/50 hover:bg-zinc-800 hover:text-sky-300 disabled:cursor-default disabled:opacity-60 focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-500 font-['Roboto',-apple-system,BlinkMacSystemFont,sans-serif]"
    >
      <DownloadIcon />
      {label}
    </button>
  );
}
