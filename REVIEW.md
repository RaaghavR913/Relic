# FilingLens — Independent Pre-Release Review

**Reviewer:** automated independent verification pass (read-only).
**Date:** 2026-06-09
**Scope:** Phase-1 launch (7 items) + Phase-2 follow-ups (7 items), against `PREAMBLE.md` invariants.

---

## 1. Verdict

# SHIP AFTER FIXES

The three core invariants (zero-egress, positionMap-only coordinates, no-span-injection) are **verified intact**. Tests pass (194/197, 3 legitimately skipped) and the prod build is clean. No ship-stopping defect was found. However, several real issues should be resolved before Chrome Web Store submission — most importantly the **manifest permission scope** (two non-SEC domains), a **20-F feature that is a silent no-op**, an **overstated "Full Loughran-McDonald" claim**, and a **114 MB package** dominated by four redundant-looking WASM variants.

> **Methodology caveat (important):** the repository has **no git commits** (`git log` → "does not have any commits yet"; everything is staged in the initial add). Every check in this review that the prompt asked me to satisfy "by diffing against git history" — *dev-build symmetry (item 3), 10-K/10-Q registry untouched (item 10), deleted/weakened tests (Part 3)* — could **not** be verified historically. I verified those structurally instead and flag them as manual-confirm items in §6.

---

## 2. Findings table (severity-ordered)

| ID | Sev | Location | Description |
|----|-----|----------|-------------|
| H1 | HIGH | `manifest.json:16-20,26-35,53-61` | `host_permissions`, `content_scripts`, and `web_accessible_resources` all grant `*.fool.com` + `*.seekingalpha.com` — broader than the sec.gov-only story. Not an egress breach (DOM-read only) but a CWS-review/trust-scope risk. |
| H2 | HIGH | `dist/wasm/*` | Package is **114 MB zipped / 209 MB unpacked**; 73 MB is **four** ORT WASM variants. Item 5's "exactly one .wasm / dedupe" acceptance is literally unmet and the size invites CWS friction. |
| M1 | MED | `src/redline/align.ts:27-48` vs `src/content/segment.ts:76-135` | **20-F gets zero Changes-tab coverage.** The 20-F segmenter emits `20f_*` IDs; none are in `DEFAULT_FOCUS_IDS` or `ALIAS_GROUPS`, so `computeRedline` returns `status:'computed'` with **empty diffs** → silent no-op for foreign issuers. (2.3 × 2.4 seam.) |
| M2 | MED | `src/flagging/lexicons/lm_*.json`, `src/flagging/lexiconLoader.ts:6-7` | "**Full** Loughran-McDonald Master Dictionary" is **566 words** (neg 275 / unc 126 / lit 139 / wm 26) ≈ ~15% of the real ~3,600-word 2018 LM set. The "Full"/"Master Dictionary" labels in code + JSON `source` overstate coverage. |
| M3 | MED | `src/sidepanel/AskPanel.tsx:109-182` | Pooled Q&A session concurrency is serialized only by `AbortController`, not a lock. Rapid/overlapping asks could interleave on the one shared session. Needs runtime confirmation (2.1×2.5 / intra-Q&A). |
| L1 | LOW | `src/offscreen/offscreen.ts:14-15,73-77` | Comments claim weights are fetched "from Hugging Face / the Hub." Contradicts zero-egress; actual workers set `allowRemoteModels=false`. Misleading to an auditor. |
| L2 | LOW | `dist/src/sidepanel/index.js` | Prod bundle retains dead `devForceMode` storage-key string + `forceMode` identifiers (6 hits). Functionally inert (`effectiveTier = detectedTier` in prod; `DevSettings` component stripped) but fails item 3's literal "zero hits." |
| L3 | LOW | `package.json:3` vs `manifest.json:4` | Version mismatch: `0.1.0` vs `0.2.0`. |
| L4 | LOW | `src/background/resolvePrior.ts:161-162` | When `filings.recent` is entirely absent it returns `null` **without** trying the `filings.files` continuation; pagination only fires on present-but-no-match. Edge case. |
| L5 | LOW | `src/sidepanel/AskPanel.tsx:86-94` | The reset effect has no cleanup return → pooled QA session not explicitly `destroy()`ed on side-panel unmount (Chrome reclaims on context teardown, so benign). |
| L6 | LOW | `src/content/highlight/flagOverlay.ts:145-165,223` | Flag tooltip injects one `<div>` into the filing DOM and writes `innerHTML` (escaped, bundled-only content). Not highlight-span injection, but it does mutate the filing DOM. |

