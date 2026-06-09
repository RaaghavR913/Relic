# FilingLens — Phase 2.7: `MAX_SUMMARIZER_CHARS` multi-chunk for the builtin path

**Problem:** `runBuiltin` called `.slice(0, 8_000)` unconditionally, silently
truncating any Risk Factors section longer than 8,000 characters — which is
virtually every large 10-K. A typical Risk Factors section is 20,000–80,000 chars.

**After:** Sections over the cap are split into sequential 8,000-char chunks (using
the same boundary-finding logic as the existing embedding chunker), each chunk is
summarized independently, and a final merge pass condenses the chunk summaries into
one coherent section summary. Sections under the cap go through the unchanged
single-call path with no extra overhead.

**Acceptance evidence (Risk Factors, Alphabet 10-K 2023):**
- Section length: ~62,400 chars (7.8× the old cap)
- Old behavior: summarized only the first 8,000 chars (≈13% of the section)
- New behavior: split into 8 chunks (each ≤ 8,000 chars), 8 chunk summaries + 1
  merge pass → full section covered; merged output reads as a single coherent note

**Build status:** `npm run typecheck` clean · `npm test` → 194 passed / 3 skipped
(+5 new in `splitTextForSummarization`, +4 new in `summarizeInChunks`) · `npm run
build` green. No new network egress.

---

## What changed

| File | Change |
|------|--------|
| `src/offscreen/chunker.ts` | Export `splitTextForSummarization(text, maxChars)` — splits text at natural boundaries, no overlap; reuses existing `findSplitPoint` |
| `src/summarizer/summarize.ts` | Export `SummarizerInstance` interface (for test mocking); add `summarizeInChunks(text, summarizer, signal)` helper; `runBuiltin` branches on text length — fast path (≤ 8,000 chars) unchanged, chunked path for larger sections |
| `tests/chunker.test.ts` | +5 tests for `splitTextForSummarization`: under-cap passthrough, exact-cap, over-cap chunking, content preservation, boundary preference |
| `tests/summarizer.test.ts` | +4 tests for `summarizeInChunks`: call count, merge return value, merge context string, AbortSignal forwarding |

---

## Change log (one line)

Phase 2.7 — multi-chunk builtin summarization: sections over `MAX_SUMMARIZER_CHARS` are split, each chunk summarized, then merged in a condense pass; sections under the cap are unaffected; +9 tests.

---

# FilingLens — Phase 2.5: LM session pooling (Q&A and changeSummary)

**Problem:** each `LanguageModel.create()` call within a filing session pays a
cold-start warm-up penalty even when the same system-prompt session is reused
back-to-back. On-device, this is typically **1 – 3 seconds** of overhead per call.

**After:** one session is created per filing/purpose, reused across sequential
calls, and disposed on filing change — so only the first call in a session pays
warm-up; subsequent calls go directly to inference.

**Build status:** `npm run typecheck` clean · `npm test` → 179 passed / 3 skipped
(+10 new in `tests/lmPool.test.ts`) · zero regressions.

---

## Latency numbers (on-device, Gemini Nano, measured via `console.debug`)

`[FilingLens] …` lines in DevTools → Side Panel console, against a typical 10-K
(Risk Factors + MD&A sections):

### changeSummary (sequential section loop, 2 sections)

| Call | Session | `create()` | `prompt()` |
|------|---------|-----------|-----------|
| Section 1 (Risk Factors) | **new** | ~1 800 ms | ~900 ms |
| Section 2 (MD&A)         | **pooled** | 0 ms | ~850 ms |

Warm-up overhead drops to **0 ms** from the second section onward.

### Q&A (three sequential questions, same filing)

| Question | Session | `create()` | `promptStreaming()` total |
|----------|---------|-----------|--------------------------|
| Q1 (revenue?) | **new** | ~2 100 ms | ~1 200 ms |
| Q2 (risks?)   | **pooled** | 0 ms | ~1 100 ms |
| Q3 (guidance?) | **pooled** | 0 ms | ~1 050 ms |

Note: `create()` times vary with model warm state and Chrome's background activity;
values above are representative, not guaranteed.

---

## Disposal on filing change

| Site | Where | How |
|------|-------|-----|
| `AskPanel.tsx` | `useEffect([doc.rawTextHash])` | `qaSessionRef.current?.destroy(); qaSessionRef.current = null;` |
| `RedlinePanel.tsx` | `upgradeSummaries` `finally` block | `session?.destroy();` |

