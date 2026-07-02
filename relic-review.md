# Relic — Pre-Launch Review

*Reviewed at v1.2.7 (2026-07-01), commit `086d03f`. All 388 unit tests pass (31 files, 7 skipped). This supersedes the earlier same-day review: the manifest hardening, XBRL fundamentals, and lexicon replacement it recommended have since landed and are re-verified below. Line references are to the current working tree.*

---

## 1. Chrome Web Store Launch Readiness

### 1.1 Manifest audit (manifest.json) — now in strong shape

- **MV3 compliant throughout**: module service worker ([manifest.json:33–36](manifest.json)), `side_panel`, `options_ui`, offscreen document, no MV2 constructs, `minimum_chrome_version: "116"` ([manifest.json:5](manifest.json)) covering `chrome.runtime.getContexts` / `sidePanel` requirements.
- **CSP is store-safe and unusually strong** ([manifest.json:14–16](manifest.json)): `script-src 'self' 'wasm-unsafe-eval'; object-src 'self'; connect-src 'self' https://*.sec.gov`. `'wasm-unsafe-eval'` is the sanctioned MV3 way to run ONNX Runtime; the `connect-src` lockdown makes "nothing leaves your machine" a platform-enforced invariant, and `scripts/verify-dist.mjs` fails the build if it's loosened.
- **Least privilege now holds.** Install-time host permissions are **sec.gov only** ([manifest.json:17–19](manifest.json)); all eleven third-party financial sites are `optional_host_permissions` granted at click time ([manifest.json:20–32](manifest.json)); the single content script auto-runs only on `https://*.sec.gov/*` ([manifest.json:37–46](manifest.json)). The earlier over-broad `web_accessible_resources` block is **gone** — no site can probe or fingerprint the extension. The install prompt will read, in effect, "Read data on sec.gov" — exactly right for a privacy-branded tool.
- **API permissions are all justified**: `storage` (prefs + session filing hand-off), `sidePanel` (the UI), `offscreen` (ONNX workers, [service-worker.ts:96–120](src/background/service-worker.ts)), `activeTab` + `scripting` (on-demand injection). The action-click flow is deliberately built around preserving the activeTab grant ([service-worker.ts:48–79](src/background/service-worker.ts)) — the textbook least-privilege pattern.
- **One residual wrinkle (acceptable, be aware):** `chrome.storage.session.setAccessLevel('TRUSTED_AND_UNTRUSTED_CONTEXTS')` ([service-worker.ts:81–87](src/background/service-worker.ts)) lets content-script contexts read session storage. With sec.gov-only auto-injection this is low-risk; note that each optional host the user grants also gains that read access.

### 1.2 Remote code, privacy policy, disclosures, single purpose

- **Remote-code (MV3 hosted-code ban): compliant.** Model weights are fetched at *build* time ([scripts/fetch-models.mjs](scripts/fetch-models.mjs)), bundled under `models/`, and loaded via `chrome.runtime.getURL` with `env.allowRemoteModels = false` ([src/workers/transformersEnv.ts](src/workers/transformersEnv.ts)). ORT WASM ships in `wasm/`. ONNX weights are data, not script. Gemini Nano is Chrome's own built-in API — Chrome downloads and manages it, which is explicitly permitted. `verify-dist.mjs` gates all of this at build time. In the review notes, state plainly: *the only runtime network calls are user-initiated GETs to `*.sec.gov`*.
- **Privacy policy: written, not yet hosted.** [PRIVACY.md](PRIVACY.md) is excellent — short, concrete, covers the data-use certifications (no sale, no unrelated use, no creditworthiness use) and names the single egress path. **The CWS dashboard requires a public URL**, so publish it (GitHub Pages / repo page) and paste that URL into the listing. In the dashboard's data-usage section declare **"Website content — processed locally, not collected or transmitted"** and check the three certifications, which PRIVACY.md §"Data use certifications" already mirrors word-for-word.
- **Single-purpose policy: fine.** "Analyze financial disclosure documents" is one crisp purpose; Analyst/Summary/Sentiment/Redline/Fundamentals are facets of it. Keep the listing copy on that theme — the generic-page fallback is a capability, not the headline.
- **Package size:** ~131 MB of bundled models (FinBERT ~107 MB int8 + ~24 MB embedder). Under the CWS ceiling but a slow install; add a listing line — "includes on-device AI models; nothing downloads at runtime." A q4 FinBERT would roughly halve it later.