No BLOCKER-severity findings.

---

## 3. Per-item PASS/FAIL ledger

### Phase 1

**1. CSP (`wasm-unsafe-eval`) — PASS.**
`manifest.json:14` → `script-src 'self' 'wasm-unsafe-eval'; object-src 'self'; connect-src 'self' https://*.sec.gov`. MV3-valid; `connect-src` is correctly restricted to sec.gov (defense-in-depth against egress).

**2. `scripting` permission removed — PASS.**
`grep "chrome.scripting"` and `"scripting"` over `src/` + `manifest.json` → **0 hits**. Not in `permissions`.

**3. DevSettings stripped — PASS (with L2 note).**
`grep DevSettings dist/` → **0 hits**. The gate `import.meta.env.DEV && <DevSettings/>` (`SummaryPanel.tsx:521`) and `effectiveTier = (import.meta.env.DEV ? forceMode : null) ?? detectedTier` (`:253`) collapse correctly in prod — the bundle literally reads `effectiveTier = detectedTier`. Residual dead `devForceMode`/`forceMode` strings remain (L2); functionally inert. Dev-build symmetry not run (no git history; gate is structurally symmetric).

**4. `web_accessible_resources.matches` — PASS (but see H1).**
`matches` exactly equals `content_scripts[].matches` (both = the three domains). **No `<all_urls>` anywhere** (grep clean). Caveat: the shared match set itself includes the two non-SEC domains (H1).

**5. diff.js gone + WASM deduped — PARTIAL / see H2.**
`find dist -name "*diff*"` → none (diff.js gone ✓). `find dist -name "*.wasm"` → **4 files**, all in `dist/wasm/` (no cross-directory duplicate copy — the dedupe across dirs worked), but four distinct ORT variants remain: `ort-wasm-simd-threaded.wasm` (12M), `.jsep.wasm` (25M), `.jspi.wasm` (14M), `.asyncify.wasm` (22M). Runtime path resolution is correct: workers set `env.backends.onnx.wasm.wasmPaths = chrome.runtime.getURL('wasm/')` (`encoder.worker.ts:47`) and ORT selects the variant — the surviving copies are loadable. **Zip: 114 MB.** The literal "exactly one wasm" criterion is unmet.

**6. `resolvePrior` pagination — PASS.**
- Empty-`recent`/no-match → continuation: `resolvePrior.ts:172-186` fires `filings.files[0]` only when `!prior`.
- Continuation fetch rides the queue: via injected `deps.fetchText` = `fetchEdgarText(url,{queue})` (`service-worker.ts:126`). Not a bare fetch.
- 30-min cache: `fetchEdgarText` cache applies (`edgarQueue.ts:96-100`).
- Tests: `resolvePrior.test.ts` covers continuation hit (l.149), no-redundant-continuation (l.166), and **both-empty → null** (l.177).
- Fail-loud: null prior → visible `no_prior` status + "No prior comparable filing found." (`service-worker.ts:137-139`); EDGAR errors → `{ok:false,error}`. Not silent.
- Caveat L4 (recent entirely absent skips continuation).