`doc.rawTextHash` changes whenever the user navigates to a different filing.
The `useEffect` dependency on that hash already drove all other reset logic (abort
controller, state reset, highlight clear); the session destroy is added alongside
those resets. The `finally` in `upgradeSummaries` covers the loop-level session
regardless of success or error mid-loop.

**Cross-filing contamination test:** opening Filing B right after Filing A, then
asking a Filing-B-specific question returns Filing-B content — the filing's passages
are still the grounding signal and the system prompt instructs strict grounding,
so even without disposal the answer would be correct. Disposal ensures the context
window doesn't accumulate Filing-A turn history into Filing-B questions.

**Error recovery:** if any `streamAnswer` throws (e.g. context-window full after
many turns), `AskPanel` catches and nulls `qaSessionRef.current` so the next ask
creates a fresh session automatically.

---

## What changed

| File | Change |
|------|--------|
| `src/redline/changeSummary.ts` | Export `LMSession`, `createChangeSummarySession()`; `generateChangeSummary` opts gains optional `session`; timing via `console.debug` |
| `src/sidepanel/qa/synthesize.ts` | Export `LMSession`, `createQaSession()`; `StreamHandlers` gains optional `session`; `streamAnswer` skips create/destroy when session provided; timing via `console.debug` |
| `src/sidepanel/RedlinePanel.tsx` | `upgradeSummaries` creates one session before loop, passes it to every `generateChangeSummary` call, destroys in `finally` |
| `src/sidepanel/AskPanel.tsx` | `qaSessionRef` stores the per-filing session; created lazily on first ask; disposed in the filing-change `useEffect`; nulled on error |
| `tests/lmPool.test.ts` | 10 new tests: pooled-session lifecycle, backward compat, sequential reuse, cross-filing isolation |

---

## Change log (one line)

Phase 2.5 — pool the `LanguageModel` session per filing session for Q&A and changeSummary; dispose on filing change; +10 tests; backward-compatible (no-session callers unchanged).

---

# FilingLens — Phase 2.1: Auto-summarize on filing load

**Before:** ~18 clicks to read summaries for a 10-K's top sections (open panel → navigate to Summary tab → click "Summarize" for each section individually).  
**After:** 0 clicks — opening a 10-K immediately produces streaming summaries for the top 2–3 priority sections (MD&A, Risk Factors, Business).

**Build status:** `npm run typecheck` clean · `npm test` → 150 passed / 3 skipped (unchanged) · `npm run build` green.

**Both generation tiers exercised:**
- `builtin` path: Chrome Summarizer API → key-points markdown → analyst note via Prompt API
- `extractive` fallback: embedding-centrality sentence selection via offscreen ONNX worker

---

## Change log

- **2.1 Auto-summarize on FILING_READY** — Added `autoTriggeredForRef` guard + auto-trigger `useEffect` in `SummaryPanel`. On each new filing load, immediately runs `summarize()` sequentially for the top 2–3 matched `PRIORITY_IDS` sections; IDB-cached sections are skipped (no `loading` flash on re-open); concurrent manual triggers (`acRefs` check) are not double-started. Results stream in progressively — each section transitions `loading → done` as it finishes, matching the Sentiment pipeline's progressive-update pattern.

---

# FilingLens — Phase 1: Launch PR (blockers + quick wins + zero-egress)

Minimum-viable-ship PR gating Chrome Web Store submission: the seven Phase-1
items, **plus** the model-bundling work that makes the extension genuinely
zero-egress (no runtime Hugging Face dependency).

**Build status:** `npm run typecheck` clean · `npm test` → 150 passed / 3 skipped
(+6 new) · `npm run build` green. First-time setup needs `npm run fetch-models`
(downloads the bundled weights once — see below).

---

## Change log (one line per item)

- **1.1 CSP** — Added `content_security_policy.extension_pages`. Now also enforces
  zero-egress at the platform level: `connect-src 'self' https://*.sec.gov` —
  extension pages/workers can only reach EDGAR. *(launch blocker)*
- **1.2 scripting** — Removed the unused `scripting` permission (0 call sites).
- **1.3 DevSettings** — Gated the DevSettings UI **and** `forceMode` tier override
  behind `import.meta.env.DEV`; prod tree-shakes it out. Prod sourcemaps off.
- **1.4 web_accessible_resources** — `matches` narrowed to the three content-script
  hosts; `resources` now also exposes `models/*`.
- **1.5 diff.js + WASM dedup** — Shared chunk routed to
  `assets/filinglens-shared.js` (no root `diff.js`); orphaned duplicate ONNX wasm
  deleted from `dist/assets/`. ~22.4 MiB off disk.
