# Relic — Session Prompts (B–F)

Copy-paste one prompt per session. Each is self-contained. Companion to [relic-review.md](relic-review.md) (v1.2.7, commit `086d03f`).

**Shared context to paste at the top of every session:**

> You are working in /Users/raaghav/Developer/Relic — "Relic," a privacy-first MV3 Chrome extension (TypeScript, React 19, Tailwind 4, Vite) that analyzes SEC/EDGAR filings 100% on-device. Hard invariants you must not break: (1) zero network egress except user-initiated GETs to `*.sec.gov` — the CSP `connect-src` in manifest.json enforces this and `scripts/verify-dist.mjs` fails the build if it changes; (2) all models are bundled at build time, no runtime downloads, no remote fonts or scripts; (3) no telemetry. Verification for every change: `npm run typecheck`, `npm test` (388 tests must stay green), `npm run build` (runs verify-dist), and for UI work `npm run dev:ui` (mock-data preview of the side panel; settings preview at src/dev/settings-preview.html). Work on a branch, commit when done.

---

## Session B — Pre-launch polish PR (ship as v1.2.8)

**Goal:** one focused UI/copy PR that fixes the trust-undermining polish issues found in pre-launch review. Six tasks, in this order:

**1. Typography consolidation — the big one.**
The side panel currently mixes Roboto, Georgia, Times New Roman, Times, and system-ui via dozens of inline Tailwind `font-[...]` overrides (e.g. company name in Georgia with its ticker in Times New Roman at src/sidepanel/App.tsx:210–212; the primary CTA in `font-[Times,serif]` at App.tsx:306; FirstRun.tsx alternates per block). Replace all of it with a two-face system:
- **Display headings: Times New Roman. Body/everything else: Roboto.**
- Define once in src/sidepanel/index.css using Tailwind 4 `@theme` tokens:
  `--font-display: 'Times New Roman', Times, serif;`
  `--font-sans: 'Roboto', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;`
  (Keep the fallback stack — Roboto is not preinstalled on macOS/Windows. Do NOT load it from Google Fonts; that would violate the zero-egress invariant. Bundling a woff2 is optional and out of scope.)
