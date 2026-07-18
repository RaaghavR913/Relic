// ============================================================
// Relic — last-known ORT inference backends (side panel)
// ------------------------------------------------------------
// Offscreen broadcasts INFERENCE_BACKEND on every worker READY.
// Module state survives tab switches within the panel session so
// the capabilities card can show the real backend, not just the
// adapter probe.
// ============================================================

import { useEffect, useState } from 'react';
import type { InferenceBackendMsg } from '@/messages/types';

export type InferenceDevice = 'webgpu' | 'wasm';

type BackendState = {
  encoder: InferenceDevice | null;
  sentiment: InferenceDevice | null;
};

const state: BackendState = { encoder: null, sentiment: null };
const listeners = new Set<() => void>();

function notify(): void {
  for (const l of listeners) l();
}

export function getInferenceBackends(): BackendState {
  return { ...state };
}

/** Human label for the capabilities card. */
export function formatInferenceBackendLabel(s: BackendState): string {
  const { encoder, sentiment } = s;
  if (!encoder && !sentiment) return 'Not started yet';
  if (encoder && sentiment && encoder !== sentiment) {
    return `Mixed (encoder ${encoder === 'webgpu' ? 'WebGPU' : 'WASM'}, sentiment ${sentiment === 'webgpu' ? 'WebGPU' : 'WASM'})`;
  }
  const d = encoder ?? sentiment!;
  return d === 'webgpu' ? 'WebGPU' : 'WASM';
}

function applyMsg(m: InferenceBackendMsg): void {
  if (m.role === 'encoder') state.encoder = m.device;
  else state.sentiment = m.device;
  notify();
}

/** Subscribe to chrome runtime INFERENCE_BACKEND messages (idempotent). */
let listening = false;
export function ensureInferenceBackendListener(): void {
  if (listening) return;
  listening = true;
  chrome.runtime.onMessage.addListener((raw: unknown) => {
    const msg = raw as { target?: string; type?: string };
    if (msg.target !== 'sidepanel' || msg.type !== 'INFERENCE_BACKEND') return;
    applyMsg(raw as InferenceBackendMsg);
  });
}

export function useInferenceBackends(): BackendState {
  const [snap, setSnap] = useState(getInferenceBackends);
  useEffect(() => {
    ensureInferenceBackendListener();
    const onChange = () => setSnap(getInferenceBackends());
    listeners.add(onChange);
    return () => {
      listeners.delete(onChange);
    };
  }, []);
  return snap;
}