### 1.3 Store-listing assets still needed

| Asset | Spec | Status |
|---|---|---|
| Icon 128×128 | PNG | ✅ `public/icons/icon128.png` |
| Screenshots | 1–5 at 1280×800 | ❌ Suggested set: ① side panel Analyst tab + Fundamentals table on a real 10-K, ② Redline tab showing a YoY risk-factor diff, ③ language-flag underlines on the EDGAR page itself, ④ first-run "Private by design" screen, ⑤ Settings privacy section |
| Small promo tile | 440×280 | ❌ required for feature consideration |
| Marquee promo | 1400×560 | optional |
| Privacy policy URL | hosted page | ❌ content done ([PRIVACY.md](PRIVACY.md)), needs hosting |
| Per-permission justifications | dashboard fields | draft from [README.md](README.md) + PRIVACY.md §Permissions — mostly written, reuse |
| Category | — | Productivity → Tools |
| Publisher email | verified | ❌ confirm raaghav.ramji@gmail.com is verified in the dev dashboard |

**Draft store description:**

> **Relic — SEC filing analysis that never leaves your machine.**
>
> Open any 10-K, 10-Q, 8-K, 20-F, S-1, or proxy on SEC EDGAR and Relic turns it into an investor-grade briefing — entirely on your device.
>
> - **Analyst read** — a Bullish/Bearish/Mixed snapshot, top takeaways, revenue/margin/cash-flow signals, risk flags, and a bull-vs-bear case, each backed by a quote you can jump to in the filing. Quotes are verified against the source text; anything the model can't prove is dropped.
> - **Exact fundamentals** — revenue, margins, EPS, cash flow, and year-over-year deltas read directly from the filing's own XBRL data. No AI guessing: the numbers are the numbers.
> - **Year-over-year Redline** — one click fetches last year's comparable filing from SEC.gov and shows exactly what changed in Risk Factors and MD&A, with cosmetic rewordings filtered out.
> - **Sentence-level sentiment** — FinBERT, a finance-tuned model bundled inside the extension, scores the tone of every sentence.
> - **Language flags** — hedging, uncertainty, and litigious wording underlined in place on the filing.
> - **Plain-English summaries** of every section, exportable to PDF.
>
> **Private by design.** No account. No telemetry. No cloud APIs. The AI models ship inside the extension and run locally (WebGPU-accelerated where available). The only network request Relic ever makes is to SEC.gov, to fetch the prior year's filing when you ask for a comparison — and you can turn that off.
>
> Relic is for research and information only; it does not provide investment advice.

---

## 2. What Works Well

1. **The zero-egress claim is *enforced*, not asserted — at four independent layers.** CSP `connect-src` blocks all non-SEC egress ([manifest.json:15](manifest.json)); `allowRemoteModels=false` + bundled weights kill the usual Transformers.js hub fetch; the EDGAR queue is the single sanctioned network path, rate-limited to 8 req/s with 403/429 exponential backoff and a 30-min body cache ([src/background/edgarQueue.ts](src/background/edgarQueue.ts)); and `verify-dist.mjs` fails the build if the CSP weakens, sourcemaps leak, or weights go missing. This survives a hostile reviewer and a hostile Hacker News thread.

2. **The hallucination-guard stack is genuinely rare.** Every LM output passes: enum coercion, **verbatim evidence verification** — a quoted passage must exist in the filing or it's dropped ([src/analyst/evidence.ts:59–73](src/analyst/evidence.ts)), **figure verification** — generated dollar/percent figures must appear in the source or the sentence is cut, and **advice scrubbing** with deliberately narrow patterns ([evidence.ts:77–94](src/analyst/evidence.ts)). The synthesis stage sees only prior verified findings, never raw text, so it cannot introduce new "facts." For a financial tool this is the difference between a toy and something an analyst can cite.