- Apply `font-sans` at the app root so Roboto is the default; use `font-display` ONLY for: the "Relic" brand title (App.tsx:196), the FirstRun h1 + tagline (FirstRun.tsx:44–47), and top-level section headings.
- Then delete **every** inline `font-[...]` class in src/sidepanel/*.tsx (`grep -rn "font-\[" src/sidepanel src/settings` must return zero when you're done).
- Settings page: SettingsApp.tsx uses a `SERIF` constant (Iowan Old Style stack) via inline `fontFamily` styles — switch it to the same Times New Roman stack for the header/section titles and let body text be Roboto for consistency across surfaces.
- Retire the neon `#39FF14` version accent (src/sidepanel/ui.tsx:185 `VERSION_ACCENT`, src/settings/SettingsApp.tsx:256) — use the settings emerald `#34d399` or a zinc gray.

**2. Fix the factually wrong Settings copy.**
src/settings/SettingsApp.tsx:339 says generation mode is "Chosen automatically from the page you're viewing" — it's actually chosen from device capability (src/runtime/capabilities.ts:133). New copy: "Chosen automatically from your device's capabilities — Built-in AI (Gemini Nano) when Chrome supports it on this hardware, otherwise Relic's extractive mode." Also check the `GenerationStatus` control in the same file: the extractive state must read as healthy ("Extractive · Ready"), not gray-implies-broken.

**3. Gate debug logging.**
23 `console.debug` call sites ship to production (service worker, offscreen, workers, content — `grep -rn "console.debug" src`). Create `src/lib/debug.ts` exporting a `debugLog(...)` that no-ops unless `import.meta.env.DEV`, and replace every `console.debug` with it. Leave `console.warn`/`console.error` alone.

**4. Collapse the "Where Relic works" card after first success.**
`WhereItWorks` (App.tsx:135) renders above the tabs on every view (App.tsx:592), pushing analysis below the fold forever. Persist a `relic:hasAnalyzed` flag in `chrome.storage.local` the first time a filing loads successfully; once set, render the card collapsed to a single expandable line (keep the aria-label and keyboard access).

**5. Small copy bonus:** in the SettingsApp FAQ, the answer about generation mode taking "a little longer the first time" should say concretely that Chrome downloads and manages Gemini Nano (~2 GB) — this preempts "is this really offline?" reviews.

**Finish:** bump version to 1.2.8 in manifest.json + package.json. Verify: typecheck, tests, build, and take dev:ui screenshots of the panel (filing + empty state), first-run, and settings to confirm the type system reads coherently.

---

## Session C — Reliability & resource hygiene

**Goal:** close the known resource-exhaustion and cleanup gaps. Three tasks:

**1. Session-storage eviction.**
`persistFilingToSession` (src/shared/filingSession.ts:14–24) writes the entire DocumentModel under `filing:model:<hash>` (plus `filing:flags:<hash>`) and never deletes prior hashes. `chrome.storage.session` has a 10 MB quota — a few large 10-Ks in one browser session can exhaust it, and the retry path fails identically. Fix: before the `set`, enumerate keys with `chrome.storage.session.get(null)` and `remove` every `filing:model:*` / `filing:flags:*` key whose hash differs from `model.rawTextHash`. Keep `filing:current` semantics unchanged. Add a unit test (see tests/setup.ts and existing chrome-mock patterns, e.g. tests/inject.test.ts): persist filing A, then filing B → A's keys are gone, B's model+flags load, `filing:current` points to B.

**2. Redline cancellation.**
`fetchEdgarText` already accepts an `AbortSignal` (src/background/edgarQueue.ts:71, 110) but `handleComputeRedline` (src/background/service-worker.ts:160–211) never wires one, so closing the panel mid-redline leaves the resolve+fetch chain running. Add a `CANCEL_REDLINE` message to src/messages/types.ts; in the service worker keep one AbortController for the in-flight redline (starting a new redline aborts the previous), pass its signal into both `fetchEdgarText` call sites and through the `fetchText` closure given to `resolvePriorFiling`; on abort return a quiet `{ ok: false, error: 'cancelled' }`. In the side panel (src/sidepanel/RedlinePanel.tsx), send CANCEL_REDLINE when the component unmounts or the user navigates away mid-progress. Test the abort path with the injectable `fetchImpl` seam.

**3. Eager FinBERT unload.**
The offscreen document keeps both models resident until the 5-minute idle unload (src/offscreen/offscreen.ts:115–143), which on WASM devices can hold ~1 GB peak. Since sentiment results are cached by content hash upstream, terminate the FinBERT sentiment worker (mirror the idle-teardown logic) as soon as an ANALYZE_SENTIMENT request completes and there is no queued work — keep the encoder worker alive (it serves summaries/redline), and make sure a subsequent sentiment request cleanly re-initializes (init params are retained at offscreen.ts:335). Guard against tearing down while a batch is in flight.

**Note / correction from review:** do NOT delete src/content/segment.ts or src/content/positionMap.ts — an earlier review draft called them duplicates, but they are the live implementations; src/content/ingest/segment.ts and ingest/position-map.ts are thin wrappers that delegate to them. Optionally add a one-line header comment to each pair documenting the layering.

**Finish:** full suite green, build passes, and a manual check (load unpacked from dist/, open a 10-K, start a redline, close the panel mid-run, confirm via SW console that fetches abort).

---

## Session D — WASM performance + visible privacy

**Goal:** make sentiment on no-WebGPU machines go from minutes to tens of seconds, and surface the on-device promise during analysis. Current bottleneck: FinBERT runs `CLASSIFY_BATCH = 8`, `CLASSIFY_CONCURRENCY = 1`, `numThreads: 1` (src/offscreen/offscreen.ts:75–77, 214) — hundreds of sequential single-threaded int8 BERT batches on a 3–5k-sentence 10-K.

**1. Multi-threaded ORT via cross-origin isolation.**
Add to manifest.json: `"cross_origin_embedder_policy": { "value": "require-corp" }` and `"cross_origin_opener_policy": { "value": "same-origin" }`. These apply to all extension pages including the offscreen document; the threaded ORT builds are already bundled (dist/wasm/ort-wasm-simd-threaded*). In offscreen.ts, check `self.crossOriginIsolated` and set `numThreads = crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 1) : 1` at both worker inits (offscreen.ts:214 and :335). **Regression-check every surface after adding COOP/COEP** — side panel, settings page, first-run, PDF export, and the Prompt/Summarizer API calls in the panel — since COEP applies extension-wide. All resources are same-origin (`'self'`) so nothing should break, but verify; if anything does, isolate and report rather than shipping.

**2. Section prioritization.**
Reorder the sentiment run so MD&A and Risk Factors sections are scored first (reuse the section-id prefixes idea from `PRIORITY_SECTION_PREFIXES` in src/analyst/relevance.ts:26–30). Progressive per-section result streaming already exists — SentimentPanel listens for section results and progress (src/sidepanel/SentimentPanel.tsx:162–191) — so the sections users actually read appear within seconds while boilerplate finishes in the background.

**3. ETA in the progress UI.**
In the `classifyAll` batch loop (offscreen.ts:353–384), track a rolling average batch latency and include a remaining-time estimate in the SENTIMENT_PROGRESS `detail` field ("about 40s left"); SentimentPanel already renders `progress.detail`.

**4. "On-device" chip.**
Add a small chip to the side-panel header (App.tsx Header) shown while any analysis is running: lock icon + "On-device", tooltip "This analysis never leaves your machine." Subtle emerald, Roboto, no animation beyond fade (respect reduced-motion). This surfaces the differentiator at the exact moment a cloud competitor would be uploading.

**Finish:** benchmark before/after on a large 10-K with WebGPU disabled (launch Chrome with `--disable-features=WebGPU`, or temporarily force the WASM path): record total sentiment wall-time and peak offscreen memory in the PR description. Target: under ~30 s on a modern 4-core laptop. Then re-verify the WebGPU path still works (tests/ortAssets.build.test.ts and the suite must stay green; `npm run build` must pass verify-dist).

---

## Session E — Output quality v2

**Goal:** make the extractive tier stop reading as templated, and make the LM tier stop missing headline facts. Best done after some launch feedback. Four tasks, independent — land them as separate commits:

**1. Deterministic-tier copy variety (src/analyst/deterministic.ts).**
Today, takeaway titles fall back to the section label and every card's "Investor view" is one canned template — "On-device sentiment reads the … language as net-positive/negative" (deterministic.ts:269). Since XBRL fundamentals now exist on the DocumentModel (`doc.xbrl`, built by src/content/ingest/xbrl.ts): title takeaway cards by their lead exact fact when available ("Revenue +12% YoY to $94.9B") or a key numeric phrase from the section, falling back to the section label; vary the investorMeaning template by signal type (sentiment skew vs. flag density vs. XBRL delta vs. redline magnitude); and suppress the "Investor view" line entirely when it would repeat another card's. Use `npm run dev:ui` (src/dev/mock-data.ts) to compare before/after; no two visible cards should share identical template copy.

**2. Semantic excerpt selection for the LM stages.**
Each Gemini Nano stage sees only ~2.8–3.6k chars (src/analyst/pipeline.ts:113–115) chosen by keyword scoring in src/analyst/relevance.ts — so unusual phrasing makes the revenue stage miss the actual revenue discussion. Add embedding reranking using infrastructure that already exists: the encoder worker speaks an EMBED/EMBED_RESULT protocol (src/messages/types.ts:322/348, offscreen.ts:230), and the sidepanel→service-worker→offscreen forwarding pattern is established (`forwardToOffscreen` in service-worker.ts). Add an offscreen-level message (e.g. `EMBED_TEXTS`) routed the same way; embed a static query string per dimension (cache the vectors) plus the candidate sentences (embed once, reuse across all dimensions; cap candidates); blend cosine similarity with the existing keyword score (~50/50 to start). **The keyword-only path must remain as fallback** whenever the offscreen/encoder is unavailable — the pipeline's render-on-frame-one guarantee cannot regress. Add tests using an injectable similarity seam (same pattern as the redline tests).

**3. Honest scores.**
The 1–5 `AnalysisScores` come from Gemini Nano rating its own digest, with unparseable values silently becoming 3 — pseudo-precision that invites a credibility attack. Minimum scope: relabel the scores block in src/sidepanel/AnalystPanel.tsx as "Model impression" with a tooltip explaining they're the on-device model's qualitative read, not computed metrics. Stretch scope (only if time allows): derive a parallel deterministic composite from flag density, sentiment aggregate, redline magnitude, and XBRL deltas, and show that instead.

**4. Sentiment normalization for Risk Factors.**
FinBERT systematically reads dense legal/forward-looking hedging as negative, so Risk Factors paints red for every company — noise, not signal. At the aggregation/display layer only (keep raw cached scores untouched for cache compatibility): damp scores inside boilerplate-flagged ranges (boilerplate detection already exists in src/flagging/flagLanguage.ts) and/or normalize section aggregates against a section-type baseline so a risk section reads relative to "typical Risk Factors language." Update SentimentPanel copy to say what the number means. Unit-test the transform (see tests/calibrateSentiment.test.ts for the existing calibration test pattern).

---

## Session F — Coverage & launch distribution

**Goal:** finish the long tail and actually launch. Three workstreams:

**1. Verify or trim the optional-site profiles.**
Every content/consent/paywall selector in src/content/ingest/siteProfiles.ts is marked "UNVERIFIED — best guess" (lines 28–100, 201). For each host in manifest.json `optional_host_permissions` (annualreports.com, stockanalysis.com, fool.com, benzinga.com, sec.report, finviz.com, finance.yahoo.com, macrotrends.net, bamsec.com, cnbc.com, reuters.com): open a representative page, capture the live DOM, fix the selectors, and delete the UNVERIFIED caveats — or, for any host you can't verify, remove it from the manifest, siteProfiles, and settings copy. A granted-then-broken site is worse than an absent one. Update SITES.md and tests/siteProfiles.test.ts to match. Also change the remaining `*://` optional matches (yahoo, macrotrends, bamsec, cnbc, reuters) to `https://` only.

**2. Financial-sector XBRL concepts.**
The curated concept map (src/content/ingest/xbrl.ts:36–57) covers standard commercial companies; banks/insurers/REITs will show sparse Fundamentals tables. Add rows for financial-sector revenue/income concepts (e.g. `us-gaap:RevenuesNetOfInterestExpense`, `us-gaap:InterestAndDividendIncomeOperating`, insurer premium concepts) following the existing most-preferred-first pattern, and extend tests/xbrl.test.ts. Drive the exact list from real filings you test against (one large bank, one insurer, one REIT).

**3. Launch kit (mostly writing, no extension code).**
- **Show HN draft** leading with the engineering: "CSP-enforced zero egress, build-time verification, and verify-or-drop evidence guards — an SEC filing analyzer that provably can't phone home." Link the CSP line and verify-dist.mjs in the post; HN will check.
- **Demo GIF script** (30–60 s): open a 10-K on EDGAR → Analyst tab with Fundamentals table → click a quote to jump-to-source → one-click Redline showing a YoY risk-factor change. The redline is the shot that has no free substitute.
- **README / landing copy** rebuilt on the research-trail argument: "The filing is public. What you're researching isn't." Name the audiences (compliance-restricted analysts, auditors/IR/securities lawyers doing YoY comparison, filing-reading investors).
- **Store listing refresh:** retake the five screenshots after Session B's typography change; confirm the promo tile and description (draft in relic-review.md §1.3) are live.
