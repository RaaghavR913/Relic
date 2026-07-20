/**
 * Relic capability detection — the linchpin of the lean (built-in-AI-only) build.
 *
 * getCapabilities() classifies the device into a generationTier ('builtin' | 'extractive')
 * that drives the entire tier-aware UX: summaries (Session 3) and change summaries
 * (Session 6). It also reports WebGPU (a perf signal for the encoders,
 * NOT a gate — WASM is always available as fallback).
 *
 * Source of truth for availability is each API's own availability() call, which already
 * accounts for OS / disk / hardware gating — so we never sniff the OS.
 */

export type AvailabilityState =
  | 'available'      // model present and ready now
  | 'downloadable'   // supported, but Chrome must download on first create()
  | 'downloading'    // download currently in progress
  | 'unavailable'    // device cannot run it (OS / disk / hardware)
  | 'unsupported';   // the API global is not present in this browser/context at all

export type GenerationTier = 'builtin' | 'extractive';

export interface Capabilities {
  webgpu: { supported: boolean; adapter: boolean };
  summarizer: AvailabilityState; // Chrome Summarizer API -> plain-English summaries
  promptApi: AvailabilityState;  // Chrome Prompt API (Gemini Nano) -> analyst notes, change narratives
  generationTier: GenerationTier;
  /** any generative API is obtainable but needs a one-time download before first use */
  needsModelDownload: boolean;
  detectedAt: number;
}

// A generative API counts toward the 'builtin' tier if it is usable now or can be downloaded.
const OBTAINABLE: ReadonlyArray<AvailabilityState> = ['available', 'downloadable', 'downloading'];

/** SEC filings are English. Chrome requires this on availability() and create() for output-safety attestation. */
export const SUMMARIZER_LANGUAGE = {
  outputLanguage: 'en',
  expectedInputLanguages: ['en'],
} as const;

/** English text I/O for the Prompt API (Gemini Nano). SEC filings are English-only. */
const ENGLISH_TEXT = { type: 'text' as const, languages: ['en'] as const };

/**
 * Language attestation for LanguageModel.availability() and LanguageModel.create().
 * Chrome 147+ requires expectedOutputs (not Summarizer-style outputLanguage) or it
 * logs: "No output language was specified in a LanguageModel API request."
 */
export const LANGUAGE_MODEL_LANGUAGE = {
  expectedInputs: [ENGLISH_TEXT],
  expectedOutputs: [ENGLISH_TEXT],
} as const;

export type LanguageModelLanguageOptions = typeof LANGUAGE_MODEL_LANGUAGE;

/** True when opts include English text in expectedOutputs (Prompt API attestation). */
export function hasLanguageModelOutputAttestation(opts: unknown): boolean {
  if (opts == null || typeof opts !== 'object') return false;
  const outs = (opts as { expectedOutputs?: unknown }).expectedOutputs;
  if (!Array.isArray(outs) || outs.length === 0) return false;
  return outs.some((item) => {
    if (item == null || typeof item !== 'object') return false;
    const { type, languages } = item as { type?: string; languages?: unknown };
    return (
      type === 'text' &&
      Array.isArray(languages) &&
      languages.some((lang) => lang === 'en')
    );
  });
}

function getGlobal<T = unknown>(name: string): T | undefined {
  // Works across content script (window), side panel (window), and service worker (self).
  return (globalThis as Record<string, unknown>)[name] as T | undefined;
}

import { probeWebGpuAdapter } from '@/offscreen/webgpuPreflight';

async function probeWebGPU(): Promise<Capabilities['webgpu']> {
  // Reuse the hardened offscreen probe (timeout + requestDevice). UI still
  // exposes a single Available/Unavailable bit — true only when a device works.
  const probe = await probeWebGpuAdapter();
  return { supported: probe.supported, adapter: probe.device };
}

