# Relic — Dead-Code Inventory (reconciled)

Version 3.1.6 · commit `d383a57` · 2026-07-26. Reconciled across **knip**, **ts-prune**, **depcheck**, then cross-checked against real import sites (`.js`-extension imports, `new Worker(new URL())`, dynamic `import()`, CSS `@import`, manifest/HTML entries, vite config, tests). **Investigation only — nothing was removed.** Removal risk per item.

> **knip had no config** → it doesn't model MV3 manifest, worker URLs, HTML entries, CSS `@import`, or dynamic imports, so its ~43 "unused files" are almost all an entry-cascade false positive. Everything below survived that reconciliation.

## §A — Dead files

| File | Evidence | Removal risk |
|---|---|---|
| `src/shared/flagMeta.ts` | Zero references in `src/`+`tests/`+config; sole export `CATEGORY_META` (`:13`) also dead | **low** |
| `src/assets/settings-user-gear.svg` | Zero references; not copied by any vite plugin (only `brand-logo.png` is) → doesn't even ship | **low** |

## §B — Dead exported symbols (post-reconciliation)

| Symbol | Location | Removal risk |
|---|---|---|
| `CATEGORY_META` | `shared/flagMeta.ts:13` | low (whole file dead) |
| `clearSentimentCache` | `db/sentimentStore.ts:88` | low — never called |
| `clearSummariesForDoc` | `summarizer/summaryStore.ts:112` | low — never called |
| `lexiconMeta` | `flagging/lexiconLoader.ts:190` | low — never called |
| `getSecFetchEnabled` | `shared/secFetchPref.ts:19` | low — superseded by `useSecFetchPref` hook |
| `ProgressBar` | `sidepanel/ui.tsx:100` | low — unused component |
| `ANALYST_DISCLAIMER` | `analyst/prompts.ts:16` | low — ⚠ `DISCLAIMER` in `summarize.ts:28` is LIVE (`SummaryPanel.tsx:246`); do not confuse |
| `createSummarizer` | `runtime/capabilities.ts:196` | **medium** — part of built-in-AI capability surface; may be intended API |
| `AnalysisArtifacts` (type) | `types/index.ts:153` | low — type-only, only a comment references it |
| `MessageTarget`, `OffscreenIdleMsg`, `ContentClearMsg`, `ContentResyncFilingMsg`, `WorkerInbound`, `SentimentWorkerInbound` | `messages/types.ts:15,131,187,193,416,586` | low — type-only; protocol-contract file, may be intentional documentation |
| barrel re-exports `pickFilingRoot, buildNormalizedText, DomPositionMap, detectFilingType, extractCompanyMeta, segmentSections, classifyPage` | `content/ingest/index.ts:152-157` | low — every consumer imports from sub-modules directly; only `ingestDocument` uses the barrel |

**Over-exports (used within their own module — NOT dead, cosmetic only):** `continuationUrl` (`resolvePrior.ts:42`), `safeHost` (`classify.ts:17`), `parseEdgarUrl` (`meta.ts:20`), `wholeDocumentSection` (`readable.ts:57`), `truncateTitle`/`compactFigureFromText` (`insightTitle.ts:15,33`), `digestForSynthesis` (`pipeline.ts:260`), `SUMMARIZER_LANGUAGE` (`capabilities.ts:36`) + ~55 types ts-prune tags `(used in module)`. Demoting to non-export: risk **low**, purely cosmetic.

**Tool false positives — DO NOT REMOVE (verified cross-module use):** `ingestDocument` (29 refs), `getCachedRedline` (7), `putRedline` (4), `downloadFilingReportPdf` (3), `probePromptApiAvailability` (3), `watchWebGpuDeviceLost` (5), `normalizePageUrl` (3), `fetchPdfBase64` (3), `DISCLAIMER`, `FilingAnalysis` (27).

## §C — Unused dependencies