3. **XBRL fundamentals (new since the last review) is the right kind of feature.** [src/content/ingest/xbrl.ts](src/content/ingest/xbrl.ts) parses the filing's own inline-XBRL `us-gaap`/`dei` facts straight from the DOM — correct handling of `scale`/`sign`, dimensional-context exclusion so per-segment breakdowns don't pollute consolidated totals, preference for annual over interim durations, current-vs-prior selection keyed to `periodOfReport`, derived margins, and jump-to-source ranges via the positionMap ([xbrl.ts:238–279](src/content/ingest/xbrl.ts)). Deterministic, exact, zero network, zero LM — it also feeds the deterministic Analyst headline ([deterministic.ts:152](src/analyst/deterministic.ts)). This instantly out-credentials every "chat with your PDF" competitor.

4. **Deterministic floor + staged LM upgrade = the UI can never hang or go blank.** A full deterministic analysis renders on frame one; each Gemini Nano stage overwrites only its own section, with per-stage deadlines (30 s first call, 20 s after — [pipeline.ts:119–125](src/analyst/pipeline.ts)) and honest degradation banners.

5. **CSS Custom Highlight API overlays.** Priority-stacked highlight layers with zero DOM mutation keep EDGAR's fragile inline-XBRL viewer intact, and the positionMap (normalized text → DOM ranges, O(log n)) gives every insight, sentiment sentence, flag, and now XBRL fact a working jump-to-source. The hardest part of the product, done right.

6. **The Redline is the differentiated feature.** Prior-filing resolution via EDGAR submissions JSON with continuation files ([src/background/resolvePrior.ts](src/background/resolvePrior.ts)), Jaccard-fallback section alignment, then a two-pass diff where leftover sentences are embedded and cosine-paired — ≥0.97 discarded as cosmetic, 0.82–0.97 rendered as word-level rewording. "Filter the lawyer noise, keep the meaning changes" is what a human analyst actually wants and what naive diff tools get wrong.

7. **Worker/inference engineering is solid.** Deterministic WebGPU→WASM fallback *including mid-inference recovery* — a WebGPU driver death re-inits once on WASM behind a shared promise and retries ([src/workers/encoder.worker.ts:95–110](src/workers/encoder.worker.ts)); singleton-guarded offscreen document; 5-minute idle unload tearing down workers and the offscreen doc; transferable ArrayBuffers; IndexedDB caches keyed by content hash with eviction ([src/lib/idbEvict.ts](src/lib/idbEvict.ts)).

8. **Code health.** 388 passing tests across the genuinely risky modules (positionMap, alignment/diff, EDGAR backoff, evidence guards, degraded pipeline, XBRL parsing); injectable seams everywhere; typed message contracts; first-party lexicons (the LM-lexicon license risk was removed in `44f20b6`); comments that explain *why* (the activeTab-gesture note at [service-worker.ts:48–53](src/background/service-worker.ts) is textbook).

---

## 3. Improvement Opportunities (ranked impact ÷ effort)

**Tier 1 — high impact, low effort (before launch):**

1. **Host the privacy policy and complete the CWS dashboard privacy section.** Content is done; this is the only true submission blocker left.
2. **Fix the wrong "Generation mode" description in Settings.** It claims the mode is "Chosen automatically from the page you're viewing" ([SettingsApp.tsx:339](src/settings/SettingsApp.tsx)) — it's chosen from *device capability* ([capabilities.ts:133](src/runtime/capabilities.ts)). One string. Also make the extractive status read as a healthy state ("Extractive · Ready"), not gray-implies-broken.
3. **"Try it on a real filing →" link in first-run and the empty state.** Most installs happen from the Web Store, not on EDGAR; after onboarding the user lands on "No filing open" ([App.tsx:302](src/sidepanel/App.tsx)) with no next step, and [FirstRun.tsx](src/sidepanel/FirstRun.tsx) has no link either. One anchor to a known 10-K is probably the single highest-leverage retention fix available.
4. **Gate the 23 `console.debug` calls behind a dev flag.** Reviewers open the SW console.

**Tier 2 — high impact, medium effort:**