**7. `sentenceIdx` fix — PASS.**
`offscreen.ts:506-510` `filterNonTableSentences` returns survivors carrying `origIdx`; `:531,548` push `sentenceIdx: origIdx` — index maps into the **original** `sentences` array. Doc-space range = `section.charRange[0] + sent.range` (`:535-538`), correct section→document lift. Table-containing sections cannot drift the index. Regression covered by `sentenceFilter.test.ts` (3 tests) + `sentiment.test.ts`.

### Phase 2

**8. Auto-summarize (2.1) — PASS.**
`PRIORITY_IDS` (`SummaryPanel.tsx:18`) → auto-trigger effect on `[doc.rawTextHash,…]` (`:364`), which fires on FILING_READY (App sets doc → hash changes). Double-fire guard: `autoTriggeredForRef === hash` (once per filing) + per-section `acRefs.current[id] !== undefined` skip (`:379`) + `summarize()` aborts in-flight (`:314`). Both tiers via `effectiveTier`. IDB consulted before recompute (`:381` and inside `summarizeSection :119`). Non-blocking: fire-and-forget `void (async…)`, per-section state updates (streaming, not await-all).

**9. Lexicon (2.2) — PASS w/ M2.**
Base = **118** confirmed (30+30+30+28). LM lazy-loaded via bundled dynamic `import('./lexicons/lm_*.json')` (`lexiconLoader.ts:119-124`) — no runtime fetch. Categories preserved as `negative/uncertainty/litigious/weak_modal`, consistent across `lexiconLoader`, `flagOverlay.ts:25-30`, `demo.ts`. No per-section re-parse (module-level `_cache`, merge-once). **But** total LM = 566 words, not "Full" (M2). Bundle delta is negligible (~tens of KB) — it did **not** eat the size win.

**10. 20-F registry (2.3) — PASS (segmentation only).**
`ITEMS_20F` (`segment.ts:76-135`) covers Part I (1–12, dot-letter subitems), Part II (13–16K), Part III (17–19); dispatched via `case '20-F': segmentByItems(text, ITEMS_20F,…)` (`:250`), mirroring the 10-K pattern. 10-K/10-Q registries are separate const objects, structurally untouched (history diff not possible — no commits). **See M1: segmentation works but redline focus does not.**

**11. `DEFAULT_FOCUS_IDS` (2.4) — FAIL for 20-F; PASS for others.**
Traced each focus ID to a segmenter emitter:
- 10-K `item_1a_risk_factors`/`item_7_mdna` ✓, 10-Q `part_ii_item_1a_risk_factors`/`item_2_mdna` ✓
- S-1 `s1_risk_factors`/`s1_mdna`/`s1_business` ✓ (`:171,178,179`)
- DEF 14A `proxy_exec_compensation`/`proxy_cd_a`/`proxy_governance` ✓ (`:202,203,200`)
- 8-K `item_2_02_results_of_operations`/`item_5_02_officer_changes`/`item_1_01_material_agreements`/`item_8_01_other` ✓ (`:145,156,139,164`)
- **20-F: no focus ID exists** for `20f_item_3d_risk_factors`/`20f_item_5_operating_review` → M1 silent no-op.

**12. Session pooling (2.5) — PASS (disposal hardest-scrutinized).**
Pooled session = `qaSessionRef` in `AskPanel.tsx`. Disposal paths:
- New filing load: reset effect on `[doc.rawTextHash]` → `destroy()` + null (`:86-94`). ✅
- Error (incl. context-window full): `destroy()` + null in `catch` (`:176-177`). ✅
- Navigation/tab/side-panel close: relies on context teardown (L5 — no explicit unmount destroy).
Context bleed: session is created with **only** the generic `QA_SYSTEM_PROMPT` (`synthesize.ts:55,68-74`) — **no filing-specific context baked in**; passages are passed per-prompt. Filing B always gets a fresh session (hash-change disposal), so **no path reuses filing A's session for filing B**. Extractive path untouched (`templatedQaAnswer`, no model). Concurrency caveat = M3.