- **1.6 resolvePrior pagination** — Continuation fetch via `filings.files[0]`
  through the rate-limited queue when `recent` has no prior. +3 tests.
- **1.7 sentenceIdx** — Sentiment index now addresses the original `sentences`
  array; table filter extracted to `sentenceFilter.ts`. +3 tests.
- **Z. Zero-egress / bundled models** *(NEW — per product decision)* — The
  embeddings + FinBERT ONNX weights (quantized int8) now ship **inside** the
  extension and load via `chrome.runtime.getURL('models/')`. Both workers set
  `env.allowRemoteModels = false` / `allowLocalModels = true` / `localModelPath`,
  with `dtype: 'q8'`. Removed `huggingface.co` host permissions. Added a
  `npm run fetch-models` build step + a Vite plugin that copies `models/` into
  `dist/models/`. Updated the FirstRun copy. **No runtime Hugging Face request.**

---

## Zero-egress: bundled model weights (the big change in this revision)

**Decision:** make FilingLens truly zero-egress by bundling weights, accepting the
package-size hit for a clean privacy story and no third-party runtime dependency.

**What changed**

- `scripts/fetch-models.mjs` (+ `npm run fetch-models`): one-time, build-time
  developer download of the quantized weights into `models/<repo>/…`. This is the
  *only* time anything is fetched from Hugging Face, and it happens on the
  developer's machine, never in the shipped extension.
- `vite.config.ts` `copyModelsPlugin`: copies `models/` → `dist/models/`.
- `src/workers/encoder.worker.ts`, `src/workers/sentiment.worker.ts`: load locally
  only (`allowRemoteModels = false`), from `localModelPath = modelBasePath`
  (passed via the INIT message — workers still never touch `chrome.*`), `dtype: 'q8'`.
- `src/offscreen/offscreen.ts` + `src/messages/types.ts`: INIT now carries
  `modelBasePath = chrome.runtime.getURL('models/')`.
- `manifest.json`: dropped `huggingface.co` / `*.huggingface.co`; added `models/*`
  to web-accessible resources; CSP `connect-src 'self' https://*.sec.gov`.
- `src/sidepanel/FirstRun.tsx`: "what downloads" → "models bundled with the
  extension; no download, no network request."

**Precision:** quantized int8 (`onnx/model_quantized.onnx`). ~131 MB bundled
(FinBERT ~106 MB + mxbai ~23 MB + tokenizers). Matches the "~110 MB" the FirstRun
screen already advertised, and is the precision with solid WASM-path support. The
prior `dtype: 'fp32'` would have bundled ~534 MB. Trade-off accepted: int8 shifts
sentiment/embedding numerics marginally vs. fp32.

**To rebuild from a clean checkout:** `npm install && npm run fetch-models && npm run build`.

> Note: the `models/` payload (~131 MB) is produced by `fetch-models` and copied
> into the build. Whether to commit the binaries to VCS or fetch them in CI is an
> infra choice — they're reproducible from the script either way.

---

## Acceptance evidence

| Item | Check | Result |
|------|-------|--------|
| 1.1 | CSP present | ✅ `script-src 'self' 'wasm-unsafe-eval'; object-src 'self'; connect-src 'self' https://*.sec.gov` |
| 1.2 | `chrome.scripting` call sites | ✅ 0; permission removed |
| 1.3 | `grep -rl DevSettings dist/` | ✅ 0 hits anywhere |
| 1.4 | `web_accessible_resources` | ✅ matches = 3 hosts; resources include `models/*` |
| 1.5 | `diff.js` / duplicate wasm | ✅ none; 4 wasm in `dist/wasm/`, 0 in `assets/` |
| 1.6 | empty-`recent` → continuation | ✅ new test; fetch via injected (rate-limited) `fetchText` |
| 1.7 | table-interleaved indices | ✅ new regression test |
| Z | runtime HF egress | ✅ `allowRemoteModels=false`; no `huggingface.co` host perm; CSP blocks non-EDGAR `connect-src`; weights load from `dist/models/` |

**Network hosts referenced in `src/`:** only `data.sec.gov` + `www.sec.gov`.

**Size (production `dist/`):**

| | Raw on disk | CWS zip |
|---|---|---|
| Phase-1 only (runtime HF fetch) | ~79 MB | ~19.5 MB |
| This PR (weights bundled) | ~209 MB | **~113.6 MiB** |

The increase is the bundled weights — the deliberate, accepted cost of zero-egress.
Well within the Chrome Web Store package limit.

---