5. **Typography consolidation** (see §4.1) — the biggest remaining trust/polish gap.
6. **Sentiment throughput on WASM-only devices.** FinBERT runs `CLASSIFY_BATCH = 8`, `CLASSIFY_CONCURRENCY = 1`, `numThreads: 1` ([offscreen.ts:75–77, 214](src/offscreen/offscreen.ts)). A large 10-K (3–5k sentences) on a no-WebGPU machine means hundreds of sequential single-threaded int8 BERT batches — plausibly minutes. In order of leverage: (a) cross-origin-isolate the offscreen document (`cross_origin_embedder_policy`/`cross_origin_opener_policy` manifest keys) to unlock `numThreads > 1`; (b) score visible/MD&A/Risk-Factors sections first and lazy-score the rest; (c) surface an ETA in the progress UI.
7. **Session-storage payload hygiene.** `persistFilingToSession` writes the entire `DocumentModel` per filing hash and never deletes prior hashes ([src/shared/filingSession.ts:14–24](src/shared/filingSession.ts)). `chrome.storage.session` has a 10 MB quota — a few large 10-Ks in one browser session can hit it, and the retry path fails the same way. Evict old `filing:model:*`/`filing:flags:*` keys on write.
8. **Verify the optional-site selectors before promoting those sites.** Every content/consent/paywall selector in [siteProfiles.ts](src/content/ingest/siteProfiles.ts) is still marked "UNVERIFIED — best guess" (lines 28–100, 201). Since the sites are opt-in this no longer blocks the listing, but a granted-then-broken site is worse than an absent one: an evening with live DOM captures, or trim the list to what you've verified.

**Tier 3 — medium impact:**

9. ~~Delete duplicate legacy modules~~ **Correction:** the `segment`/`positionMap` pairs are *not* duplicates — [ingest/segment.ts](src/content/ingest/segment.ts) and [ingest/position-map.ts](src/content/ingest/position-map.ts) are thin wrappers delegating to the real implementations in [src/content/segment.ts](src/content/segment.ts) and [src/content/positionMap.ts](src/content/positionMap.ts). No action needed beyond, optionally, a header comment noting the layering.
10. **Memory ceiling with both models resident.** Encoder + FinBERT + ORT arenas can push the offscreen doc toward 1 GB peak on WASM. Consider unloading FinBERT as soon as sentiment for the current filing completes (results are cached by hash) rather than waiting for the 5-min idle timer.
11. **EDGAR fetches ignore UI cancellation.** `fetchEdgarText` accepts an `AbortSignal` ([edgarQueue.ts:71, 110](src/background/edgarQueue.ts)) but `handleComputeRedline` never wires one ([service-worker.ts:160–211](src/background/service-worker.ts)), so closing the panel mid-redline leaves the fetch chain running. Low harm (rate-limited), easy to plumb.
12. **Deterministic-tier copy variety** — see §5.1.
13. **Version accent `#39FF14`.** Now confined to the version strings ([ui.tsx:185](src/sidepanel/ui.tsx), [SettingsApp.tsx:256](src/settings/SettingsApp.tsx)) — the insight-card labels were already toned down to `#00C68D`. Finish the job; terminal-green reads hacker, not fiduciary.

---

## 4. UI / UX + Settings

**What's strong:** the first-run screen leads with "Private by design" and three concrete checkmarks — exactly right; capability states are honest (Gemini Nano "Needs download" with a plain explanation, extractive mode framed positively rather than as a failure — [FirstRun.tsx:101–107](src/sidepanel/FirstRun.tsx)); the low-confidence-generic banner prevents "why is analysis empty" confusion ([App.tsx:603–618](src/sidepanel/App.tsx)); the settings page redesign is clean, the Privacy section's "The one network request is the Redline lookup" is accurate and well-worded, and the Fundamentals table gives the Analyst tab an immediate factual anchor. Accessibility is taken seriously (roving tabindex, `role="switch"`, `aria-live` announcements, reduced-motion variants). Tab naming is now consistently "Redline."

**Specific issues, in priority order:**

