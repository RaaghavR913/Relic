# Relic — Full Release Readiness Audit

| | |
|---|---|
| **Extension** | Relic — Instant Investor Analysis |
| **Version** | 3.1.6 (`package.json`, `manifest.json`) |
| **Commit audited** | `d383a57` (branch `main`) |
| **Audit date** | 2026-07-26 |
| **Toolchain** | Node v24.14.1, npm 11.11.0, Vite 8.0.16 |
| **Scope** | Investigation only. No source files modified (see git-status check at end). |

> **Method note.** Findings cite `path:line` and quote code. Claims that could not be
> verified against code or command output are marked **UNVERIFIED**. Phase sections are
> written to disk as each phase completes (context-discipline requirement); the
> Executive Summary and Master Findings Table below are finalized after all phases.

---

## Executive Summary

**Verdict: release-ready. No BLOCKER or HIGH findings.** Relic 3.1.6 (commit `d383a57`) passes the load-bearing Chrome Web Store gates cleanly and is safe to submit once four non-code **ACTION** steps are done (host the privacy-policy URL, capture screenshots, paste the dashboard justifications/certs, zip `dist/` contents excluding `.DS_Store`).

What the audit confirmed as strong:
- **Remote-code policy (the #1 rejection risk): PASS.** Zero runtime fetch of executable content; both CDN loaders (jsPDF, transformers.js) are excised from `dist/` and re-asserted by `verify-dist.mjs`; models + WASM load from `chrome-extension://` local URLs; CSP `connect-src` hard-limits egress to `*.sec.gov`; `script-src` has no `'unsafe-eval'`.
- **Privacy & permissions:** on-device inference (`allowRemoteModels=false`), no telemetry/analytics/beacon, all 5 permissions used, sec.gov-only host permission at install (11 financial hosts optional/on-demand). Store/privacy claims are supported.
- **Build:** clean install + build is **byte-for-byte reproducible**, reaches no network at build time, ships **no secrets, source maps, dev code, or debug logging**; 105 MiB zip (2 GB limit).
- **Capability tiers:** fail-soft detection with bounded timeouts, an unconditional WASM floor, GPU disposed on fallback/teardown, unit-tested.
- **The named prior-year regression is already FIXED on HEAD** by commit `487b401` (Apple FY2023 → FY2022, verified end-to-end); the no-advice guardrail is two-layer (prompt + post-generation filter), and evidence grounding is enforced.

**Findings: 17 total — 0 BLOCKER, 0 HIGH, 1 MEDIUM, 1 LOW/MEDIUM, 15 LOW.** All are hygiene or hardening; none block submission. Three items are **UNVERIFIED** (with rationale): per-tier cold-start/peak-memory (2.6), live load-unpacked console capture (5.6), and "version > previously *published*" (5.4 — no published baseline exists in the repo). Every phase — including the "no issues" conclusions — is evidenced with `file:line` or command output below; no source file outside `audit/` was modified.

## Master Findings Table (sorted by severity)

| ID | Sev | Phase | Finding | Location | Fix |
|---|---|---|---|---|---|
| P4-03 | **MEDIUM** | 4 | Unused top-level `onnxruntime-web` runtime dep (nested `1.26.0-dev` is what ships) | `package.json`, `vite.config.ts:44` | fix 02 |
| P6-01 | **LOW/MED** | 6 | No IDB cache schema-migration / version-keying → stale-cache risk on future updates | `*Store.ts` (`DB_VERSION=1`) | fix 06 |
| P0-01 | LOW | 0 | `npm ci` emits 4 transitive-dep deprecation warnings (dev-only) | `build.log:2-5` | optional |
| P1-03 | LOW | 1 | Store/privacy copy omits the same-origin PDF re-read request | `pdf.ts:87` vs `STORE_LISTING.md:82` | fix 07A |
| P1-04 | LOW | 1 | `object-src`/`frame-src` broader than required (could be `'none'`) | `manifest.json:15` | fix 04 |
| P1-05 | LOW | 1 | Content-script `innerHTML` safe only via `escHtml`, but comment understates risk | `flagOverlay.ts:221-223` | fix 07B |
| P2-01 | LOW | 2 | WebGPU→WASM backend fallback is invisible to the user | `encoder.worker.ts:100-114` | optional |
| P2-02 | LOW | 2 | No cold-start / peak-memory instrumentation (2.6 UNVERIFIED) | — | optional |
| P3-01 | LOW | 3 | Analyst can render a claim without a jump-to-source span | `evidence.ts:191-229` | optional |
| P3-02 | LOW | 3 | No-advice post-filter omits explicit "price target" phrasing | `evidence.ts:89-95` | fix 05 |
| P3-03 | LOW | 3 | Sentiment inference has no mid-run cancellation | `SentimentPanel.tsx:224` | optional |
| P4-01 | LOW | 4 | Dead file `flagMeta.ts` + ~10 dead exports + redundant shim | DEAD-CODE.md §A/§B | fix 03 |
| P4-02 | LOW | 4/5 | `public/.DS_Store` + `icons/icon-source.png` ship into the package | `dist/` | fix 01 |
| P4-04 | LOW | 4 | Unused devDeps (`vite-plugin-static-copy`, `autoprefixer`, `postcss`) | `package.json` | fix 02 |
| P5-01 | LOW | 5 | `REVIEW.md`/`relic-review.md` stale — describe a superseded build | `REVIEW.md:30-63` | fix 07C |
| P6-02 | LOW | 6 | No SPA-navigation re-ingest (manual re-analyze on optional sites) | `content/index.ts` | optional |
| P6-03 | LOW | 6 | Redline relies on SW liveness via the open message port | `service-worker.ts:207-266` | optional |

**Deliverables:** [STORE-READINESS.md](STORE-READINESS.md) (policy checklist), [DEAD-CODE.md](DEAD-CODE.md) (reconciled inventory), [fixes/](fixes/) (01–07, ordered). "optional" = LOW enhancement with no dedicated fix prompt (no BLOCKER/HIGH exists to mandate one).

---

# Phase 0 — Map and Build

## 0.1 Repo map

**Extension surfaces / entry points** (all paths under `src/`, `.ts`→`.js` at build):

| Surface | Entry | Supporting modules |
|---|---|---|
| Background service worker (module) | `background/service-worker.ts` (`manifest.json:40`) | `background/edgarQueue.ts`, `background/inject.ts`, `background/resolvePrior.ts` |
| Content script (`https://*.sec.gov/*`, `all_frames`, `document_idle`) | `content/index.ts` (`manifest.json:48`) | `content/ingest/*` (classify, detect, dom-root, index, meta, pdf, position-map, readable, ready, segment, siteProfiles, xbrl), `content/highlight/*` (demo, flagOverlay), `content/positionMap.ts`, `content/segment.ts` |
| Side panel | `sidepanel/index.html` (`manifest.json:54`) → `main.tsx` → `App.tsx` | `AnalystPanel`, `SummaryPanel`, `SentimentPanel`, `RedlinePanel`, `FundamentalsPanel`, `ExportButton`, `FirstRun`, `OverlayControls`, `analysisActivity.ts`, `overlayPrefs.ts`, `ui.tsx` |
| Options page (open in tab) | `settings/index.html` (`manifest.json:57`) → `main.tsx` → `SettingsApp.tsx` | — |
| Offscreen document | `offscreen/offscreen.html` (vite `additionalInputs`, `vite.config.ts:298`) → `offscreen.ts` | `backendTuning`, `calibrateSentiment`, `chunker`, `deadline`, `deviceTier`, `inferencePref`, `pdfParse`, `sentenceFilter`, `webgpuPreflight` |
| Web Workers (ES module) | `workers/encoder.worker.ts`, `workers/sentiment.worker.ts` | `backendOrder`, `modelSizes`, `transformersEnv`, `webgpuLost` |
| Dev-only preview (NOT shipped) | `dev/preview.html`, `dev/settings-preview.html` | `dev/preview.tsx`, `dev/settings-preview.tsx`, `dev/chrome-mock.ts`, `dev/mock-data.ts`, `dev/preview.css` |

**Feature modules:** Summary → `summarizer/` (extractive, summarize, summaryStore); Analyst View → `analyst/` (pipeline, prompts, evidence, deterministic, relevance, semanticRerank, sentimentCalibration, lexiconTone, insightTitle, analysisStore); Sentiment → `db/sentimentStore.ts` + `workers/sentiment.worker.ts` + `offscreen/calibrateSentiment.ts` + `flagging/*`; Redline (prior-year Changes diff) → `redline/` (align, changeSummary, diff, parsePrior, redlineStore) + `background/resolvePrior.ts`; Export → `export/` (collect, pdf, report) + `vendor/jspdf-optional-stub.ts`.

**Capability-tier machinery:** `runtime/capabilities.ts`, `runtime/useCapabilities.ts`, `offscreen/deviceTier.ts`, `offscreen/webgpuPreflight.ts`, `offscreen/inferencePref.ts`, `offscreen/backendTuning.ts`, `workers/backendOrder.ts`, `workers/webgpuLost.ts`, `workers/transformersEnv.ts`, `shared/worksTiers.ts`.

**Model assets** (`models/`, gitignored, populated by `npm run fetch-models`): `Xenova/finbert` (`onnx/model_quantized.onnx` 110.7 MB int8, `tokenizer.json`, `vocab.txt`, configs) and `mixedbread-ai/mxbai-embed-xsmall-v1` (embeddings). Loaded at runtime via `chrome.runtime.getURL('models/')`.

**WASM binaries** (build output `dist/wasm/`): `ort-wasm-simd-threaded.{mjs,wasm}` (WASM/CPU backend) and `ort-wasm-simd-threaded.asyncify.{mjs,wasm}` (WebGPU backend, ~23.6 MB); plus `pdf.worker.min.mjs` (pdfjs-dist, 1.3 MB).

**Build config:** `vite.config.ts` (custom plugins: `copy-extension-assets`, `copy-ort-wasm`, `copy-models`, `shared-chunk-router`, `strip-remote-code-loaders`, plus `vite-plugin-web-extension`). Scripts: `clean-dist.mjs` (pre-build hermetic clean), `verify-dist.mjs` (post-build gate), `fetch-models.mjs` (manual, network), `generate-icons.mjs`, `smoke-wasm.mjs`, `smoke-webgpu.mjs`.

## 0.2 Manifest inventory (`manifest.json`)

| Field | Value |
|---|---|
| `manifest_version` | 3 |
| `minimum_chrome_version` | 116 (`manifest.json:5`) |
| **Permissions** (`:7-13`) | `storage`, `sidePanel`, `activeTab`, `offscreen`, `scripting` |
| **host_permissions** (`:23-25`) | `https://*.sec.gov/*` |
| **optional_host_permissions** (`:26-38`) | `*.annualreports.com`, `*.stockanalysis.com`, `*.fool.com`, `*.benzinga.com`, `*.sec.report`, `finviz.com`, `finance.yahoo.com`, `*.macrotrends.net`, `*.bamsec.com`, `*.cnbc.com`, `*.reuters.com` |
| **content_scripts** (`:43-52`) | match `https://*.sec.gov/*`; `js: content/index.ts`; `run_at: document_idle`; `all_frames: true` |
| **web_accessible_resources** | **none declared** (relies on default extension-page access + `getURL`) |
| **CSP `extension_pages`** (`:15`) | `default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; object-src 'self'; connect-src 'self' https://*.sec.gov; img-src 'self' data:; style-src 'self' 'unsafe-inline'; font-src 'self'; worker-src 'self'; frame-src 'self'; form-action 'none'; base-uri 'none'` |
| **COEP** (`:17-19`) | `require-corp` (enables cross-origin isolation → threaded ORT) |
| **COOP** (`:20-22`) | `same-origin` |
| Background | `service_worker: src/background/service-worker.ts`, `type: module` |
| side_panel | `src/sidepanel/index.html` |
| options_ui | `src/settings/index.html`, `open_in_tab: true` |
| action / icons | 16/32/48/128 PNGs under `icons/` |

The shipped manifest (`dist/manifest.json`) rewrites `.ts`→`.js` entry paths and overwrites `version` from `package.json` (`vite.config.ts:288-296`). Verified: `dist/manifest.json` version = `3.1.6`, matches `package.json`. No `optional_permissions` (only `optional_host_permissions`).

## 0.3 Clean build from pristine state

Commands run (log: scratchpad `build.log`, exit 0 throughout):

```
npm ci                 # wipes & reinstalls node_modules from package-lock.json
npm run build          # clean-dist.mjs && vite build && verify-dist.mjs  (x2)
```

- `npm ci`: **509 packages in ~5s** (real 5.15s). Four **deprecation warnings** for *transitive* dependencies only — `whatwg-encoding@3.1.1`, `boolean@3.2.0`, `uuid@8.3.2`, `glob@10.5.0`. These are dev-tree packages (jsdom / build tooling); none are runtime deps and none ship in `dist/`.
- `vite build`: **~2.5s** first run, **1.25s** second (models cached by `clean-dist` PRESERVE). Build steps: (1) bundles 3 HTML entrypoints `settings`/`sidepanel`/`offscreen` together (518 modules), (2) service-worker individually (10 modules), (3) content script individually (34 modules), then rewrites manifest.
- **No Vite build warnings emitted.** `chunkSizeWarningLimit` is 700 kB (`vite.config.ts:318`); largest emitted chunk is `dist/src/sidepanel/index.js` at 661.79 kB — under the limit, so no chunk-size warning fired.
- `verify-dist.mjs` passed both builds: "✓ dist/ looks shippable (manifest entries, icons, models, ORT glue+binary, CSP, no sourcemaps, no remote-code URLs)."

**Network at build time:** **None reached.** `npm run build` does not invoke `fetch-models`. Model weights are read from the local `models/` dir by `copy-models` (`vite.config.ts:114-139`), which `this.error()`s if the dir is absent rather than fetching. The only network-touching script, `fetch-models.mjs`, hits `https://huggingface.co` (`scripts/fetch-models.mjs:23,43`) and is a **manual, one-time developer step**, run separately before building. (`npm ci` itself reaches the npm registry, as expected for dependency install.)

## 0.4 Reproducibility

Two consecutive clean builds (`clean-dist` preserves the verbatim `models/` copy; all generated artifacts regenerated). SHA-256 manifest of all 41 `dist/` files (excluding OS-only `.DS_Store`) compared byte-for-byte:

**Result: `REPRO_RESULT=IDENTICAL` — 0 differing files.** The build is deterministic; no timestamped or hashed-by-clock artifacts. (Vite content-hashes chunk filenames, e.g. `encoder.worker-C3LPHgkg.js`, and those hashes were stable across both builds.)

Unpacked size: **171 MB** total (`dist/models` 131 MB, `dist/wasm` 36 MB, `dist/assets` 1.1 MB). Sits well under the Chrome Web Store hard cap; measured against the store's per-file/package limits in Phase 2.6 and Phase 5.5.

## Phase 0 findings

**P0-01 — LOW — `npm ci` emits 4 transitive-dependency deprecation warnings.**
Evidence: `build.log` lines 2-5 (`whatwg-encoding@3.1.1`, `boolean@3.2.0`, `uuid@8.3.2`, `glob@10.5.0`).
Impact: None on the shipped product — all four are in the dev/build dependency tree (not in `package.json` `dependencies`, not in `dist/`). Cosmetic install-time noise only.
Fix: Optional. `npm ls whatwg-encoding boolean uuid glob` to find the parent devDependency and bump it when upstream updates; not release-blocking.

**No blocking build issues.** Clean install + build succeeds from the lockfile, is byte-for-byte reproducible, reaches no network at build time, and passes the `verify-dist` gate.

---

# Phase 1 — Remote Code and Store Policy

## 1.1 Dynamic-code / injection pattern sweep

**Result: no dynamic-code-execution or injection risk in app code.** No `eval`, `document.write`, `importScripts`, script-tag injection, `chrome.userScripts`, or runtime templating library anywhere in `src/` or `dist/`.

| Pattern | `src/` + `dist/` finding | Class |
|---|---|---|
| `eval` / `window.eval` | none | — (CSP has no `'unsafe-eval'` → blocked even if present) |
| `new Function` / `Function()` ctor | none in `src/`; in `dist/` only vendor — core-js `getGlobalThis` fallback, pdf.js global probe, **Emscripten-embind** method invoker in ORT glue | BENIGN (vendor, build-fixed input, CSP-blocked at runtime) |
| `setTimeout/setInterval` string arg | none (all ~18 `src/` timers pass function refs, e.g. `stallGuard.ts:48`) | — |
| `document.write(ln)` | none | — |
| `.innerHTML=` (app) | **one** app site: `content/highlight/flagOverlay.ts:223` | BENIGN — escaped via `escHtml()` (see **P1-05**) |
| `.innerHTML=` (vendor) | React feature-detect + DOMPurify-sanitized jsPDF `html()` path; **no `dangerouslySetInnerHTML` in `src/`** | BENIGN |
| `.outerHTML` | comments only (`siteProfiles.ts`) | — |
| `insertAdjacentHTML` / `.constructor(` / `["constructor"]` | none | — |
| dynamic `import()` | `flagging/lexiconLoader.ts:122` (static local `./lexicons/*.json`), dev previews; **zero `import()` in `dist/`** | BENIGN (static local specifiers) |
| `chrome.scripting.executeScript` | `service-worker.ts:90,326` → `files:[CONTENT_SCRIPT_FILE]`, `CONTENT_SCRIPT_FILE='src/content/index.js'` (static const `:58`); no `func:`, no dynamic path | BENIGN (expected) |
| `chrome.userScripts` | none | — |

The vendor `new Function`/embind sites are additionally neutralized by CSP `script-src 'self' 'wasm-unsafe-eval'` (no `'unsafe-eval'`): JS string-execution is blocked at runtime; `'wasm-unsafe-eval'` permits only WASM compilation. ORT loads fine under this CSP (empirically verified — threaded workers run), so the embind invoker is unused or has a CSP-safe fallback. _(Mechanical sweep dispatched to a subagent per context-discipline; reconciled here, key sinks re-verified against source.)_

## 1.2 URL literal enumeration

Every `http(s)` URL literal in `src/` and emitted `dist/` JS, classified. **None left unknown; the only RUNTIME-FETCH URLs are two `*.sec.gov` data endpoints.**

| URL / host | Representative site | Class |
|---|---|---|
| `https://data.sec.gov/submissions/…` | `resolvePrior.ts:34,43` | **RUNTIME-FETCH** — prior-filing submissions JSON (data) |
| `https://www.sec.gov/Archives/edgar/data/…` | `resolvePrior.ts:53` | **RUNTIME-FETCH** — prior-filing HTML (data) |
| `https://huggingface.invalid/`, `hf.co` | `dist/assets/*.worker-*.js` | **DEAD/neutralized** — transformers.js remoteHost rewritten from `huggingface.co`; unreachable (`allowRemoteModels=false` + CSP) |
| `cdnjs.cloudflare.com`, `cdn.jsdelivr.net`, `unpkg.com`, `esm.sh`, `raw.githubusercontent.com`, `huggingface.co` | — | **ABSENT from `dist/`** — jsPDF + transformers.js CDN loaders stripped (`vite.config.ts:163-228`); build fails if any survive |
| worksTiers link text (`www.sec.gov/search-filings`, `annualreports.com`, `stockanalysis.com`, `fool.com`, `benzinga.com`, `marketwatch.com`, `finance.yahoo.com`) | `worksTiers.ts:27-49` | DOC/UI — `<a>` link text, not fetched |
| siteProfiles match-patterns (`*.annualreports.com`, `*.stockanalysis.com`, `*.fool.com`, `*.benzinga.com`, `*.sec.report`, `finviz.com`) | `siteProfiles.ts:70-90` | CONFIG — content-script URL matching, not fetched |
| `https://relic-lac.vercel.app/` | `SettingsApp.tsx:401` | DOC/UI — Settings external link (`rel=noopener`, user-click) |
| XML/SVG namespace URIs (`w3.org`, `xfa.org`, `ns.adobe.com`, `apache.org`) | `dist/pdf.worker.min.mjs`, SVG assets | DOC/const — namespace identifiers, never fetched |
| Vendor doc/error links (`github.com`, `web.dev`, `react.dev`, `rolldown.rs`, `developer.mozilla.org`) | `dist/ui.js`, worker chunks | DOC/COMMENT |
| Parser self-test placeholders (`https://a`, `example.com`, `foo.bar`) | vendor code | DEAD |

Test-only fixtures (`tests/**`) contain additional finance-host literals + a `cloudfront.net` PDF-fixture URL — none shipped. The `relic-lac.vercel.app` link is the extension's own site (external nav, not a data sink).

## 1.3 WASM binary + model weight resolution (zero-egress) — **VERIFIED LOCAL**

Every model weight and WASM binary loads from an extension-local `chrome-extension://<id>/…` URL. Resolution paths, call site → final URL:

| Asset | Call site | Env wiring | Final URL |
|---|---|---|---|
| ONNX model weights (finbert, mxbai) | `offscreen/offscreen.ts:473` `modelBasePath = chrome.runtime.getURL('models/')` → worker init msg | `transformersEnv.ts:23` `env.localModelPath = modelBasePath`; `:21` `env.allowRemoteModels = false` | `chrome-extension://<id>/models/Xenova/finbert/onnx/model_quantized.onnx` (+ tokenizer/config) |
| ORT WASM backends | `offscreen/offscreen.ts:472,662` `wasmPaths = chrome.runtime.getURL('wasm/')` → worker init | `transformersEnv.ts:18` `env.backends.onnx.wasm.wasmPaths = wasmPaths` | `chrome-extension://<id>/wasm/ort-wasm-simd-threaded[.asyncify].{mjs,wasm}` |
| pdf.js worker | `offscreen/pdfParse.ts:21` `import pdfWorkerUrl from 'pdfjs-dist/…/pdf.worker.min.mjs?url'` | `pdfParse.ts:24` `GlobalWorkerOptions.workerSrc = pdfWorkerUrl` | `chrome-extension://<id>/pdf.worker.min.mjs` (Vite `?url` emit) |

`env.allowRemoteModels = false` + `env.useBrowserCache = false` + `env.useWasmCache = false` (`transformersEnv.ts:21,26,28`) mean Transformers.js never issues a Hub fetch. Confirmed bundled: `dist/models/` (131 MB) and `dist/wasm/` (36 MB) exist after build; `verify-dist.mjs:84-126` asserts both.

## 1.4 CSP vs. actual need

CSP (`manifest.json:15`): `default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; object-src 'self'; connect-src 'self' https://*.sec.gov; img-src 'self' data:; style-src 'self' 'unsafe-inline'; font-src 'self'; worker-src 'self'; frame-src 'self'; form-action 'none'; base-uri 'none'`

| Directive | Need | Verdict |
|---|---|---|
| `default-src 'none'` | tightest baseline | ✅ load-bearing (verify-dist:66 guards it) |
| `script-src 'self' 'wasm-unsafe-eval'` | bundled JS + ORT `WebAssembly.compile` | ✅ required, minimal — no `unsafe-eval`/`unsafe-inline` |
| `connect-src 'self' https://*.sec.gov` | `getURL` local fetch + EDGAR | ✅ exact match to code |
| `worker-src 'self'` | encoder/sentiment/pdf workers | ✅ required (fallback to default-src 'none' would block workers) |
| `style-src 'self' 'unsafe-inline'` | Tailwind sheet (`'self'`) + **React/framer-motion inline style attrs** (`'unsafe-inline'`) | ⚠️ `'unsafe-inline'` is the one broad directive; silently depended on by framer-motion animation. Low risk given `default-src 'none'` + no untrusted-HTML sink (pending 1.1). |
| `img-src 'self' data:` | bundled images + data-URI (canvas/export) | ✅ reasonable |
| `font-src 'self'` | local display font (`SettingsApp.tsx:30`) | ✅ no remote fonts |
| `object-src 'self'` | **no `<object>`/`<embed>` consumer in extension pages** | ⚠️ broader than required — could be `'none'` |
| `frame-src 'self'` | **no `<iframe>` created in extension pages** (only ref is a comment in `content/ingest/dom-root.ts:4` about reading EDGAR's *page* iframes, governed by the page not extension CSP) | ⚠️ broader than required — could be `'none'` |
| `form-action 'none'`, `base-uri 'none'` | anti-exfil / anti-hijack | ✅ (form-action guarded by verify-dist:69) |

## 1.5 Network isolation — **VERIFIED: only `*.sec.gov` (+ same-origin PDF read)**

Every code path capable of issuing a network request:

| # | Call site | Destination | Constraint |
|---|---|---|---|
| 1 | `background/edgarQueue.ts:108` `fetchImpl(url,…)` (default `globalThis.fetch`, `:93`), via `fetchEdgarText` (`:90`) | `https://data.sec.gov/…`, `https://www.sec.gov/…` | URLs built against **hardcoded sec.gov origin prefixes** in `resolvePrior.ts:34` (`submissionsUrl`), `:43` (`continuationUrl`), `:53` (prior doc). Dynamic parts are path segments only. Callers: `service-worker.ts:221,242`, `resolvePrior.ts:164,190`. Platform-enforced by CSP `connect-src`. |
| 2 | `content/ingest/pdf.ts:87` `XMLHttpRequest` GET | the **tab's own PDF URL** (same-origin), passed from `content/index.ts:208` | Content script runs only on sec.gov (auto) or user-granted optional hosts; re-reads the document already open. No third-party egress. |

**Flagged specifically, all NEGATIVE:** no telemetry, no analytics, no error reporting, no `navigator.sendBeacon`, no `WebSocket`/`EventSource`, no remote font loading (`font-src 'self'`), no self-update check (Chrome/CWS handles updates). The EDGAR fetch is gated by a user setting — `RedlinePanel.tsx:356` `if (!secFetch) return; // never go to network` — so with the toggle off the extension makes **zero** network requests.

## 1.6 Declared permissions vs. actual usage — **all 5 used, none orphaned**

| Permission | Call site(s) | Verdict |
|---|---|---|
| `storage` | `chrome.storage.local` (20×), `.session` (19×), `.onChanged` (3×) | ✅ heavily used (caches + prefs) |
| `sidePanel` | `chrome.sidePanel.open` (SW action handler), `setPanelBehavior` | ✅ used |
| `activeTab` | toolbar-click → `executeScript` into active tab (`service-worker.ts:90` `onClicked`; `:326` on-demand); enables same-origin PDF XHR | ✅ used |
| `offscreen` | `chrome.offscreen.createDocument`/`closeDocument` + `runtime.getContexts` (`service-worker.ts:~132`) | ✅ used (hosts inference) |
| `scripting` | `chrome.scripting.executeScript` (`:90,:326`) | ✅ used |

Also `chrome.permissions.request`/`.contains` (`service-worker.ts:298`, side panel) drive the **`optional_host_permissions`** grant flow for non-SEC financial sites — runtime-requested, not standing. No declared permission lacks a call site.

## 1.7 Store-listing claims vs. observed behavior

| Claim (source) | Verdict |
|---|---|
| "On-device AI… Nothing leaves your browser" (`STORE_LISTING.md:25,47`) | ✅ supported (§1.3, §1.5) |
| "No accounts, no sign-in, no telemetry, no analytics" (`:79`, `PRIVACY.md:14`) | ✅ supported (§1.5) |
| "models are bundled… never downloaded from or contacted at any third-party server" (`:80`, `PRIVACY.md:24-27`) | ✅ supported (`allowRemoteModels=false`; huggingface.co stripped) |
| "the only network request Relic makes is to SEC.gov, and only when you request a Redline… turn it off in Settings" (`:82-84`) | ✅ EDGAR-only + toggle verified (`RedlinePanel.tsx:356`). ⚠️ see P1-03 (same-origin PDF XHR is also a request). |
| "CSP blocks every other network connection" (`:85`) | ✅ accurate for extension pages (`connect-src`) |
| "not investment advice… does not tell you to buy, sell, or hold" (`:108`, `PRIVACY.md:72`) | ⏳ deferred to Phase 3.4 (guardrail enforcement) |
| "Every point is… checked against the source text so claims stay grounded" (`:57`) | ⏳ deferred to Phase 3.3 (evidence grounding) |

## Phase 1 findings (preliminary — finalized after the 1.1/1.2 sweep)

**P1-03 — LOW — Privacy/store copy omits the same-origin PDF re-read request.**
Evidence: `content/ingest/pdf.ts:87` issues an `XMLHttpRequest` GET; store copy says "the only network request Relic makes is to SEC.gov" (`STORE_LISTING.md:82`).
Impact: No data egress (it re-reads the PDF already open in the tab, same-origin), but a reviewer inspecting network traffic on a non-SEC financial PDF will see a request the copy doesn't mention. Minor accuracy gap, not a policy violation.
Fix: Add a one-line footnote to the privacy copy noting the extension re-reads the current document's bytes locally when analyzing a PDF.

**P1-04 — LOW — `object-src`/`frame-src` broader than required.**
Evidence: `manifest.json:15` sets `object-src 'self'` and `frame-src 'self'`; no `<object>`/`<embed>`/`<iframe>` is created in any extension page (grep over `src/**` finds only a comment at `content/ingest/dom-root.ts:4`).
Impact: Defense-in-depth only — `default-src 'none'` already blocks most vectors. These two explicitly re-open `'self'`.
Fix: Tighten both to `'none'` for a minimal CSP. Non-blocking.

**P1-05 — LOW — Content-script `innerHTML` tooltip is XSS-safe only via `escHtml()`, but its comment understates the risk.**
Evidence: `content/highlight/flagOverlay.ts:223` sets `tip.innerHTML` interpolating `escHtml(flag.term)` / `escHtml(flag.note)` (`escHtml` at `:242-248` escapes `& < > "`). The comment `:221-222` claims these "come from bundled lexicons only; no user-supplied or filing-page content" — but `flag.term` is `match[0]`, i.e. **page-derived filing text** (`flagging/flagLanguage.ts:92`).
Impact: Currently safe (escaped). But the incorrect comment invites a future "optimization" that drops `escHtml` on the false premise the data is trusted — which would be a stored-DOM XSS in the content script running on `*.sec.gov` and granted financial pages.
Fix: Correct the comment to state `flag.term`/`flag.note` are page-derived and that `escHtml` is load-bearing; consider a lint/test asserting the escaping.

### Phase 1 verdict — **PASS (store policy)**

No BLOCKER or HIGH findings. Remote-code prohibition satisfied: **zero runtime fetch of executable content**, both CDN loaders excised from `dist/` and re-asserted by `verify-dist.mjs:160-187`, models/WASM loaded from `chrome-extension://` local URLs, CSP `connect-src` hard-limits egress to `*.sec.gov`, all 5 permissions used, store claims supported. Three LOW hygiene items (P1-03, P1-04, P1-05).

---

# Phase 2 — WebGPU and WASM Capability Tiers

There are **two orthogonal tier axes**, not one:
- **Generation tier** (`GenerationTier = 'builtin' | 'extractive'`): does Chrome's built-in AI (Summarizer / Prompt API / Gemini Nano) exist? Drives NL summaries + analyst narratives. Fallback = on-device extractive.
- **Inference backend** (`InferenceDevice = 'webgpu' | 'wasm'`): runs the bundled ONNX models (mxbai embeddings, FinBERT sentiment). WebGPU is a *perf* signal, **never a gate** — WASM is always the floor.

## 2.1 Detection trace + decision tables

**Generation tier** — `capabilities.ts:158` `getCapabilities()` runs three probes in parallel (`Promise.all`): `probeWebGPU()`, `probeBuiltin('Summarizer')`, `probeBuiltin('LanguageModel')`. Each builtin probe (`:104`) calls the API's own `availability(langOpts)` **raced against a 3 s timeout** (`BUILTIN_PROBE_TIMEOUT_MS = 3000`, `:99`); timeout or throw → `'unavailable'` (fail-soft). Result memoized (`_cache`), re-probe via `force=true` (`:158`) / `clearCapabilitiesCache()` (`:178`).

| Summarizer | Prompt API (LanguageModel) | → generationTier (`:167`) |
|---|---|---|
| available / downloadable / downloading | (any) | **builtin** |
| (any) | available / downloadable / downloading | **builtin** |
| unsupported or unavailable | unsupported or unavailable | **extractive** |
| probe hangs >3 s | probe hangs >3 s | → treated `unavailable` → **extractive** (UI never freezes) |

**Inference backend** — offscreen probes WebGPU (`webgpuPreflight.ts:74` `probeWebGpuAdapter()`: `navigator.gpu`? → `requestAdapter({powerPreference:'high-performance'})` → `requestDevice()`, each with an **800 ms** step budget `WEBGPU_PROBE_TIMEOUT_MS`, probe device destroyed immediately `:120`, never throws), then `preferredDeviceForTier()` (`deviceTier.ts:57`) picks the backend the worker attempts first:

| deviceMemory (`navigator.deviceMemory`) | `preferWasm` session flag | WebGPU preflight `device` | → preferredDevice | worker `resolveBackendOrder` | Final backend |
|---|---|---|---|---|---|
| >4 GB or absent (high-end) | false | ok | **webgpu** | `[webgpu, wasm]` | WebGPU (→WASM if init/inference fails) |
| >4 GB or absent | false | no_gpu / no_adapter / no_device / timeout / error | **wasm** | `[wasm]` | WASM |
| >4 GB or absent | **true** (prior fallback) | (probe skipped) | **wasm** | `[wasm]` | WASM |
| ≤4 GB (low-end) | (any) | (ignored) | **wasm** | `[wasm]` | WASM |

**WASM feature axis:** the shipped binary is `ort-wasm-simd-threaded` (SIMD-required, thread-capable). SIMD is **guaranteed at `minimum_chrome_version: 116`** (WASM SIMD shipped Chrome 91), so a "SIMD-absent" state cannot occur for a supported browser. Threads gate on `self.crossOriginIsolated` (COOP `same-origin` + COEP `require-corp` set → true): `ORT_NUM_THREADS = crossOriginIsolated ? min(LOW_MEMORY?2:4, hardwareConcurrency) : 1` (`offscreen.ts:123`). **Same binary** runs multi- or single-threaded — no separate non-threaded binary is needed or shipped.

| WASM SIMD | crossOriginIsolated (threads) | Result |
|---|---|---|
| present (always ≥116) | true (COOP/COEP set) | multi-threaded WASM, `numThreads=min(2\|4, cores)` |
| present | false (isolation somehow off) | single-threaded WASM, `numThreads=1`, same binary |
| absent (impossible ≥116) | — | both backends fail → worker posts visible `ERROR` (`encoder.worker.ts:107`) |

## 2.2 Fallback reachability + forcing hooks + tests

Every branch is reachable and the pure decision modules are **unit-tested**: `tests/backendOrder`… → `backendTuning.test.ts`, `capabilitiesTimeout.test.ts`, `deviceTier.test.ts`, `inferencePref.test.ts`, `webgpuPreflight.test.ts`.

**Exact hooks to force each tier for testing:**
| Force | Hook |
|---|---|
| Generation = extractive | non-Chrome browser (no `Summarizer`/`LanguageModel` global), **or** set `chrome.storage.local['relic:devForceMode'] = 'extractive'` (`SummaryPanel.tsx:16,330`) |
| Generation = builtin | Chrome with Gemini Nano available/downloadable, **or** `relic:devForceMode='builtin'` |
| Backend = WASM | `chrome.storage.session['relic:preferWasm']=true` (→ `?preferWasm=1` offscreen URL param, `inferencePref.ts:57`), **or** a ≤4 GB device, **or** `forceWasm` in the INIT message (`messages/types.ts:401`) |
| Backend = WebGPU | high-end device (deviceMemory >4 GB / absent) with a working adapter and `preferWasm` unset |

The session-fallback loop is closed: worker settles on a device → offscreen posts `INFERENCE_DEVICE` (`offscreen.ts:142`) → SW persists `setPreferWasm(true)` when it settled on WASM (`service-worker.ts:508-512`), so subsequent sessions skip a known-bad GPU until browser restart (session storage → retries after transient driver glitches).

## 2.3 WebGPU specifics

| Concern | Handling |
|---|---|
| adapter request failure | `webgpuPreflight.ts:82-100` — null adapter → `no_adapter`; throw/timeout → `error`/`timeout`; all fail-soft to WASM |
| device request failure | `:102-118` — null device → `no_device`; throw/timeout handled; fail-soft |
| `device.lost` | `webgpuLost.ts:44-48` — watches ORT's device `lost` promise, fires `onLost` once → `tryWasmFallback()` (`encoder.worker.ts:112`) |
| uncaptured error | `webgpuLost.ts:49-53` — `addEventListener('uncapturederror')` → same `onLost` |
| software-backed adapter | requests `powerPreference:'high-performance'` (prefers discrete GPU); a software adapter that yields a usable device is accepted (feature still runs); if it fails at init, the inference try/catch falls back to WASM |
| shader/pipeline compile error | surfaced as an init-loop `catch` (`encoder.worker.ts:97`), recorded in `attempts[]`, backend advances to WASM; a total failure posts `ERROR` with the joined attempt log (`:107`) |
| probe device lifetime | destroyed immediately after probe (`webgpuPreflight.ts:120`) so ORT can claim its own device |

**Mid-inference GPU death** is caught twice: the `device.lost`/`uncapturederror` watch *and* the per-call `isWebGpuFatalError` try/catch, both routing to `tryWasmFallback()`, which **disposes the old pipeline** (`encoder.worker.ts:135-140`) before a single shared WASM re-init. `sentiment.worker.ts` mirrors this pattern (`:57,72,81,100,114`).

## 2.4 WASM specifics

- **Instantiation:** via Transformers.js/ORT with `wasmPaths = getURL('wasm/')`; buffered (ORT fetches the `.wasm` after importing the `.mjs` glue). `wasm-unsafe-eval` in CSP permits compilation.
- **SIMD/threads:** covered in §2.1 — `ort-wasm-simd-threaded`, threads gated on `crossOriginIsolated`, `numThreads` capped at `min(2|4, hardwareConcurrency)`; single-threaded fallback uses the same binary. No fallback binary needed (min Chrome 116 guarantees SIMD).
- **Cross-origin isolation** provided by manifest COOP/COEP (`manifest.json:17-22`); `verify-dist.mjs:77-82` fails the build if either is dropped (would silently disable threading).
- **Memory growth / OOM:** ORT manages the WASM heap; there is no explicit `maximumMemory`/growth cap in Relic code (relies on ORT defaults). OOM during load surfaces as a pipeline-load throw → recorded attempt → `ERROR`. **No explicit OOM UX**; a load failure degrades to the worker `ERROR` path.
- **Worker termination cleanup:** `offscreen.ts:329,353` `worker?.terminate()` on recycle; workers `clearDeviceLostWatch()` before re-init (`encoder.worker.ts:70,131`).

## 2.5 State left behind on a tier transition

| Resource | Released? |
|---|---|
| Live GPU device (voluntary WASM fallback) | ✅ old pipeline `dispose()`d before re-init (`encoder.worker.ts:135-140`) |
| Live GPU device (offscreen teardown) | ✅ worker `terminate()` kills the worker → browser reclaims the device; `chrome.offscreen.closeDocument()` (`service-worker.ts:500`) |
| device-lost listener | ✅ `clearDeviceLostWatch()` + unsubscribe suppresses late callbacks (`webgpuLost.ts:59-61`) |
| WASM heap | released when the worker is terminated |
| pending promise w/o rejection handler | fallback is a single shared promise (`wasmFallback`) that all callers await; probes never reject (fail-soft). No orphaned rejection observed in the tier code. |
| UI stuck loading | the 3 s builtin-probe timeout + 800 ms WebGPU-probe timeouts guarantee `getCapabilities()` resolves, so the panel never hangs on "Detecting…" (`capabilities.ts:86-99` documents exactly this failure it prevents) |

## 2.6 Measurements

**Verified (static):**
| Item | Size |
|---|---|
| ORT WASM — CPU (`ort-wasm-simd-threaded.wasm`) | 12,942,611 B (12.3 MB) |
| ORT WASM — WebGPU (`…asyncify.wasm`) | 23,567,050 B (22.5 MB) |
| Model — FinBERT `model_quantized.onnx` (int8) | 110,717,965 B (105.6 MB) |
| Model — mxbai `model_quantized.onnx` (int8) | 24,448,010 B (23.3 MB) |
| `dist/wasm` total | 36 MB |
| `dist/models` total | 131 MB |
| **Total unpacked package** | **171 MB** |

Chrome Web Store's uploaded-package ceiling is far above this (well under any per-item cap); the *compressed* zip is measured in Phase 5.5 (the 105.6 MB `.onnx` and 22.5 MB `.wasm` both compress substantially — the WebGPU wasm gzips 23.6 MB→5.8 MB per the build log).

**UNVERIFIED (require live profiling, out of scope for static audit):** cold-start time per tier and peak memory per tier. No benchmark harness or timing instrumentation exists in the repo. See **P2-02**.

## 2.7 Silently-swallowed capability failures

- **Generation-tier failure → VISIBLE.** Extractive fallback is surfaced to the user and framed positively (first-run + Summary panel; corroborated by `relic-review.md:103` "extractive mode framed positively rather than as a failure"). ✅
- **WebGPU→WASM backend fallback → SILENT (by design).** The user sees no "GPU unavailable, using CPU" notice. This is a *performance* degradation only — the feature (sentiment/embeddings) still completes on WASM. Diagnostics are captured in `READY.diag.attempts` and `debugLog`, not shown to users. Flagged per audit scope (**P2-01**); judged acceptable (no lost capability), but noted.
- **Total inference-load failure (both backends) → `ERROR` posted** (`encoder.worker.ts:107`). Surfaced from the worker; UI rendering of that error state is verified in Phase 3.

## Phase 2 findings

**P2-01 — LOW — WebGPU→WASM backend fallback is invisible to the user.**
Evidence: `encoder.worker.ts:100-114`, `service-worker.ts:508-512` persist the fallback but no UI surface reports it; only `debugLog`/`READY.diag`.
Impact: None on correctness (feature completes on WASM); a user on a flaky GPU silently gets slower runs with no explanation. Acceptable by design, flagged per audit scope.
Fix (optional): expose a subtle, dismissible "running on CPU" indicator, or a Settings diagnostics line reading the last `INFERENCE_DEVICE`.

**P2-02 — LOW — No cold-start / peak-memory instrumentation.**
Evidence: grep of `REVIEW.md`, `relic-review.md`, `MANUAL_TEST.md` and `src/**` finds no timing/memory benchmarks; `smoke-wasm.mjs`/`smoke-webgpu.mjs` are build-time asset smoke tests, not runtime profiles.
Impact: Per-tier cold-start and peak-memory claims cannot be substantiated for the store listing or QA. Not a correctness defect.
Fix (optional): wrap INIT + first-inference in `performance.now()` deltas per backend and log once; capture peak memory via `performance.measureUserAgentSpecificMemory()` or Task Manager during a full 10-K run.

**Tier machinery verdict: robust.** Every detection branch is fail-soft with a bounded timeout, the WASM floor is unconditional, GPU resources are disposed on both fallback and teardown, and the pure decision logic is unit-tested. No blocking or high-severity issues.

---

# Phase 3 — Feature Verification

## Verification matrix (6 columns per feature)

| Feature | Entry point | Code path | Tier dependence | Failure modes | Empty / error states | Cancellation (navigate-away) |
|---|---|---|---|---|---|---|
| **Summary** | `SummaryPanel.tsx` (auto-run on filing ready) | `summarizer/summarize.ts` (Chrome Summarizer API) → `extractive.ts` fallback → `summaryStore` cache | `effectiveTier = builtin&&nanoReady ? builtin : extractive` (`:312`); `DEV_FORCE_KEY` override | Summarizer create/availability fail → extractive; extractive always available | per-section `status: idle/loading/done/error` (`:35`), red error text (`:152`) | per-section `acRefs` AbortControllers (`:293`); nano-probe effect cleanup (`:290`); `session.destroy()` (`summarize.ts:220`) |
| **Analyst View** | `AnalystPanel.tsx` | `analyst/pipeline.ts` `generateFilingAnalysis` (deterministic snapshot → staged LM) + `evidence.ts` guards + `deterministic.ts` baseline + `analysisStore` | deterministic baseline always; LM stages overwrite when `builtin`; fail-soft per stage (`pipeline.ts:14`) | stage parse/timeout → keep deterministic (`withDeadline:153`); no LM → full deterministic | deterministic snapshot always renders; scrubbed-empty insight → dropped (`evidence.ts:199`) | `acRef` abort on filing-change/unmount (`:365,435`); `signal` → pipeline → child LM sessions; aborted-guards (`:396,402,407,414`) |
| **Sentiment** | `SentimentPanel.tsx` (`ANALYZE_SENTIMENT`) | offscreen → `sentiment.worker.ts` (FinBERT ONNX, WebGPU/WASM) → `sentimentStore`; `calibrateSentiment` | backend WebGPU→WASM (perf only); runs on every tier (WASM floor); independent of generation tier | worker load fail → `ERROR`; backend fallback silent (P2-01) | `status: idle/loading/done/error` (`:26`); `setError(resp.error)` (`:256`); streamed section events (`:189`) | ⚠️ **coarse** — panel removes listener (`:224`) but no `CANCEL_SENTIMENT`; offscreen worker finishes the in-flight batch (P3-03) |
| **Redline (Changes)** | `RedlinePanel.tsx` | SW `resolvePriorFiling` → `fetchEdgarText` → `parsePrior` → `redline/align`+`diff` → `changeSummary` (LM opt.) → `redlineStore` | diff deterministic; narrative uses LM when `builtin`; **gated by `secFetch` setting** (`:356`) | no prior → `no_prior`; unsupported form → `unsupported_form`; EDGAR fail → error; toggle off → disabled | `no_prior` / `unsupported_form` / error states rendered honestly (`:283`) | `redlineAbort` AbortController (SW`:189`); new run aborts prior (`:217`); `CANCEL_REDLINE` (`:447`); signal checks (`:229,244`) |

## 3.1 Analyst progressive execution — **VERIFIED**

`generateFilingAnalysis` (`pipeline.ts:305`) computes the deterministic analysis first and emits it before any LM call: `opts.onStage?.('snapshot', det)` (`:313`) — **the snapshot renders before the streaming stages.** Stages run over a deterministic baseline; each LM stage OVERWRITES only its section on success (`:327-328`), and "stages fail soft: a parse failure skips the stage, the rest continue" (`:14`). Per-stage `withDeadline` (`:153`) gives the first LM call a longer budget (cold download/warmup) and aborts the child signal on timeout without failing later stages. Confirmed: **a failed stage does not block the ones after it** — the deterministic content for that section persists and subsequent stages proceed.

## 3.2 Prior-year resolution correctness — **DEFECT FIXED on HEAD (by commit `487b401`)**

**The defect (pre-`487b401`):** inline XBRL renders `dei:DocumentPeriodEndDate` as display text ("September 30, 2023"), and `meta.ts` passed it through unnormalized. `selectPrior` did `periodOfReport.slice(0, 10)` → target `"September "`. Every EDGAR `reportDate` is ISO (starts with a digit); digits sort before `'S'`, so `reportDate < target` was **always true** and `.find()` returned index 0 (the newest same-form filing). Live effect: **Apple's FY2023 10-K resolved its "prior" as FY2025** (two years *forward*) and reported ~35 % of Risk Factors changed.

**Current HEAD state (`d383a57`):** the resolver is **unchanged since `487b401`** (`git log 487b401..HEAD -- resolvePrior.ts parsePrior.ts fiscalCalendar.ts` is empty). The fix is present and complete:
- `selectPrior` normalizes via `toIsoDate(periodOfReport)` (`resolvePrior.ts:125`), not `.slice()`, and selects the largest `reportDate` **strictly earlier** than target (`:129-132`).
- `toIsoDate` (`lib/date.ts:62-98`) parses "September 30, 2023", "Sept. 30 2023", "30 September 2023", "09/30/2023", and ISO — avoiding `Date.parse`'s timezone day-shift; unparseable → `undefined` (treated as "unknown", never comparable).
- Ingest normalizes at source: `meta.ts:61` `periodOfReport = toIsoDate(queryXbrlFact(doc,'dei:DocumentPeriodEndDate') ?? …)`.

**Traced for Apple FY2023 on HEAD:** ingest → "September 30, 2023" → `"2023-09-30"`; `selectPrior('10-K','2023-09-30')` → sorted-desc same-form `.find(rd < target)` → **FY2022 `0000320193-22-000108`** — matching the commit's stated post-fix result (~12 % Risk-Factor delta). **No fix needed; do not modify.** (Had it still been present, the fix would be exactly the `toIsoDate` normalization now in place.)

## 3.3 Evidence grounding — **strong, with two unsourced-render paths (P3-01)**

`finalizeInsight` (`evidence.ts:191`) applies three guards to every model insight: (a) `scrubAdvice` + `normalizeFiscalLabels`; (b) `scrubUnverifiedFigures` — any sentence with a financial figure not appearing anywhere in the source is dropped and confidence → 'Low' (`:174-179,217`); (c) `verifyEvidence` — the `evidence` quote must be locatable in the source (whitespace/quote-tolerant regex) to earn a DOCUMENT-space `evidenceRange` for jump-to-source (`:69-83`); an **unverifiable quote is dropped and confidence → 'Low'** (`:226-227`); if scrubbing empties the insight it is dropped (`:199`).

**Unsourced-render paths (P3-01):** (1) an LM insight with **no `evidence` quote** renders at its original confidence with **no `evidenceRange`** (no clickable source span) — its figures are verified and advice scrubbed, but the qualitative prose has no anchor; (2) an insight whose quote **fails verification** still renders its `summary`/`investorMeaning` text (downgraded to 'Low', no span). The deterministic tier always supplies an `evidenceRange` (`:188-189`), so this affects only LM-authored cards lacking/failing a quote.

## 3.4 No-advice guardrail — **two-layer (prompt + post-generation filter); narrow price-target gap (P3-02)**

Enforcement is **not** prompt-only:
- **Prompt-level:** `prompts.ts:25` "(3) Never give investment advice. Never tell the reader to buy, sell, or short."; `ANALYST_DISCLAIMER` (`:16`).
- **Post-generation filter:** `scrubAdvice` (`evidence.ts:98-103`) deletes any *sentence* matching `ADVICE_PATTERNS` (`:89-95`): "you/investors should buy/sell/short/avoid/dump/hold", "we recommend/advise/suggest buying/…", "strong buy/sell", "buy/sell/short the/this stock/shares", and **directional price predictions** "(the) stock/shares/price will go up/rise/fall/soar/crash". Applied to title/summary/whyItMatters/investorMeaning in `finalizeInsight`.

**Gap (P3-02):** the patterns catch advice verbs + directional predictions but **not explicit numeric price-target phrasing** ("price target of $200", "fair value $180", "target price"). Invented target *numbers* are caught indirectly by `scrubUnverifiedFigures` (a $-figure absent from source drops the sentence), but a price-target phrase reusing an in-document figure, or a non-numeric target ("meaningful upside to fair value"), could pass. Prompt-level suppression is the only backstop for those.

## 3.5 Cancellation and teardown — **VERIFIED (Analyst/Redline/Summary); coarse for Sentiment**

- **Navigation / filing-change:** `AnalystPanel` `useEffect` cleanup aborts on `doc.rawTextHash` change (`:435`); `SummaryPanel` per-section AbortControllers; content script re-ingests via `__relicReingest` on SPA re-analyze (`content/index.ts:491`).
- **Tab close / panel close:** React unmount fires the same cleanup → `acRef.current?.abort()`.
- **Redline:** SW-side `redlineAbort`; a new redline or `CANCEL_REDLINE` aborts the in-flight EDGAR fetch (`service-worker.ts:217,447`).
- **SW termination mid-inference:** heavy inference is **not** SW-hosted — ONNX runs in the offscreen document, the Analyst LM in the side panel — so SW death doesn't kill inference. An in-flight *redline EDGAR fetch* in the SW would be interrupted by SW termination; the side panel's progress listener would stall (cross-ref Phase 6.1).
- **Sentiment (P3-03):** the panel removes its message listener on unmount (`:224`) but there is no `CANCEL_SENTIMENT` — the offscreen worker completes the current batch. Wasted compute on fast navigation; results are keyed by `rawTextHash` so no incorrect state.

## Phase 3 findings

**P3-01 — LOW — Analyst can render a claim without a jump-to-source span.**
Evidence: `evidence.ts:191-229` — an insight with no `evidence` quote returns `base` without `evidenceRange` (`:229`); an unverifiable quote renders text at 'Low' confidence with no span (`:226-227`).
Impact: The store line "every point is checked against the source text so claims stay grounded" holds for *figures* (verified) and *advice* (scrubbed), but a qualitative LM claim can lack a clickable source anchor — weakening the "traceable" positioning.
Fix: Require an `evidenceRange` to render an LM card at ≥'Medium' confidence, or visibly mark spanless cards as "no direct source quote".

**P3-02 — LOW — No-advice post-filter omits explicit price-target phrasing.**
Evidence: `ADVICE_PATTERNS` (`evidence.ts:89-95`) match buy/sell/short/hold + directional predictions, not "price target"/"target price"/"fair value $X".
Impact: A model price target reusing an in-document figure could bypass both `scrubAdvice` and `scrubUnverifiedFigures`. Low likelihood given prompt suppression, but the store/privacy "not investment advice" claim is load-bearing.
Fix: Add a `/(price\s+target|target\s+price|fair\s+value|price\s+objective)/i` pattern to `ADVICE_PATTERNS`.

**P3-03 — LOW — Sentiment inference has no mid-run cancellation.**
Evidence: `SentimentPanel.tsx:224` removes the listener but sends no cancel; the offscreen FinBERT worker finishes its batch.
Impact: Wasted GPU/CPU on rapid navigation; no correctness issue (cache keyed by `rawTextHash`).
Fix (optional): send a `CANCEL_SENTIMENT` to the offscreen document to abort the worker's remaining batches.

**Feature verdict: sound.** The marquee prior-year regression is fixed on HEAD; progressive execution, evidence guards, the two-layer advice filter, and cancellation are all present. Three LOW refinements (P3-01/02/03); no BLOCKER or HIGH.

---

# Phase 4 — Dead Code and Dependency Hygiene

Full reconciled inventory in **[DEAD-CODE.md](DEAD-CODE.md)**; findings summarized here.

## 4.1 Static unused-code reconciliation (knip + ts-prune + depcheck)

`knip` has **no config** (`knip.json`/`package.json#knip` absent), so it does not model the MV3 `manifest.json`, `new Worker(new URL())`, HTML `<script>` entries, CSS `@import`, or dynamic `import()` — its "43 unused files" is overwhelmingly a **cascade** from 5 unrecognized entry roots. Reconciled against actual import sites (`.js`-extension imports, worker URLs, dynamic lexicon imports, dev-preview config), the genuinely dead set is tiny:

- **1 dead source file:** `src/shared/flagMeta.ts` (sole export `CATEGORY_META:13` — zero references anywhere).
- **~10 dead exported symbols** (details in DEAD-CODE.md §B): `clearSentimentCache` (`sentimentStore.ts:88`), `clearSummariesForDoc` (`summaryStore.ts:112`), `lexiconMeta` (`lexiconLoader.ts:190`), `getSecFetchEnabled` (`secFetchPref.ts:19`, superseded by the `useSecFetchPref` hook), `ProgressBar` (`ui.tsx:100`), `ANALYST_DISCLAIMER` (`prompts.ts:16` — note the LIVE `DISCLAIMER` in `summarize.ts:28` is a different symbol), `AnalysisArtifacts` type (`types/index.ts:153`), 6 unused message-type interfaces (`messages/types.ts`), and the barrel re-export lines `ingest/index.ts:152-157`. `createSummarizer` (`capabilities.ts:196`) is dead but part of the built-in-AI capability surface — **medium** risk, may be intended API.
- **1 redundant shim:** `src/offscreen/sentenceFilter.ts` is a 6-line re-export of `@/lib/sentenceFilter` (live via `offscreen.ts:55`, but `offscreen.ts` could import the lib directly).

## 4.2 Unreferenced / stray assets

| Asset | Ships to `dist/`? | Note |
|---|---|---|
| `public/.DS_Store` (6148 B) | **YES** — Vite `publicDir` copies it → `dist/.DS_Store` every build (verified byte-identical) | **P4-02** — macOS junk in the package unless the zip excludes it |
| `public/icons/icon-source.png` (1024²) | **YES** → `dist/icons/icon-source.png` | Build *input* for `generate-icons.mjs:12`, not a runtime asset — should live outside `public/` |
| `brand-logo.png` (in `public/` **and** `src/assets/`) | YES (one copy) | Redundant dual source — both resolve to `dist/brand-logo.png` (publicDir + `copyExtensionAssetsPlugin`) |
| `src/assets/settings-user-gear.svg` | No | Dead source asset — zero references, not copied |
| `src/flagging/lexicons/*.json` (8) | YES | **All live** — 4 static + 4 dynamic imports (`lexiconLoader.ts:26-29,122-125`); knip FP |

## 4.3 Dead runtime branches — **clean (dev-gated, stripped in prod)**

Dev-only code is gated by `import.meta.env.DEV`, which Vite statically replaces with `false` in the production build and tree-shakes: the DEV force-mode UI (`SummaryPanel.tsx:597`), the applied `forceMode` value (`:311`), and all `debugLog` calls (`lib/debug.ts:12`). **Verified stripped from `dist/`**: no `import.meta.env`, no `debugLog`, no bare `console.log` (only intentional `console.warn`/`console.error` in catch handlers ship). One residue: the `relic:devForceMode` storage **read** (`SummaryPanel.tsx:329-335`) runs in prod because its sibling output `forceModeReady` gates cache loading — the read itself is inert (value never applied). No feature flags permanently-on/off ship live; no commented-out code blocks of note.

## 4.4 Orphaned handlers & storage keys — **none orphaned**

**Storage keys** (11 total) are **all written-and-read** (full table in DEAD-CODE.md §E): 8 `chrome.storage.local` (`relic:onboarded/hasAnalyzed/infoOpen/devForceMode/secFetch/flagsEnabled/flagTypes/showBoilerplate`) + 4 `chrome.storage.session` (`filing:current`, `filing:model:${hash}`, `filing:flags:${hash}`, `relic:preferWasm`). No write-only or read-only orphan. **Message handlers**: every `msg.type` dispatched has a handler and vice-versa (cross-ref Phase 6.2); no orphaned handler.

## 4.5 Dependencies shipped into the build (license + commercial use)

All 7 runtime deps carry **commercial-friendly licenses** (MIT / Apache-2.0):

| Dep | License | `dist/` contribution |
|---|---|---|
| `@huggingface/transformers` 4.2.0 | Apache-2.0 | worker chunks (~508 KB ×2) |
| `onnxruntime-web` (ships **nested `1.26.0-dev.20260416`** via transformers.js, **not** the top-level `^1.26.0`) | MIT | `dist/wasm/` 35 MB + ORT glue |
| `pdfjs-dist` 6.1.200 | Apache-2.0 | `pdf.worker.min.mjs` 1.2 MB |
| `react` 19 / `react-dom` 19 | MIT | in `dist/ui.js` (196 KB shared) |
| `framer-motion` 12 | MIT | in `dist/ui.js` |
| `jspdf` 4.2.1 | MIT | export path; optional integrations stubbed |

**Unused deps:** top-level **`onnxruntime-web`** (runtime — the *nested* copy is what ships; the top-level is dead weight and its declared `^1.26.0` doesn't even dedupe with the nested dev-snapshot) — **P4-03, medium**; devDeps `vite-plugin-static-copy` (replaced by the custom `copyWasmPlugin`), `autoprefixer`, `postcss` (no PostCSS/Tailwind config; Tailwind v4 via `@tailwindcss/vite` needs neither) — **P4-04, low**. _(UNVERIFIED: exact per-library byte split inside the co-bundled `dist/ui.js`.)_

## Phase 4 findings

**P4-01 — LOW — Dead source: `flagMeta.ts` + ~10 dead exports + redundant `sentenceFilter` shim.** Evidence/list: DEAD-CODE.md §A/§B. Impact: maintenance clutter only; none ship meaningful bytes. Fix: delete `shared/flagMeta.ts`; drop the listed dead exports (keep `createSummarizer` pending an API-surface decision); repoint `offscreen.ts:55` to `@/lib/sentenceFilter` and delete the shim. Removal risk low (createSummarizer/shim: medium).

**P4-02 — LOW — `public/.DS_Store` and `public/icons/icon-source.png` ship into `dist/`.** Evidence: `public/.DS_Store` byte-identical to `dist/.DS_Store`; `icon-source.png` copied to `dist/icons/`. Impact: macOS junk + a 1024² build-input PNG in the uploaded package (harmless but unprofessional; some reviewers flag stray files). Fix: `rm public/.DS_Store`, move `icon-source.png` out of `public/`, and exclude `.DS_Store` at zip time (Phase 5 does).

**P4-03 — MEDIUM — Unused top-level runtime dependency `onnxruntime-web`.** Evidence: build copies ORT from `node_modules/@huggingface/transformers/node_modules/onnxruntime-web/dist` (`vite.config.ts:44`); transformers.js resolves its own nested `1.26.0-dev` copy; nothing imports the top-level `^1.26.0`. Impact: dependency-graph noise + a misleading version signal (the `vite.config.ts` "1.22" comments are stale). Fix: remove `onnxruntime-web` from `dependencies` and rebuild to confirm `dist/wasm` still populates; update the stale comments.

**P4-04 — LOW — Unused devDependencies (`vite-plugin-static-copy`, `autoprefixer`, `postcss`).** Evidence: DEAD-CODE.md §C. Impact: none on the shipped product; install-graph bloat. Fix: remove after confirming no implicit PostCSS step.

**Dead-code verdict: very clean.** One dead file, a short dead-export list, three stray/unused packaging items, and one unused runtime dep — no large dead subsystems, no orphaned storage keys, all licenses commercial-friendly.

---

# Phase 5 — Build Output Verification

## 5.1 File inventory

`dist/` = **42 files / 17 dirs, 169.6 MiB uncompressed**. Every file traces to a source origin (full grouped inventory produced by the Phase-5 sweep). Largest: `models/Xenova/finbert/onnx/model_quantized.onnx` 105.6 MB, `models/mixedbread-ai/…/model_quantized.onnx` 23.3 MB, `wasm/…asyncify.wasm` 22.5 MB, `wasm/…threaded.wasm` 12.3 MB, `pdf.worker.min.mjs` 1.24 MB, `src/sidepanel/index.js` 646 KB, the two worker chunks 508 KB each. **Two files flagged:**
- `dist/.DS_Store` (6.1 KB) — copied from `public/.DS_Store` by Vite; **excluded by the standard zip** (`-x '*.DS_Store'`) but present in `dist/`. (P4-02)
- `dist/icons/icon-source.png` (181 KB) — the hi-res icon *source*, not referenced by the manifest, **ships in the zip** (dead weight). (P4-02)

No other unaccounted files.

## 5.2 No-leak scan — **clean**

| Check | Result |
|---|---|
| source maps `*.map` | **absent** (also asserted by `verify-dist.mjs:153`) |
| `.env` files | absent |
| test files / `fixtures/` / `tests/` | absent |
| dev code (`import.meta.env`, `debugLog`, `DevSettings`, `preview`, `mock-data`, `chrome-mock`) | **absent** — entire `src/dev/` tree tree-shaken |
| **secrets** (`sk-`, `api_key`, `AKIA`, `-----BEGIN`, `eyJ`, `bearer`, `password`, token literals) | **none** — every hit benign: "ri**sk**-factor" prose, a `password` input-type identifier, pdfjs `PasswordException` code, and transformers.js's HF token-gate reading `{}.HF_TOKEN` (an empty-object shim → `undefined`, header never set). No hardcoded credential anywhere. |
| debug logging | app `debugLog`/`console.log` **absent**; only vendored level-gated loggers (ORT/transformers) + intentional `[Relic]`-prefixed `console.warn/error` catch handlers |

One benign residue: the string literal `relic:devForceMode` (`sidepanel/index.js:126`) — an inert storage key; the dev UI that reads/writes it meaningfully is `import.meta.env.DEV`-gated and stripped (see §4.3).

## 5.3 Source-tracing & hand-edit check

Every emitted artifact maps to a source: `src/**` entries, the shared React/Tailwind chunks, `sharedChunkRouterPlugin` output, `src/workers/*` + vendored transformers/ORT, `src/vendor/jspdf-optional-stub.ts`, bundler-generated runtime helpers, `pdf.worker.min.mjs` (`?url` import), `copyWasmPlugin`/`copyModelsPlugin`/`copyExtensionAssetsPlugin`/publicDir copies, and the `webExtension` manifest function. No artifact lacks a source. **Hand-edit evidence:** the Phase-0 double-build was **byte-identical** — a hand-edited artifact would differ on rebuild — and `verify-dist.mjs` self-asserts manifest entries, icon dims, model presence, ORT glue+binary pairing, CSP, no `.map`, and no remote-code URLs.

## 5.4 Manifest verification

| Field | `dist/manifest.json` | Verdict |
|---|---|---|
| `version` | `3.1.6` = `package.json` | ✅ match (build forces `version = pkg.version`, `vite.config.ts:288-296` — cannot drift) |
| `description` | identical to `package.json` | ✅ match |
| `name` | "Relic - Instant Investor Analysis" (vs npm id `relic`) | ✅ by design — manifest is the display name |

**"Version greater than previously submitted" → UNVERIFIED.** The repo records **no previously *published* store version** (0 git tags; no version in `CWS_SUBMISSION.md`; the only prior datapoint is a `vite.config.ts:142` comment noting the **rejected** v1.2.7 "Blue Argon"). `3.1.6 > 1.2.7` numerically, but CWS increments against the currently-*published* version, which the repo cannot tell us.

## 5.5 Packaging

Zip = `cd dist && zip -rX relic-cws.zip . -x '*.DS_Store'`: **110,229,196 B ≈ 105.1 MiB compressed** (169.6 MiB uncompressed), **41 file entries**, `.DS_Store` excluded. Top-level: `assets/ icons/ models/ src/ wasm/ manifest.json ui.js ui.css brand-logo.png pdf.worker.min.mjs jspdf-optional-stub.js` + 3 bundler runtime files. **CWS per-item limit is 2 GB → the package is at ~5%, comfortably within.** Low (~38%) compression is expected (payload is already-compressed ONNX + WASM).

## 5.6 Load-unpacked console capture — **UNVERIFIED (out of session scope)**

Brave and Chrome are installed, but the repo has **no committed browser-automation harness** (no puppeteer/playwright/CDP), and `MANUAL_TEST.md:16` defines loading as a **manual** "Load unpacked → select `dist/`" step. Automating a full install/activation/feature-run console capture would require an ad-hoc Brave `--load-extension` + CDP setup driving a live EDGAR filing — intrusive (headful browser) and disproportionate for an unattended static audit, and at risk of the ~40-call phase budget. Per the "mark UNVERIFIED rather than assert" rule, live console capture is **not performed here**. Substitutes in evidence: the `verify-dist` gate passes, the build is byte-reproducible, no secrets/dev-code ship (§5.2), and the message-flow/lifecycle analysis (Phase 6) is static-clean. **Recommendation:** run `MANUAL_TEST.md` §0–§7 before submission and confirm a clean console on install, first activation, and a full feature run.

## Phase 5 findings

**P5-01 — LOW — `REVIEW.md` is stale and misdescribes the shipped build.**
Evidence: `REVIEW.md:30-31,59-63` flag `web_accessible_resources` granting `*.fool.com`/`*.seekingalpha.com` (H1) and a "114 MB zip / 209 MB unpacked with **four** ORT WASM variants" (H2). The current build has **no `web_accessible_resources`** (grep count 0), sec.gov-only host permissions, **two** WASM binaries, and a 105 MiB zip — i.e. both HIGH issues are **already resolved**, but the doc still reads as current.
Impact: A reviewer/developer reading `REVIEW.md` (or the similarly-dated `relic-review.md`) would draw false conclusions about permissions and package size. Not shipped to the store, so not a submission blocker.
Fix: Update or date-stamp `REVIEW.md`/`relic-review.md` to the current build (2 WASM variants, no WAR, sec.gov-only), or mark them as historical.

_(Packaging junk `dist/.DS_Store` + `icons/icon-source.png` are tracked under **P4-02**; Phase 5 confirms `icon-source.png` ships in the zip while `.DS_Store` is excluded by the standard `-x` flag.)_

**Build-output verdict: shippable.** No maps/env/tests/secrets/dev-code/verbose-logging; version pinned to 3.1.6; reproducible; 105 MiB zip within limits. Two housekeeping items (P4-02) and one stale internal doc (P5-01); live console capture deferred (5.6, UNVERIFIED).

---

# Phase 6 — Manifest V3 Lifecycle and Resilience

## 6.1 Service-worker termination

Module-scope state in the SW and its survival across termination:

| State | Line | Survives termination? |
|---|---|---|
| `edgarQueue = new RateLimitedQueue({maxPerSecond:8})` | `service-worker.ts:182` | No — reconstructed fresh on wake. Rate-limit window resets; any *queued* requests are lost (only populated during an active redline, which is already dead if the SW died). |
| `redlineAbort` | `:189` | No — per-run controller; irrelevant after termination. |
| `_offscreenCreating` | `:108` | No — null between creations; `ensureOffscreen` re-checks `getContexts` on wake, so the singleton guard is correct across restarts. |

**Listeners are registered synchronously at top level** (`chrome.action.onClicked` `:72`, `chrome.runtime.onMessage` `:342`), and top-level side effects (`setPanelBehavior` `:68`, `ensureSessionStorageAccess` `:101`) re-run on every wake — so a terminated SW is correctly rebuilt when the next message/event wakes it. No path assumes persistent in-memory state beyond a single event.

**One path assumes the SW stays alive: the redline** (`handleComputeRedline:207`). It holds the message port open (`return true` `:443`) across `resolvePriorFiling` + one-or-more rate-limited EDGAR fetches + offscreen hand-off. Chrome keeps the SW alive while the port is open / a fetch is in flight, but a pathologically slow EDGAR (repeated 429 back-offs) could approach the MV3 ~5-min cap and orphan the response (the side panel's `REDLINE_PROGRESS` listener would simply stall). Low likelihood; **P6-03**.

## 6.2 Message passing — **VERIFIED sound**

- The SW router early-outs on `msg.target !== 'sw'` (`:349`) so it never consumes another context's messages.
- **Every async handler returns `true` and always calls `sendResponse` in both `.then` and `.catch`**: SUMMARIZE_SECTION (`:391-394`), ANALYZE_SENTIMENT (`:406-409`), EMBED_TEXTS (`:416-419`), PARSE_PDF (`:431-434`), COMPUTE_REDLINE (`:440-443`), ANALYZE_PAGE (`:455-460`), ENSURE_SESSION_STORAGE (`:464-467`), PERSIST_FILING (`:472-476`). No port is left open without a response.
- Fire-and-forget handlers correctly `return false` (HIGHLIGHT_RANGE, CLEAR_HIGHLIGHTS, CANCEL_REDLINE, FILING_READY, FLAG_RESULTS, OFFSCREEN_IDLE, INFERENCE_DEVICE).
- The **offscreen** listener mirrors the discipline: `return true` + `.then(sendResponse).catch(sendResponse)` (`offscreen.ts:1251-1253,1261-1271`), so a forwarded request always resolves; if the offscreen document is destroyed mid-request the SW's `sendMessage` rejects → its own `.catch` responds `{ok:false}`. No permanent hang.

## 6.3 Storage — **quota OK; no schema-migration path (P6-01)**

- **Backend:** four IndexedDB DBs — `relic-redlines`, `relic-analyses`, `relic-sentiment`, `relic-summaries` (`redlineStore.ts:18`, `analysisStore.ts:14`, `sentimentStore.ts:12`, `summaryStore.ts:14`). IDB quota is disk-based, so the absent `unlimitedStorage` permission is a non-issue (only small keys — `filing:current`, `relic:preferWasm`, etc. — use `chrome.storage`). `idbEvict.ts` bounds growth; write failures are caught (`console.warn`), so a QuotaExceeded degrades to "not cached", not a crash.
- **Concurrent writes:** IDB transactions serialize per-key; cache keys are content-hash (`rawTextHash`) + tier, so cross-tab collisions are benign.
- **Migration:** all DBs are pinned at `DB_VERSION = 1` with an `onupgradeneeded` that only *creates* the store — **there is no v1→vN migration and no app/schema-version component in the cache key.** A future update that changes a stored object's shape would read old-shaped entries as-is (stale/mis-rendered results) until the user manually runs Settings → *Cached analyses → Clear* (`clearAllCaches()` `clearCaches.ts:40`). Not a 3.1.6 blocker (no prior schema to migrate from at first publish), but a latent update-time risk — **P6-01**.

## 6.4 Permission failure paths — **VERIFIED handled**

`handleAnalyzePage` (`service-worker.ts:279-338`) maps every denial to a specific, user-actionable reason: `no_tab`, `no_permission` (activeTab not granted → `tab.url` empty), `needs_optional_permission` (group-C site → panel calls `chrome.permissions.request`), `unsupported_url`, `needs_file_access` (`file://` without "Allow access to file URLs"). A **runtime host-permission revocation** surfaces on the next `executeScript` as a caught error → `no_permission` reason (`:333-334`) → the panel re-offers the grant. Users never see a raw Chrome error.

## 6.5 Content-script injection — **robust for full-page; manual for SPA (P6-02)**

- **Already-loaded pages:** the `__relicInjected` guard (`content/index.ts:77-78`) makes a re-inject harmless; a second injection triggers `__relicReingest()` in the *original* module scope (`:491-503`) rather than duplicating listeners.
- **Differing DOM shapes:** `ingest/detect.ts` + `classify.ts` + `dom-root.ts` (EDGAR iframe extraction) + `siteProfiles.ts` (per-site) + PDF/XBRL/readable paths, with an `isLowConfidenceGeneric` fallback banner for unrecognized layouts — so an unexpected DOM degrades to an honest "low confidence" state, not a crash.
- **SPA navigation:** the content script has **no `popstate`/`pushState`/`MutationObserver`/`webNavigation` listener** — client-side route changes on optional SPA financial sites do not auto-re-ingest; the user re-clicks "Analyze this page" (which re-injects → `__relicReingest`). SEC EDGAR (the auto-host + primary surface) serves each filing as a full-page navigation, so the primary flow is unaffected — **P6-02**.

## Phase 6 findings

**P6-01 — LOW/MEDIUM — No cache schema-migration or version-keyed invalidation.**
Evidence: all four IDB stores pinned at `DB_VERSION = 1` with create-only `onupgradeneeded` (`redlineStore.ts:19,41`, `analysisStore.ts:15,38`, `sentimentStore.ts:13,32`, `summaryStore.ts:15`); cache keys are `rawTextHash`(+tier), no app/schema version.
Impact: An update that changes a stored object's shape leaves existing users reading stale/old-shape cache until a manual clear. Not a first-publish blocker; a real update-time hazard.
Fix: Add an app/schema-version segment to the cache key (or bump `DB_VERSION` and drop the old store on upgrade) so a shape change auto-invalidates.

**P6-02 — LOW — No SPA-navigation re-ingest.**
Evidence: no history/mutation listener in `content/index.ts` (grep negative).
Impact: On optional SPA sites, a client-side route change requires re-clicking "Analyze this page"; EDGAR (full-page) is unaffected.
Fix (optional): add a debounced `popstate`/history-patch + `MutationObserver` re-ingest for SPA hosts, or document the manual re-trigger.

**P6-03 — LOW — Redline relies on SW liveness via the open message port.**
Evidence: `handleComputeRedline` holds `return true` across multi-step EDGAR fetches (`service-worker.ts:207-266`).
Impact: A pathologically slow/retrying EDGAR sequence could approach the ~5-min MV3 SW cap and orphan the response; the panel progress stalls. Low likelihood.
Fix (optional): checkpoint redline progress to storage and make it resumable, or keepalive during EDGAR back-off.

**Lifecycle verdict: resilient.** Correct top-level listener registration, disciplined async messaging with no dangling ports, IDB-backed caches with eviction, and thorough permission-denial UX. Three LOW items (P6-01/02/03); no BLOCKER or HIGH.