| Dep | Type | Evidence | Removal risk |
|---|---|---|---|
| `onnxruntime-web` (`^1.26.0`) | **runtime** | No direct `src/` import; build copies ORT from the **nested** `@huggingface/transformers/node_modules/onnxruntime-web` (verified version `1.26.0-dev.20260416`), and transformers.js resolves that nested copy for JS too. Top-level `^1.26.0` doesn't dedupe with the nested dev-snapshot | **medium** — rebuild and confirm `dist/wasm/` still populates before removing |
| `vite-plugin-static-copy` | devDep | Not imported; only a stale comment in `vite.config.ts:32` (custom `copyWasmPlugin` replaced it). Flagged by knip + depcheck | low |
| `autoprefixer` | devDep | No `postcss.config.*`/`tailwind.config.*`; Tailwind v4 via `@tailwindcss/vite` needs neither | low–medium — verify no implicit PostCSS |
| `postcss` | devDep | Same as above | low–medium |

**Dependency false positives (used, invisible to tools):** `react`/`react-dom`/`framer-motion`/`pdfjs-dist` (imported); `tailwindcss` (CSS `@import "tailwindcss"`); `@types/*` incl. `@types/dom-chromium-ai` (ambient globals `LanguageModel`/`Summarizer` in `capabilities.ts:104-164`); `@vitest/coverage-v8` (CLI `test:coverage`). depcheck flags `@types/node` as *missing* (referenced by `tsconfig.json types:["node"]`, satisfied transitively) — optional hygiene add.

## §D — Stray / unreferenced assets

| Asset | Ships? | Removal risk |
|---|---|---|
| `public/.DS_Store` (6148 B) | **yes** → `dist/.DS_Store` (publicDir copy, byte-identical) | low — `rm` + exclude at zip time |
| `public/icons/icon-source.png` (1024²) | **yes** → `dist/icons/` | low — build input for `generate-icons.mjs:12`; move out of `public/` |
| `brand-logo.png` in `public/` **and** `src/assets/` | yes (one dist copy) | **medium** — confirm identical, drop one source |
| `src/assets/settings-user-gear.svg` | no | low |

## §E — Storage keys (all written-and-read; no orphans)

**`chrome.storage.local`:** `relic:onboarded` (w `App.tsx:518` / r `:511`), `relic:hasAnalyzed` (w `:630,673` / r `:163,173`), `relic:infoOpen` (w `:181` / r `:163,165`), `relic:devForceMode` (w `SummaryPanel.tsx:501` / r `:330`), `relic:secFetch` (w `secFetchPref.ts:69` / r `:21,60`), `relic:flagsEnabled` (w `overlayPrefs.ts:130` / r `:107`), `relic:flagTypes` (w `:138` / r `:107,111`), `relic:showBoilerplate` (w `:146` / r `:107,112`).

**`chrome.storage.session`:** `filing:current` (w `filingSession.ts:36` / r `:46`,`service-worker.ts:488`), `filing:model:${hash}` (w `:35` / r `:52,57`), `filing:flags:${hash}` (w `:38`,`service-worker.ts:492` / r `:53,58`), `relic:preferWasm` (w `inferencePref.ts:43` / r `:32`). Access level set once at `service-worker.ts:98`.

## §F — Duplicate-implementation pairs (both LIVE — do NOT remove)

| Pair | Resolution | Risk if touched |
|---|---|---|
| `content/segment.ts` (flat impl) ↔ `content/ingest/segment.ts` (wrapper) | wrapper imported by `ingest/index.ts:22`,`ingest/pdf.ts:31`; delegates to flat; flat also serves `assessSegmentationConfidence` | **high** — central to ingest |
| `content/positionMap.ts` (flat) ↔ `content/ingest/position-map.ts` | chained: flat → `ingest/position-map.ts:6` → `ingest/index.ts:19` + tests | **high** |
| `offscreen/sentenceFilter.ts` (shim) ↔ `lib/sentenceFilter.ts` (impl) | shim re-exports lib; `offscreen.ts:55` imports the shim | **medium** — repoint import, then delete shim |

## Removal-priority summary

- **Safe, do-anytime (low):** `shared/flagMeta.ts`, the low-risk dead exports (§B), `public/.DS_Store`, `settings-user-gear.svg`, unused devDeps.
- **Verify-then-remove (medium):** top-level `onnxruntime-web` dep (rebuild check), `sentenceFilter.ts` shim (repoint import), redundant `brand-logo.png` source, `createSummarizer` export (API decision), `autoprefixer`/`postcss`.
- **Do not touch (high):** the segment/positionMap duplicate pairs — both are load-bearing in the ingest pipeline despite looking redundant.