1. **Typography is chaotic and undermines trust — the #1 remaining UI issue.** The side panel mixes Roboto, Georgia, Times New Roman, Times, and system-ui via dozens of inline `font-[...]` overrides, sometimes within one line: company name in Georgia with its ticker in Times New Roman ([App.tsx:210–212](src/sidepanel/App.tsx)); the primary CTA in `font-[Times,serif]` ([App.tsx:306](src/sidepanel/App.tsx)); "Analyze this page" in Georgia ([App.tsx:622](src/sidepanel/App.tsx)); FirstRun alternating per-block. The settings page separately uses its own serif stack. Pick two faces — one serif for display headings, system-ui for everything else — define them once in [index.css](src/sidepanel/index.css), and delete every inline override. This is a mechanical, low-risk change with outsized perceived-quality payoff.
2. **First-run and the empty state don't let the user experience value** (§3.3). Add "Try it on a real filing →" to the onboarding CTA area and the `NoFiling` empty state, opening a well-known 10-K on EDGAR.
3. **The "Where Relic works" card occupies prime panel real estate on every view** ([App.tsx:592](src/sidepanel/App.tsx) renders it above the tabs unconditionally). After the first session it's noise pushing analysis below the fold. Collapse it to a single line once a filing has loaded successfully at least once.
4. **Settings "Generation mode" copy is wrong** (§3.2) — the only factual error on the page; fix before a reviewer or user notices the mismatch.
5. **Privacy communication is good but passive.** The promise lives in onboarding and settings, but during an actual analysis nothing marks the processing as local. A small "On-device" lock chip in the panel header during active analysis (tooltip: "This analysis never leaves your machine") would surface the differentiator at the exact moment a cloud competitor would be uploading. Keep the settings privacy sentence in sync if permissions ever change.
6. Minor: the FAQ answer about generation mode taking "a little longer the first time" avoids saying "Chrome downloads Gemini Nano (~2 GB)" — being concrete would preempt "is this really offline?" one-star reviews; the version accent `#39FF14` (§3.13).

---

## 5. Output Quality

Assessed from the pipeline code, prompts, deterministic output in the preview harness, and the new XBRL path.

**Trustworthiness: best-in-class for an LLM financial tool.** The verify-or-drop evidence policy, figure verification, advice scrubbing, synthesis-sees-only-verified-findings design, and now exact XBRL fundamentals mean Relic essentially cannot present a fabricated quote or number as fact. The `AI summary — verify against source` disclaimer ([summarize.ts:27](src/summarizer/summarize.ts)) and the investment-advice disclaimer in settings are the right compliance posture.

**Where it falls short for a working analyst:**

1. **The deterministic floor is honest but visibly templated.** Takeaway titles fall back to the section label, and the "Investor view" line is a single canned template — *"On-device sentiment reads the … language as net-positive"* ([deterministic.ts:269](src/analyst/deterministic.ts)) — repeated across cards. Extractive-tier users (a large cohort; the Prompt API needs recent Chrome + capable hardware) see this as *the* product. Cheap wins now that XBRL exists: title cards by their lead XBRL fact or key phrase, vary templates by signal type, and suppress "Investor view" when it would repeat.
2. **The LM tier is capped by tiny keyword-selected context budgets.** Each stage sees at most ~2.8–3.6k chars of excerpts ([pipeline.ts:113–115](src/analyst/pipeline.ts)) from filings that run 100k+ words, selected by keyword relevance — so the revenue stage can miss the actual revenue discussion if phrasing is unusual, and "Top takeaways" can miss the filing's real headline. The embedding infrastructure already on board could power **semantic** excerpt selection — the biggest single quality lever available without changing models.
3. **The 1–5 scores are pseudo-precise.** `AnalysisScores` come from Gemini Nano scoring its own digest, with unparseable values silently becoming 3. An analyst will not trust "Management credibility: 4/5" from an on-device 3B model, and it invites exactly the credibility attack the rest of the pipeline is engineered to avoid. Either label them "model impression," or derive them from deterministic signals (flag density, sentiment aggregate, redline magnitude, XBRL deltas) so they're defensible.
4. **FinBERT reads Risk Factors as uniformly negative.** Sentence-level scoring with confidence-floor calibration ([src/offscreen/calibrateSentiment.ts](src/offscreen/calibrateSentiment.ts)) and table exclusion is the right design, but dense legal/forward-looking hedging scores negative regardless of the company — noise, not signal. Per-section normalization against a typical Risk Factors baseline, or damping in boilerplate-flagged ranges (boilerplate detection already exists in [flagLanguage.ts](src/flagging/flagLanguage.ts)), would fix the systematic skew.
5. **Fundamentals coverage gaps to expect in the wild:** the curated concept list ([xbrl.ts:36–57](src/content/ingest/xbrl.ts)) covers the standard tags, but banks/insurers/REITs use different revenue concepts (`InterestAndDividendIncomeOperating`, `RevenuesNetOfInterestExpense`) and will often show an empty or sparse table. Fine for launch; add financial-sector concept rows when you see the gaps.
6. **Redline summaries are dry but factual** (templated change stats) — the correct trade-off; the LM change-narrative upgrade on the builtin tier covers the readable version. **PDF export** producing selectable-text A4 with the disclaimer is a professional touch analysts will actually use.