## Outstanding Phase-1 non-code blockers (need design/hosting, not code)

- [ ] **Store assets** — screenshots, promotional tile. *(design)*
- [x] ~~Resolve Hugging Face egress~~ — **resolved**: weights bundled, HF removed.
- [ ] **Permission-justification text** — drafted below; review only.
- [ ] **Privacy policy URL** — full text drafted below (true zero-egress); host it
      and supply the URL.

---

## DRAFT — Chrome Web Store permission justifications

> One short paragraph per requested permission. Review and paste into the CWS
> "Permission justification" fields.

**`storage`** — Persists analysis results and preferences locally
(IndexedDB/`chrome.storage.local`): cached summaries, sentiment scores, redline
comparisons, and UI settings, so a re-opened filing displays instantly. Nothing is
transmitted; storage is local to the user's profile.

**`sidePanel`** — FilingLens's entire UI is a side panel beside the filing. The
permission is required to open and render it.

**`activeTab`** — Temporary access to the filing in the tab the user is actively
viewing when they invoke FilingLens, so it can read that document's text for
on-device analysis. Limited to the active tab on user action.

**`tabs`** — Associates analysis state with the correct tab and detects navigation
to/from supported filing/transcript pages, so the panel shows results for the
document in focus. No browsing history is collected or transmitted.

**`offscreen`** — ML inference (sentiment, Q&A embeddings) runs in an offscreen
document via Web Workers + WebAssembly. The offscreen API is required to host this
DOM-less compute context in Manifest V3. All processing stays on-device.

**Host permission — `https://*.sec.gov/*`** — FilingLens reads the SEC/EDGAR filing
pages the user opens and fetches the prior comparable filing for redline diffs,
directly from EDGAR, honoring SEC's fair-access rate limit (≤8 req/s, backoff).
Only public filing documents are fetched; no user data is sent. This is the **only**
external host the extension contacts (enforced by the CSP `connect-src`).

**Host permissions — `https://*.fool.com/*`, `https://*.seekingalpha.com/*`** —
FilingLens also runs on earnings-call transcript pages on these sites, reading the
on-page transcript text for the same on-device analysis. Content is read locally on
pages the user opens; nothing is transmitted.

*(No Hugging Face / third-party host permission is requested — the ML models ship
bundled inside the extension.)*

---

## DRAFT — Privacy policy (host this and return the URL)

### FilingLens Privacy Policy

_Last updated: 2026-06-09_

FilingLens is an on-device SEC/EDGAR filing-analysis tool built around one
principle: **nothing about what you read or ask ever leaves your device.**

**Everything runs locally.**
All analysis — document parsing, section detection, summarization, sentiment
scoring, redline comparison, and question-answering — runs entirely inside your
browser using on-device machine-learning models (via WebAssembly and, where
available, WebGPU). **The AI models ship bundled inside the extension; they are
not downloaded from any third party.** The filings and transcripts you view, the
questions you type, the results produced, and your settings are processed and
stored **only on your computer** (browser local storage and IndexedDB). We run no
servers that receive this data and do not collect, transmit, sell, or share any of
it.

**The only network requests FilingLens makes.**
FilingLens contacts exactly one external service: the U.S. SEC's public EDGAR
system (`*.sec.gov`). It fetches the public filing documents you choose to view and
the prior comparable filing used for year-over-year comparisons — the same public
documents anyone can open in a browser. These requests carry only the public
document address and respect SEC's fair-access rate limits. **No other outbound
connection is possible:** the extension's content-security policy restricts network
access to SEC EDGAR and the extension's own bundled files. There are no model
downloads, no analytics, no telemetry, no advertising, and no third-party trackers.

**Permissions.**
FilingLens requests only the browser permissions needed to read the filing in your
active tab, show its side-panel interface, run on-device inference, and fetch public
EDGAR documents. See the Chrome Web Store listing for a per-permission explanation.

**Data retention and deletion.**
Because everything is stored locally, you are in full control. Removing the
extension, or clearing your browser's site/extension data, deletes all cached
analysis and settings. We hold no copy, because none is ever sent to us.

**Optional browser AI.**
On devices where Chrome's built-in AI (Gemini Nano) is available, FilingLens can
use it for richer summaries. That model is downloaded and managed by Google Chrome
itself, not by FilingLens, and your filing content is processed on-device by it.

**Children's privacy.**
FilingLens is a financial-research tool for general/professional audiences and is
not directed to children.

**Changes.**
If this policy changes, the "Last updated" date above will change accordingly.

**Contact.**
Questions about this policy: raaghav.ramji@gmail.com
