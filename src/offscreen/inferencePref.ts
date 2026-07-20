// ============================================================
// Relic — prefer-WASM inference preference (session-scoped)
// ------------------------------------------------------------
// When WebGPU preflight fails or a worker falls back to WASM mid-
// session, remember that for the browser session so a recycled
// offscreen document does not re-attempt a known-bad GPU path.
//
// Ownership is split because the offscreen document has NO
// chrome.storage — its API surface is essentially chrome.runtime
// only, so a storage call there silently fails. Therefore:
//
//   • the service worker owns the value (chrome.storage.session),
//   • the SW hands it to the offscreen document as a URL param at
//     createDocument() time,
//   • the offscreen document reports the device it settled on back
//     over chrome.runtime (INFERENCE_DEVICE), and the SW persists it.
//
// chrome.storage.session (not local) so a browser restart can
// re-try WebGPU after a transient driver glitch.
// ============================================================

const KEY = 'relic:preferWasm';

/** Query parameter carrying the preference into the offscreen document. */
export const PREFER_WASM_PARAM = 'preferWasm';

// ── service-worker side (has chrome.storage.session) ─────────────────────────

/** True when this browser session should skip WebGPU and load WASM. SW-only. */
export async function getPreferWasm(): Promise<boolean> {
  try {
    const data = await chrome.storage.session.get(KEY);
    return data[KEY] === true;
  } catch {
    return false;
  }
}

/** Persist prefer-WASM for the rest of this browser session. SW-only, fail-soft. */
export async function setPreferWasm(value: boolean): Promise<void> {
  try {
    if (value) {
      await chrome.storage.session.set({ [KEY]: true });
    } else {
      await chrome.storage.session.remove(KEY);
    }
  } catch {
    // storage unavailable (tests / restricted context) — in-memory path still works
  }
}

/**
 * Build the offscreen document URL, carrying the preference so a recycled
 * document skips the WebGPU probe entirely. Omits the param when false so the
 * URL stays clean on the common path.
 */
export function offscreenUrlWithPref(baseUrl: string, preferWasm: boolean): string {
  if (!preferWasm) return baseUrl;
  const sep = baseUrl.includes('?') ? '&' : '?';
  return `${baseUrl}${sep}${PREFER_WASM_PARAM}=1`;
}

// ── offscreen side (no chrome.storage — reads what the SW handed it) ─────────

/**
 * Read the preference handed in at creation time. Accepts a full URL or a bare
 * search string ('?preferWasm=1'); anything unparseable means "no preference".
 */
export function preferWasmFromLocation(search: string): boolean {
  if (!search) return false;
  try {
    const qs = search.includes('?') ? search.slice(search.indexOf('?')) : `?${search}`;
    return new URLSearchParams(qs).get(PREFER_WASM_PARAM) === '1';
  } catch {
    return false;
  }
}

export const INFERENCE_PREF_KEY = KEY;