---

## 6. Market Need Assessment

**The honest headline: the pain is real but narrow, the wedge is the redline + exact fundamentals + compliance story, and a generic "AI summarizes filings" framing will lose.**

**Who actually feels this pain:**

- **Professionals at firms whose compliance bans pasting work product into cloud AI.** The filing is public — but *what you're researching is not*. An analyst's attention trail (which company, which section, how long) is confidential strategy at funds and material-nonpublic-adjacent at banks and law firms. "Runs locally; IT can verify zero egress from the CSP" is a purchasing argument no cloud tool can match, and the enforcement depth (§2.1) survives a real security review, not just a marketing page.
- **Auditors, IR teams, and securities lawyers** doing YoY disclosure comparison — today a painful manual Word-compare against two downloaded filings. Relic's one-click, in-place redline with cosmetic-change filtering is a direct 30-minutes-to-30-seconds replacement.
- **Serious retail / prosumer investors** who read primary filings — small but vocal, over-indexed on HN/FinTwit; great for launch, bad for revenue.

**Competitive landscape:** AlphaSense/Tegus and Bloomberg own institutions ($10–25k+/seat) — you're the tool for people who *can't get or can't use* those. BamSEC (~$40+/mo) owns "EDGAR but pleasant" and has redlining in paid tiers — the closest real competitor; Relic's answer is free/local/private and in-place on EDGAR itself. Fintool/FinChat-class cloud AI has strictly better prose quality but requires uploading your research trail. Generic ChatGPT/Claude is the default alternative: better writing, but context limits on 100k-word filings, no evidence verification, no redline, no exact XBRL table, and a compliance non-starter at regulated shops. Chrome's own built-in AI will commoditize the *Summary* tab within a year — which is why the redline, fundamentals, sentiment overlay, and evidence-verified analyst read must be the identity.

**Devil's advocate — the weak points:**

1. **"Privacy for public documents" invites an eye-roll** unless you market the *research-trail* argument explicitly. The landing copy must say "what you research reveals your strategy," not just "your data stays local."
2. **Quality ceiling is real.** Gemini Nano + a 3.6k-char excerpt budget produces a visibly shallower read than GPT-class tools, and the extractive-tier majority sees templated cards (§5.1). The counter is trust engineering + deterministic features — lean on what's *verifiably correct* (redline, XBRL, verified quotes) rather than competing on prose.
3. **Distribution is hard.** Chrome-only, 131 MB install, and the builtin tier needs recent Chrome + hardware. No virality loop; nobody searches the Web Store for "SEC filing analyzer" in volume. Realistic channels: Show HN (the zero-egress engineering is a genuinely good post), FinTwit, r/SecurityAnalysis, audit/accounting communities.
4. **Willingness to pay is bimodal:** retail pays ~$0; professionals pay well but procure via IT — which is exactly who the zero-egress architecture is designed to convince. If monetization matters, the shape is free core + paid professional tier (multi-filing redline history, XBRL fact sheets across periods, export packs, team policy docs).
5. **Platform risk:** the moat narrows as Chrome's built-in AI grows a bigger context window and every browser grows a "summarize" button. The durable assets are the positionMap/overlay engine, the redline pipeline, the XBRL extractor, and the trust architecture — invest there, not in more prose generation.

**Strongest wedge, stated once:** *"The YoY redline you'd pay BamSEC for, plus exact XBRL fundamentals and an evidence-verified analyst read — free, on the EDGAR page itself, with provably zero egress."* Lead with the redline in every screenshot and demo; it's the feature with no free substitute.

---

## 7. Prioritized Implementation List

Highest priority to lowest. "Blocker" = required to submit; everything else improves approval odds, retention, or quality.