async function probeBuiltin(name: 'Summarizer' | 'LanguageModel'): Promise<AvailabilityState> {
  const api = getGlobal<{ availability?: (opts?: unknown) => Promise<string> }>(name);
  if (!api || typeof api.availability !== 'function') return 'unsupported';
  const langOpts = name === 'Summarizer' ? SUMMARIZER_LANGUAGE : LANGUAGE_MODEL_LANGUAGE;
  try {
    const state = await api.availability(langOpts);
    switch (state) {
      // Current standardized values (Chrome 138+, MDN):
      case 'available':
      case 'downloadable':
      case 'downloading':
      case 'unavailable':
        return state;
      // Legacy values from older Chrome, normalized defensively:
      case 'readily':
        return 'available';
      case 'after-download':
        return 'downloadable';
      case 'no':
        return 'unavailable';
      default:
        return 'unavailable';
    }
  } catch {
    return 'unavailable';
  }
}

/**
 * Live (un-memoized) Prompt API availability. getCapabilities() deliberately
 * counts 'downloadable'/'downloading' toward the 'builtin' tier; callers that
 * must not trigger the one-time ~2 GB Gemini Nano download (e.g. SummaryPanel's
 * auto-run on page load) use this to distinguish "model on disk now" from
 * "would start a download". availability() is cheap — no memoization needed.
 */
export function probePromptApiAvailability(): Promise<AvailabilityState> {
  return probeBuiltin('LanguageModel');
}

let _cache: Capabilities | null = null;

/**
 * Detect device capabilities. Memoized within the session; pass force=true to re-probe
 * (e.g. after Gemini Nano finishes downloading, 'downloadable' -> 'available').
 */
export async function getCapabilities(force = false): Promise<Capabilities> {
  if (_cache && !force) return _cache;

  const [webgpu, summarizer, promptApi] = await Promise.all([
    probeWebGPU(),
    probeBuiltin('Summarizer'),
    probeBuiltin('LanguageModel'),
  ]);

  const generationTier: GenerationTier =
    OBTAINABLE.includes(summarizer) || OBTAINABLE.includes(promptApi) ? 'builtin' : 'extractive';

  const needsModelDownload =
    summarizer === 'downloadable' || summarizer === 'downloading' ||
    promptApi === 'downloadable' || promptApi === 'downloading';

  _cache = { webgpu, summarizer, promptApi, generationTier, needsModelDownload, detectedAt: Date.now() };
  return _cache;
}

export function clearCapabilitiesCache(): void {
  _cache = null;
}

// --- Generative session factories (used in Sessions 3 & 7; included here so first-run UX
//     can wire up download progress immediately). ---

export interface CreateOptions {
  /** download progress, 0..1 */
  onDownloadProgress?: (loaded: number) => void;
  signal?: AbortSignal;
}

/**
 * Create a Summarizer instance, surfacing Chrome's Gemini Nano download progress.
 * NOTE: when state is 'downloadable', create() may require transient user activation
 * (call it from a click handler), and you should destroy() the instance when done.
 */
export async function createSummarizer(opts: CreateOptions = {}): Promise<unknown> {
  const Summarizer = getGlobal<{ create(o: unknown): Promise<unknown> }>('Summarizer');
  if (!Summarizer) throw new Error('Summarizer API unsupported on this device');
  return Summarizer.create({
    type: 'key-points',
    format: 'markdown',
    length: 'short',
    ...SUMMARIZER_LANGUAGE,
    monitor(m: { addEventListener(t: string, cb: (e: { loaded: number }) => void): void }) {
      m.addEventListener('downloadprogress', (e) => opts.onDownloadProgress?.(e.loaded));
    },
    signal: opts.signal,
  });
}

/** Create a Prompt API (Gemini Nano) session for analyst notes / change narratives. */
export async function createPromptSession(
  opts: CreateOptions & { systemPrompt?: string } = {},
): Promise<unknown> {
  const LanguageModel = getGlobal<{ create(o: unknown): Promise<unknown> }>('LanguageModel');
  if (!LanguageModel) throw new Error('Prompt API unsupported on this device');
  return LanguageModel.create({
    ...LANGUAGE_MODEL_LANGUAGE,
    initialPrompts: opts.systemPrompt
      ? [{ role: 'system', content: opts.systemPrompt }]
      : undefined,
    monitor(m: { addEventListener(t: string, cb: (e: { loaded: number }) => void): void }) {
      m.addEventListener('downloadprogress', (e) => opts.onDownloadProgress?.(e.loaded));
    },
    signal: opts.signal,
  });
}