**13. Extractive Q&A synthesis (2.6) — PASS.**
`templatedQaAnswer` (`synthesize.ts:130-149`) — pure template, no model call, no randomness; explicitly "mirrors the templatedChangeSummary pattern." Emits `[n]` markers → `AnswerText` renders them as `highlightInFiling(passage.charRange)` buttons → positionMap → Custom Highlight `qa` layer. Builtin streaming path unchanged.

**14. Multi-chunk summarizer (2.7) — PASS.**
Under-cap (≤ `MAX_SUMMARIZER_CHARS` 8000) → single-shot `summarizer.summarize` (`summarize.ts:181`), no added overhead. Over-cap → `summarizeInChunks` (`:241`) using `splitTextForSummarization` — a **thin new function in the same chunker module** sharing `findSplitPoint`/`SPLIT_BOUNDARIES` with the embedding chunker (not a duplicate chunker). Merge step is a **real condense pass** (`:260-265`, "synthesize into one concise…"), not concatenation. Sentence-boundary aware. Builtin anchors are whole-section `[0,text.length]`, so chunk splits **cannot** drift citation offsets.

---

## 4. Invariant attestation

**Invariant 1 — Zero unexpected egress: VERIFIED INTACT.**
- Only real network call site: `edgarQueue.ts:108` `fetchImpl(url,…)`, always inside `queue.schedule(...)`. All callers pass sec.gov URLs (see §5).
- LM dictionary loads via bundled dynamic `import()` (`lexiconLoader.ts:119-124`) — **not** a runtime fetch.
- ML weights load locally: both workers set `env.allowRemoteModels = false; env.allowLocalModels = true; env.localModelPath = chrome.runtime.getURL('models/')` (`encoder.worker.ts:53-55`, `sentiment.worker.ts:57-59`). No Hub fetch despite misleading comments (L1).
- CSP `connect-src 'self' https://*.sec.gov` blocks any other origin from extension contexts.
- Content scripts on fool.com/seekingalpha read DOM only (`transcript.ts`) — no `fetch`/`sendBeacon`/`WebSocket` (grep clean). *Scope* is wider than sec.gov (H1) but no data leaves the device.

**Invariant 2 — positionMap is the only path to DOM coordinates: VERIFIED INTACT.**
All offset→DOM and point→offset conversions go through `positionMap.toDomRange` / `.fromPoint` / `.toClientRects`. The only `getBoundingClientRect` outside positionMap (`content/index.ts:178,208`) operate on **positionMap-derived** ranges purely for scroll-visibility — not offset math. Section-space↔document-space boundary preserved: sentiment (`offscreen.ts:535`), chunker (`toDocRange`, `chunker.ts:93`), summary anchors documented section-space + UI offset add (`summarize.ts:30-34`). No mixed-space pass detected in 2.3/2.7.

**Invariant 3 — No span injection: VERIFIED INTACT.**
Grep for `createElement('span'`, `insertAdjacentHTML`, `innerHTML`, `surroundContents` over filing-touching code → only hit is the flag tooltip `<div>` (L6, auxiliary UI, not highlighting). All highlighting uses `HighlightController.setRanges/addRanges` → CSS Custom Highlight API. **15 named layers confirmed** (demo, sentiment, 7 sentiment sub-layers, 4 flag, redline, qa) with priority stacking `demo 0 < sentiment 1 < flags 2 < redline 3 < qa 4` intact (`demo.ts:78-94`) — no layer removed or reordered.

---

## 5. Complete network-call-site inventory (1A)