| # | Item | Why | Effort |
|---|---|---|---|
| 1 | Host [PRIVACY.md](PRIVACY.md) at a public URL; complete CWS dashboard privacy disclosures + certifications | **Submission blocker** | ~1 hr, no code |
| 2 | Store assets: 5 screenshots, 440×280 promo tile, final description (§1.3 draft), category, verified publisher email | **Submission blocker** | ~half day, no code |
| 3 | Fix Settings "Generation mode" description + extractive status label ([SettingsApp.tsx:339](src/settings/SettingsApp.tsx)) | Factual error on the trust page | ~15 min |
| 4 | "Try it on a real filing →" link in FirstRun + NoFiling empty state | Highest-leverage retention fix; most installs land off-EDGAR | ~1 hr |
| 5 | Typography consolidation: two faces defined in CSS, delete all inline `font-[...]` overrides; retire `#39FF14` | Biggest perceived-quality gap; mechanical | ~half day |
| 6 | Gate `console.debug` (23 call sites) behind a dev flag | Reviewers open the SW console | ~1 hr |
| 7 | Collapse "Where Relic works" card after first successful filing | Reclaims prime panel space | ~1 hr |
| 8 | Session-storage eviction in `persistFilingToSession` ([filingSession.ts:14–24](src/shared/filingSession.ts)) | Real quota failure after a few large filings | ~2 hrs + test |
| 9 | WASM sentiment throughput: COOP/COEP cross-origin isolation → `numThreads > 1`; prioritize MD&A/Risk sections; show ETA | Minutes-long waits on no-WebGPU machines | 1–2 days |
| 10 | "On-device" lock chip in panel header during analysis | Makes the differentiator visible at the moment of value | ~2 hrs |
| 11 | Deterministic-tier copy variety (title by lead XBRL fact/key phrase; vary/suppress templates) | The extractive majority sees this as the product | ~1 day |
| 12 | Semantic excerpt selection for LM stages using the existing embedder | Biggest LM-quality lever without changing models | 1–2 days |
| 13 | ~~Delete duplicate legacy modules~~ — withdrawn: the `ingest/` files are wrappers over live implementations, not duplicates | n/a | n/a |
| 14 | Wire `AbortSignal` from panel → `handleComputeRedline`; unload FinBERT after sentiment completes | Resource hygiene | ~half day |
| 15 | Relabel 1–5 scores as "model impression" or derive from deterministic signals | Credibility protection | ~half day (relabel) / 2 days (derive) |
| 16 | Per-section sentiment normalization / boilerplate damping for Risk Factors | Removes systematic red skew | 1–2 days |
| 17 | Verify optional-site selectors with live DOM captures, or trim the optional-host list | Broken opt-in sites are worse than absent ones | ~1 evening |
| 18 | Financial-sector XBRL concept rows (banks/insurers/REITs) | Coverage gap; wait for real-world reports | ~half day, post-launch |

## 8. Shipping Plan by Session

**Session A — Submission package (no code).** Items 1–2: publish the privacy policy, capture screenshots against a real 10-K (build + load unpacked, use the §1.3 shot list), make the promo tile, finalize description and dashboard fields. *Exit: extension submitted for review.*

**Session B — Pre-launch polish PR (parallel with review queue).** Items 3–7: settings copy fix, first-run/empty-state EDGAR link, typography consolidation, debug-log gating, WhereItWorks collapse. One focused UI PR, verified in the dev preview (`npm run dev:ui`). *Exit: v1.2.8 ready to push as the first update.*

**Session C — Reliability & hygiene.** Items 8 and 14: session-storage eviction (with a test mirroring [idbEvict.test.ts](tests/idbEvict.test.ts)), abort wiring + eager FinBERT unload. Small, independently verifiable changes. *Exit: no known resource-exhaustion paths.*

**Session D — WASM performance.** Items 9, 10: cross-origin-isolate the offscreen document, enable multi-threaded ORT, section prioritization, progress ETA, and the on-device chip (it earns its place once analysis is fast enough to watch). Needs manual testing on a no-WebGPU machine or with WebGPU force-disabled. *Exit: large 10-K sentiment under ~30 s on a WASM-only laptop, with visible progress.*

**Session E — Output quality v2.** Items 11, 12, 15, 16: deterministic copy variety, semantic excerpt selection, score treatment, sentiment normalization. The highest-skill session; do after launch feedback confirms where users actually notice shallowness. *Exit: extractive tier no longer reads templated; LM takeaways stop missing headline facts.*

**Session F — Coverage & distribution.** Items 17, 18 plus launch work: verify or trim optional sites, sector XBRL rows as bug reports arrive, Show HN post on the zero-egress engineering, demo GIF of the redline, landing copy built on the research-trail argument. *Exit: launched, with the wedge story told correctly.*