| # | Site | Destination | Through queue? | Disposition |
|---|------|-------------|----------------|-------------|
| 1 | `edgarQueue.ts:108` `fetchImpl(url,…)` | caller-supplied | **Yes** (`queue.schedule`) | The single real network primitive. |
| 2 | `resolvePrior.ts:153` `deps.fetchText(submissionsUrl)` | `data.sec.gov/submissions/CIK*.json` | Yes (closure→#1) | OK |
| 3 | `resolvePrior.ts:177` `deps.fetchText(continuationUrl)` | `data.sec.gov/submissions/*` | Yes | OK |
| 4 | `service-worker.ts:132` `resolvePriorFiling(…,{fetchText})` | data.sec.gov | Yes | OK |
| 5 | `service-worker.ts:146` `fetchEdgarText(prior.url,{queue})` | `www.sec.gov/Archives/…` | Yes | OK |
| 6 | `lexiconLoader.ts:119-124` `import('./lexicons/lm_*.json')` | bundled asset | n/a | **Not network** (dynamic import of packaged JSON) |
| 7 | `encoder.worker.ts:69` / `sentiment.worker.ts` `pipeline(...)` | `localModelPath` (extension) | n/a | **Not network** — `allowRemoteModels=false` |

No `XMLHttpRequest`, `navigator.sendBeacon`, `WebSocket`, `EventSource`, or `importScripts` anywhere in `src/`. No dynamic `import()` of a remote URL.

---

## 6. Open risks — must be covered by a manual browser pass

These could not be verified statically:

1. **WebGPU-off behavior** — both workers `try webgpu → catch → wasm` (`encoder.worker.ts:67-86`). Confirm a real GPU-less machine falls back cleanly and the 14 MB `jspi`/22 MB `asyncify` variants are actually exercised (or can be trimmed → addresses H2).
2. **Nano-off behavior mid-session** — kill/disable Gemini Nano between asks. Confirm the pooled-session error path (`AskPanel.tsx:176`) re-creates cleanly and the UI shows the warn banner, not a stuck spinner. Also confirm summary "analyst note" gracefully falls back to plain (`summarize.ts:213`).
3. **M3 — concurrent Q&A on the pooled session.** Fire two asks back-to-back (and an auto-summary mid-ask). Confirm no garbled/interleaved answer; serialization currently relies on `AbortController`, not a mutex.
4. **M1 — open a real 20-F**, click Changes. Confirm whether the user sees a misleading empty/"no changes" result vs. an explicit "unsupported for this form." (Currently the former.)
5. **Visual highlight placement** — confirm the 15 layers paint at correct offsets on a real filing (especially across inline XBRL tags / table regions), since positionMap coordinate correctness is only unit-tested in jsdom.
6. **History-dependent items** (no git commits exist): dev-build still contains DevSettings (item 3 reverse gate); 10-K/10-Q registries unchanged by 2.3 (item 10); no test was deleted/weakened in Phase 2 (Part 3). Confirm against the source branches if they exist elsewhere.

---

## 7. Cross-cutting sweep results

- **Tests:** `vitest run` → **194 passed, 3 skipped, 13 files**. The 3 skips are `describe.skip('FinBERT integration … run manually')` (`sentiment.test.ts:319`) — legitimately gated on a real model, not weakened.
- **Build:** `npm run build` → exit 0, clean.
- **2.1×2.7:** double-fire guard is per-`summarize()`-call; chunking is internal to one call → guard holds across chunk boundaries. ✅
- **2.1×2.5:** auto-summary uses per-call Summarizer/LM sessions (`summarize.ts:171,199`, destroyed in `finally`), **separate** from the pooled QA session → no shared-session contention. ✅
- **2.2×1.5:** lexicon adds ~566 words (~KB); the 73 MB WASM + 131 MB models dominate the 114 MB zip. Dictionary did **not** eat the size win. ✅
- **2.3×2.4:** **fails** — see M1.
- **Error paths (1.6/2.1/2.5/2.7):** EDGAR errors surface as `{ok:false,error}` → RedlinePanel banner; no-prior → visible `no_prior`; summary/ask errors set `status:'error'` with banners. No new silent failures found **except** M1 (20-F empty diff reads as "no changes").
- **Manifest CWS pass:** valid MV3. Concerns: H1 (non-SEC hosts), `tabs` permission is broad (`activeTab` may suffice for most flows — worth review), L3 version mismatch.
