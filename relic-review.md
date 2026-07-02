# Relic — Pre-Launch Review

*Reviewed at v1.2.7 (2026-07-01). All 376 unit tests pass (30 files, 7 skipped). Line references are to the current working tree.*

---

## 1. Chrome Web Store Launch Readiness

### 1.1 Manifest audit (manifest.json)

**Compliant / good:**

- **MV3 structure is correct** — module service worker ([manifest.json:32–35](manifest.json)), `side_panel`, `options_ui`, `offscreen` document. No deprecated MV2 constructs.
- **CSP is strong and store-safe** ([manifest.json:13–15](manifest.json)): `script-src 'self' 'wasm-unsafe-eval'; object-src 'self'; connect-src 'self' https://*.sec.gov`. `'wasm-unsafe-eval'` is the MV3-sanctioned way to run ONNX Runtime WASM; the `connect-src` lockdown to sec.gov is a genuine platform-level enforcement of the zero-egress claim, and [scripts/verify-dist.mjs:57–63](scripts/verify-dist.mjs) fails the build if it's ever loosened. Very few extensions do this.
- **API permissions are minimal**: `storage`, `sidePanel`, `activeTab`, `offscreen`, `scripting` — each is used and justified. The `activeTab` + `scripting` pattern for on-demand injection ([src/background/service-worker.ts:54–79](src/background/service-worker.ts)) is exactly the least-privilege pattern Google's docs recommend, and the comment explaining why the panel opens from `action.onClicked` (to preserve the activeTab grant) shows the flow was designed around it.
- **Manifest description is 119 chars** — under the 132-char limit.
- **Remote-code compliance: clean** (see 1.3).

**Flag — likely reviewer friction, fix before submitting:**

1. **`web_accessible_resources` with `"matches": ["<all_urls>"]`** ([manifest.json:86–93](manifest.json)) is your biggest rejection/trust risk.
   - The exposed resources (`assets/*`, `wasm/*`, `models/*`) are only ever loaded by the **offscreen document and its workers** ([src/offscreen/offscreen.ts:207–216](src/offscreen/offscreen.ts) passes `chrome.runtime.getURL('models/')` into the workers). Extension-context pages do **not** need `web_accessible_resources` at all — WAR exists so *web pages* can load extension resources.
   - As shipped, any website on the internet can probe `chrome-extension://<id>/models/...`, which (a) lets sites fingerprint that the user has Relic installed — a real privacy leak in a privacy-branded product — and (b) invites a reviewer question you don't want. The README ([README.md:41–44](README.md)) admits the scope is "forward-looking."
   - **Recommendation: delete the `web_accessible_resources` block entirely** (or, if some future on-page overlay asset genuinely needs it, scope `matches` to the specific hosts). Verify with a full build + manual test; I expect zero breakage since all consumers are extension contexts.

2. **Install-time host permissions for six third-party sites** ([manifest.json:16–24](manifest.json), content scripts at 36–62): `annualreports.com`, `stockanalysis.com`, `fool.com`, `benzinga.com`, `sec.report`, `finviz.com`, all auto-injected on *every page* of those hosts, and matched with `*://` (HTTP included). Consequences:
   - The install prompt will read "Read and change your data on annualreports.com, benzinga.com, fool.com, …" — jarring for a "100% private" tool, and multi-host access triggers the Web Store's in-depth review track.
   - `fool.com` and `benzinga.com` are general news sites; a content script running on every article there is much broader than the feature (analyzing the occasional filing/earnings page) needs.
   - **Recommendation:** keep only `https://*.sec.gov/*` at install time and move Groups A and B into `optional_host_permissions` alongside Yahoo/CNBC/Reuters. Your Group-C runtime-grant machinery ([src/background/service-worker.ts:239–251](src/background/service-worker.ts), [src/sidepanel/App.tsx:492–508](src/sidepanel/App.tsx)) already handles this flow perfectly — extending it to A/B is mostly a manifest + `siteProfiles` change. Fallback: the `activeTab` "Analyze this page" click already works on any site with zero standing permissions. This one change makes the install prompt say only "Read data on sec.gov" — the single strongest trust signal you can buy.
   - At minimum, change `*://` matches to `https://` only.

3. **No `minimum_chrome_version`.** You depend on `chrome.sidePanel` (114+), `chrome.runtime.getContexts` (116+), the CSS Custom Highlight API (105+), and optionally Summarizer/Prompt API (138+). Set `"minimum_chrome_version": "116"` so users on older Chrome don't install a broken extension and leave 1-star reviews.

### 1.2 Least-privilege scorecard

| Permission | Needed by | Verdict |
|---|---|---|
| `storage` | prefs, session filing hand-off, onboarding flag | ✅ minimal |
| `sidePanel` | the entire UI | ✅ |
| `offscreen` | ONNX workers off the SW ([service-worker.ts:96–120](src/background/service-worker.ts)) | ✅ |
| `activeTab` + `scripting` | on-demand injection | ✅ model usage |
| `https://*.sec.gov/*` | EDGAR prior-filing fetch + auto content script | ✅ core |
| Group A/B host perms | auto-run on 6 third-party sites | ⚠️ broader than needed — make optional |
| `optional_host_permissions` (Yahoo/Macrotrends/BamSEC/CNBC/Reuters) | opt-in per site | ✅ correct pattern |
| `web_accessible_resources: <all_urls>` | nothing today | ❌ remove |

One wrinkle to be aware of (not a violation): the service worker sets `chrome.storage.session.setAccessLevel('TRUSTED_AND_UNTRUSTED_CONTEXTS')` ([service-worker.ts:83–87](src/background/service-worker.ts)) so content scripts can write filing models. That means *any* content script context (i.e., pages you have host permissions on) can read session storage. With sec.gov-only host permissions this is a non-issue; with six third-party hosts it's another small argument for narrowing them.

### 1.3 Remote code, privacy policy, disclosures, single purpose

- **Remote code (MV3 hosted-code ban): compliant.** Model weights are fetched at *build* time ([scripts/fetch-models.mjs](scripts/fetch-models.mjs)), bundled under `models/`, and loaded via `chrome.runtime.getURL` with `env.allowRemoteModels = false` ([src/workers/transformersEnv.ts:21–27](src/workers/transformersEnv.ts)). ORT WASM ships in `wasm/`. ONNX weights are data, not executable script, so even the weights raise no remote-code question. Gemini Nano is Chrome's own built-in API — Chrome downloads and manages it, which is explicitly fine. `verify-dist.mjs` gates all of this at build time. **Do state in the review notes** that the only runtime network calls are user-initiated GETs to `*.sec.gov`.
- **Privacy policy: required and currently missing.** The extension processes "website content" (the filing text) and the dashboard's Privacy tab will require: a hosted privacy-policy URL, per-datatype disclosures (declare **website content — processed locally, not collected/transmitted**), and the three certification checkboxes (no sale, no unrelated use, no creditworthiness use). Write a short policy (a page on GitHub Pages is fine) that says: no data collected, no telemetry, filing text processed on-device, sole network egress is sec.gov, caches stored locally and clearable in Settings. Your architecture makes this the easiest privacy policy ever written — treat it as marketing.
- **Single-purpose policy: fine.** "Analyze financial disclosure documents" is one crisp purpose; summaries/sentiment/flags/redline are facets of it. Keep the store description tightly on that theme (don't drift into "summarize any webpage" language — the generic-page fallback is fine as a capability but shouldn't headline).
- **Package size:** ~131 MB of models (107 MB FinBERT + 24 MB embedder) plus code. Under the 2 GB CWS ceiling, but it makes install slow and some corporate proxies flaky. Worth a line in the listing ("includes on-device AI models — nothing downloads at runtime"). Longer-term, a q4 FinBERT would roughly halve it.

### 1.4 Store-listing assets you still need

| Asset | Spec | Status |
|---|---|---|
| Icon 128×128 | PNG | ✅ have (`public/icons/icon128.png`) |
| Screenshots | 1–5, 1280×800 (or 640×400) | ❌ need. Suggested set: ① side panel on a real 10-K with sentiment overlay on the page, ② Redline tab showing YoY risk-factor diff, ③ Analyst tab, ④ first-run "Private by design" screen, ⑤ settings Privacy section |
| Small promo tile | 440×280 | ❌ need (required for feature consideration) |
| Marquee promo | 1400×560 | optional |
| Privacy policy URL | hosted page | ❌ need |
| Per-permission justifications | dashboard fields | draft from [README.md:29–47](README.md) — already written, reuse it |
| Category | — | Productivity → Tools (or Workflow & Planning) |
| Support email / site | verified publisher email | ❌ confirm |

**Draft store description:**

> **Relic — SEC filing analysis that never leaves your machine.**
>
> Open any 10-K, 10-Q, 8-K, 20-F, S-1, or proxy on SEC EDGAR and Relic turns it into an investor-grade briefing — entirely on your device.
>
> - **Analyst read** — a Bullish/Bearish/Mixed snapshot, top takeaways, revenue/margin/cash-flow signals, risk flags, and a bull-vs-bear case, each backed by a quote you can jump to in the filing. Quotes are verified against the source text; anything the model can't prove is dropped.
> - **Year-over-year redline** — one click fetches last year's comparable filing from SEC.gov and shows exactly what changed in Risk Factors and MD&A, with cosmetic rewordings filtered out.
> - **Sentence-level sentiment** — FinBERT (a finance-tuned model bundled inside the extension) paints a tone heatmap directly on the filing.
> - **Language flags** — hedging, uncertainty, and litigious wording highlighted in place.
> - **Plain-English summaries** of every section.
>
> **Private by design.** No account. No telemetry. No cloud APIs. The AI models ship inside the extension and run locally (WebGPU-accelerated where available). The only network requests Relic ever makes are to SEC.gov, to fetch the prior year's filing when you ask for a comparison — and you can turn that off.
>
> Relic is for research and information only; it does not provide investment advice.

---

## 2. What Works Well

1. **The zero-egress claim is *enforced*, not asserted — at four independent layers.** CSP `connect-src` blocks all non-SEC egress from extension pages ([manifest.json:14](manifest.json)); `allowRemoteModels=false` + bundled weights kill the usual Transformers.js hub fetch ([transformersEnv.ts:21–23](src/workers/transformersEnv.ts)); the EDGAR queue is the single sanctioned network path, rate-limited to 8 req/s with backoff and a 30-min cache ([src/background/edgarQueue.ts:29–136](src/background/edgarQueue.ts)); and `verify-dist.mjs` fails the build if the CSP weakens, sourcemaps leak, or weights go missing. This is the product's core promise engineered as an invariant. It will survive a hostile reviewer and a hostile Hacker News thread.

2. **The hallucination-guard stack in the Analyst pipeline is genuinely rare.** Every LM output passes: enum coercion ([src/analyst/pipeline.ts:178–235](src/analyst/pipeline.ts)), **verbatim evidence verification** — a quoted passage must actually exist in the filing or it's dropped and confidence downgraded ([src/analyst/evidence.ts:60–74](src/analyst/evidence.ts)), **figure verification** — any dollar/percent figure in generated prose must appear somewhere in the source or the sentence is cut ([evidence.ts:138–151](src/analyst/evidence.ts)), and **advice scrubbing** ([evidence.ts:80–94](src/analyst/evidence.ts)). The synthesis stage deliberately sees only prior verified findings, never raw text ([pipeline.ts:464–471](src/analyst/pipeline.ts)), so it can't introduce new "facts." For a financial tool this is the difference between a toy and something an analyst can cite.

3. **Deterministic floor + staged LM upgrade = the UI can never hang or go blank.** `generateFilingAnalysis` renders a full deterministic analysis on frame one, then lets each Gemini Nano stage overwrite its own section only if it produces real content, with per-stage deadlines (30 s first call, 20 s after) and an early bail if the very first stage fails ([pipeline.ts:283–379](src/analyst/pipeline.ts)). Degradation is honest (`analysis.degraded` drives a banner). Most extensions in this space would just spin forever.

4. **CSS Custom Highlight API overlays.** Fifteen priority-stacked highlight layers with zero `<span>` injection means EDGAR's inline-XBRL viewer — which breaks under DOM mutation — stays intact, and the `positionMap` (normalized text → DOM ranges, O(log n)) gives every insight, sentiment sentence, and flag a working jump-to-source. This is the hardest part of the whole product and it's done right.

5. **The redline is the differentiated feature.** Prior-filing resolution via the EDGAR submissions JSON (with continuation files, [src/background/resolvePrior.ts](src/background/resolvePrior.ts)), section alignment with a Jaccard fallback for renamed sections, then a two-pass diff where leftover added/removed sentences are embedded and cosine-paired — cosine ≥ 0.97 discarded as cosmetic, 0.82–0.97 rendered as word-level rewording spans ([src/offscreen/offscreen.ts:652–680](src/offscreen/offscreen.ts)). That "filter the lawyer noise, keep the meaning changes" step is what a human analyst actually wants and what naive diff tools get wrong. The `unsupported_form` explicit status instead of a silent empty diff ([offscreen.ts:712–726](src/offscreen/offscreen.ts)) shows good failure-mode thinking.

6. **Worker/inference engineering is solid.** Deterministic WebGPU→WASM backend fallback *including mid-inference recovery* (a WebGPU driver death re-inits once on WASM and retries the batch, [src/workers/encoder.worker.ts:98–109](src/workers/encoder.worker.ts)); a singleton-guarded offscreen document ([service-worker.ts:96–120](src/background/service-worker.ts)); 5-minute idle unload that tears down both workers and closes the offscreen doc ([offscreen.ts:115–143](src/offscreen/offscreen.ts)); transferable ArrayBuffers for embeddings; IndexedDB caches keyed by content hash with eviction ([src/lib/idbEvict.ts](src/lib/idbEvict.ts)).

7. **Code health.** 376 passing tests across the genuinely risky modules (positionMap, alignment/diff, EDGAR queue backoff, evidence guards, degraded-mode pipeline); injectable seams everywhere (`fetchImpl`, `lmFactory`, `similarity`); typed message contracts; and comments that explain *why* (the activeTab-gesture note at [service-worker.ts:48–53](src/background/service-worker.ts) is textbook).

---

## 3. Improvement Opportunities (ranked impact ÷ effort)

**Tier 1 — high impact, low effort (do before launch):**

1. **Remove `web_accessible_resources`** (§1.1.1). Closes a fingerprinting hole and a review question. ~1 line + retest.
2. **Move Group A/B hosts to optional permissions** (§1.1.2). Turns the install prompt into "sec.gov only." Manifest + `siteProfiles`/`inject.ts` group changes; the runtime-grant UI already exists.
3. **Add `minimum_chrome_version: "116"`.** 1 line.
4. **Write + host the privacy policy** (§1.3). An hour of work, blocking for submission.

**Tier 2 — high impact, medium effort:**

5. **Sentiment throughput on WASM devices.** FinBERT runs `CLASSIFY_BATCH = 8`, `CLASSIFY_CONCURRENCY = 1`, `numThreads: 1` ([offscreen.ts:75–77, 214](src/offscreen/offscreen.ts)). On a no-WebGPU machine, a big 10-K (3–5k sentences) means hundreds of sequential single-threaded int8 BERT batches — plausibly several minutes. Options, in order of leverage: (a) enable multi-threaded ORT WASM — extension pages can be cross-origin-isolated via `cross_origin_embedder_policy`/`cross_origin_opener_policy` manifest keys on the offscreen doc, unlocking `numThreads > 1`; (b) prioritize visible/MD&A/risk sections first and lazy-score the rest (the progressive per-section streaming scaffolding already exists); (c) offer a q4 quantization. Also surface an ETA in the progress UI.
6. **Session-storage payload hygiene.** `persistFilingToSession` writes the entire `DocumentModel` (all section text) per filing hash and never deletes prior hashes ([src/shared/filingSession.ts:14–24](src/shared/filingSession.ts)). `chrome.storage.session` has a 10 MB quota — two or three large 10-Ks in one browser session can hit it, and the failure path (retry via SW, same quota) will still fail. Keep only `filing:current` + the latest model, or evict old hashes on write.
7. **Verify the Group B/C site selectors.** `siteProfiles.ts` is honest that every content/consent/paywall selector is "UNVERIFIED — best guess" ([src/content/ingest/siteProfiles.ts:26–58](src/content/ingest/siteProfiles.ts)). If you ship those hosts (even as optional), an evening with live captures turns guesses into facts; otherwise gate detection silently misfires and users see junk extractions blamed on Relic.

**Tier 3 — medium impact:**

8. **Duplicate/legacy modules.** `src/content/segment.ts` vs `src/content/ingest/segment.ts`, and `src/content/positionMap.ts` vs `src/content/ingest/position-map.ts` — one of each pair looks vestigial. Dead code in a security-reviewed extension is pure liability; delete or merge.
9. **Memory ceiling with both models resident.** Encoder (~24 MB weights) + FinBERT (~107 MB) + ORT arenas + WASM heaps can push the offscreen doc toward 1 GB peak on WASM. The idle unload helps, but consider unloading FinBERT after sentiment completes for the current filing (it's cached by hash anyway) instead of waiting for the 5-min timer.
10. **`console.debug` noise ships to production** (service worker, offscreen, workers). Gate behind a dev flag; reviewers do open the SW console.
11. **EDGAR fetches ignore cancellation from the UI.** `fetchEdgarText` accepts a `signal` ([edgarQueue.ts:71](src/background/edgarQueue.ts)) but `handleComputeRedline` never wires one, so closing the panel mid-redline leaves fetch chains running. Low harm (rate-limited), but easy to plumb.
12. **Templated copy in deterministic insights** — see §5.

---

## 4. UI / UX + Settings

Verified against the live dev preview (`npm run dev:ui`) in the filing, onboarding, and settings scenarios.

**What's strong:** the first-run screen leads with "Private by design" and three concrete checkmarks — exactly right for this product; capability states are honest (Gemini Nano "Needs download" with an explanation); banners for exhibits/index pages/data reports prevent the classic "why is analysis empty" confusion; accessibility is taken seriously throughout (roving tabindex tab bar, `role="switch"`, `aria-live` announcements, reduced-motion variants).

**Specific issues, in priority order:**

1. **Typography is chaotic and undermines trust.** The side panel mixes Roboto, Georgia, Times New Roman, Times, and system-ui — sometimes within one line: company name in Georgia with its ticker in Times New Roman ([src/sidepanel/App.tsx:210–212](src/sidepanel/App.tsx)); the primary CTA button set in `font-[Times,serif]` ([App.tsx:306](src/sidepanel/App.tsx)); another CTA in Georgia ([App.tsx:622](src/sidepanel/App.tsx)); labels in Roboto. The settings page separately uses an Iowan Old Style serif stack. It reads as unfinished. Pick two: the settings serif for display headings, one sans (system-ui) for everything else, defined once in `index.css` — delete every inline `font-[...]` override.
2. **The neon `#39FF14` accent looks like a debug artifact.** It's used for the version string in both surfaces ([src/sidepanel/ui.tsx:185](src/sidepanel/ui.tsx), [src/settings/SettingsApp.tsx:256](src/settings/SettingsApp.tsx)) and — worse — for the "Why it matters:" / "Investor view:" labels on every insight card ([AnalystPanel.tsx:121–127](src/sidepanel/AnalystPanel.tsx)). Terminal-green on a financial research tool reads hacker, not fiduciary. Use the settings accent (`#34d399`) or zinc.
3. **Tab is labeled "Redline" but every piece of copy calls it "Changes"** ([App.tsx:58](src/sidepanel/App.tsx) vs. the settings walkthrough, FAQ, banners, and README). Users will look for "Changes" and not find it. Pick one name — "Changes" is the friendlier choice; keep "redline" for the body copy.
4. **First-run and empty states don't let the user experience value.** Most installs happen from the Web Store, i.e., *not* on EDGAR; after onboarding the user lands on "No filing open" with no next step. Add one link — "Try it on a real filing →" opening a known 10-K on EDGAR — to both the onboarding CTA area and the `NoFiling` empty state. This is probably the single highest-leverage retention fix in the whole review.
5. **The "Info" card wastes the panel's prime real estate.** `WhereItWorks` sits above the tabs on every page, pushing the actual analysis down ([App.tsx:135–176](src/sidepanel/App.tsx)). After the first session it's noise. Collapse it by default once a filing has loaded successfully, retitle it ("Where Relic works"), and move it below the tabs or behind the header's settings affordance.
6. **Settings: the "Generation mode" description is wrong.** It says the mode is "Chosen automatically from the page you're viewing" ([SettingsApp.tsx:339](src/settings/SettingsApp.tsx)) — it's chosen from *device capability* ([capabilities.ts:133–134](src/runtime/capabilities.ts)). Also the status renders "Ready" (green) for builtin vs. "Extractive" (gray) — gray implies broken. Say "Built-in AI · Ready" / "Extractive · Ready" so both read as functioning states.
7. **Privacy communication is good but passive.** The promise lives in onboarding and settings, but during an actual analysis nothing reminds the user their document is being processed locally. A small lock chip in the panel header ("On-device" tooltip: "This analysis never leaves your machine") during active analysis would make the differentiator visible at the exact moment competitors would be uploading. The privacy sentence in Settings ("The one network request is the Redline lookup") is accurate and well-worded — keep it in sync if host permissions change.
8. Minor: the two gate-state banner sets (consent wall/paywall) are duplicated between `NoFiling` and the filing view ([App.tsx:341–354 and 650–663](src/sidepanel/App.tsx)) — extract one component; the FAQ answer "Generation Mode may take a little longer the first time" avoids saying "Chrome downloads Gemini Nano (~2 GB)" — being concrete would preempt "is this really offline?" reviews.

---

## 5. Output Quality

Assessed from the pipeline code, prompts, and the rendered deterministic output in the preview harness.

**Trustworthiness: excellent — best-in-class for an LLM financial tool.** The verify-or-drop evidence policy, figure verification, advice scrubbing, and the synthesis-sees-only-verified-findings design (§2.2) mean Relic essentially cannot show a fabricated quote or number as fact. The `AI summary — verify against source` disclaimer ([src/summarizer/summarize.ts:27](src/summarizer/summarize.ts)) and the investment-advice disclaimer in settings are the right compliance posture.

**Where it falls short for a working analyst:**

1. **The deterministic floor is honest but shallow and visibly templated.** In the preview, all three "Top takeaways" titles are just the section label ("Management's Discussion and Analysis changed…" ×2), and every card's "Investor view" is the same sentence: *"On-device sentiment reads the … language as net-positive."* The whatChanged cards likewise reuse two canned "why it matters" strings ([src/analyst/deterministic.ts:90–98](src/analyst/deterministic.ts)). Extractive-tier users (a large cohort — Prompt API requires recent Chrome + capable hardware) see this as *the* product. Cheap wins: title cards by their lead figure or key phrase instead of the section name, vary the templates by signal type, and suppress the "Investor view" line entirely when it would repeat.
2. **The LM tier is capped by tiny context budgets.** Each stage sees at most ~3.2–3.6k chars of keyword-selected excerpts ([pipeline.ts:113–115](src/analyst/pipeline.ts)) from filings that run 100k+ words. Keyword relevance selection means the revenue stage can miss the actual revenue table discussion if phrasing is unusual, and anything outside the excerpt is invisible — so "Top takeaways" can miss the filing's real headline. The embedding infrastructure you already have could power semantic (rather than keyword) excerpt selection — likely the biggest single quality lever available without changing models.
3. **The 1–5 scores are pseudo-precise.** `AnalysisScores` (revenue strength, management credibility, etc.) come from Gemini Nano scoring its own digest, with unparseable values silently becoming 3 ([pipeline.ts:224–235](src/analyst/pipeline.ts)). An analyst will not trust "Management credibility: 4/5" from a 3B on-device model, and it invites exactly the credibility attack the rest of the pipeline is engineered to avoid. Either label them explicitly as "model impression," or derive them from deterministic signals (flag density, sentiment aggregate, redline magnitude) so they're defensible.
4. **XBRL facts are the big miss.** EDGAR filings carry structured `us-gaap`/`dei` facts in-page, and the ingest layer already detects them for classification ([SITES.md](SITES.md), Axis B). Extracting even a dozen facts (revenue, net income, shares outstanding, cash) would enable *deterministic, exact* fundamentals and YoY deltas — no LM, no verification needed — and would instantly out-credential every generic "chat with your PDF" competitor. This is the highest-value output-quality investment on the board.
5. **Sentiment output is good but unaggregated in places FinBERT is weak.** Sentence-level FinBERT with confidence-floor calibration ([src/offscreen/calibrateSentiment.ts](src/offscreen/calibrateSentiment.ts)) and table exclusion is the right design; but FinBERT systematically reads dense legal/forward-looking hedging as negative, so Risk Factors sections will paint largely red regardless of the company — that's noise, not signal. Consider per-section normalization (compare against typical Risk Factors baseline) or damping the heatmap in boilerplate-flagged ranges (you already detect boilerplate: [src/flagging/flagLanguage.ts:26–41](src/flagging/flagLanguage.ts)).
6. **Redline summaries are dry but factual** (templated change stats). That's the correct trade-off; the LM change-narrative upgrade path on the builtin tier covers the readable version.
7. **PDF export** ([src/export/pdf.ts](src/export/pdf.ts)) producing selectable-text A4 with the disclaimer is a professional touch analysts will actually use.

---

## 6. Market Need Assessment

**The honest headline: the pain is real but narrow, the wedge is the redline + compliance story, and the generic "AI summarizes filings" framing will lose.**

**Who actually feels this pain:**

- **Professionals at firms whose compliance bans pasting work product into cloud AI.** The filing itself is public — but *what you're researching is not*. An analyst's attention trail (which company, which section, how long) is confidential strategy at funds, and material-nonpublic-adjacent at banks and law firms. "Runs locally, IT can verify zero egress from the CSP" is a purchasing argument no cloud tool can match, and the enforcement depth (§2.1) means it survives a real security review, not just a marketing page.
- **Auditors, IR teams, and securities lawyers** doing YoY disclosure comparison — today this is a painful manual Word-compare workflow against two downloaded filings. Relic's one-click, in-place redline with cosmetic-change filtering is a direct 30-minutes-to-30-seconds replacement.
- **Serious retail / prosumer investors** who read primary filings (small but vocal, over-indexed on HN/FinTwit — great for launch, bad for revenue).

**Competitive landscape:** AlphaSense/Tegus and Bloomberg own institutions ($10–25k+/seat) — you're not competing there, you're the tool for people who *can't get or can't use* those. BamSEC (~$40+/mo) owns "EDGAR but pleasant" and has redlining in paid tiers — the closest real competitor; Relic's answers are free/local/private and in-place on EDGAR itself. Fintool/Finchat-class cloud AI has strictly better model quality but requires uploading your research trail. Generic ChatGPT/Claude is the default alternative: better prose, but context limits on 100k-word filings, no evidence verification, no redline, and a compliance non-starter at regulated shops. Chrome's own built-in AI ("summarize this page") will commoditize the *Summary* tab within a year — which is why the redline, sentiment overlay, and evidence-verified analyst read (things generic AI can't do in-place) must be the identity.

**Devil's advocate — the weak points:**

1. **"Privacy for public documents" invites an eye-roll** unless you explicitly market the *research-trail* argument. The landing copy must say "what you research reveals your strategy," not just "your data stays local."
2. **Quality ceiling is real.** Gemini Nano + a 3.6k-char excerpt budget produces a visibly shallower read than GPT-class cloud tools, and the extractive-tier majority gets templated cards (§5.1). The counter is trust engineering + deterministic features (redline, XBRL facts) — lean on what's *verifiably correct* rather than competing on prose.
3. **Distribution is hard.** Chrome-only, 131 MB install, and the builtin tier needs recent Chrome + hardware. No virality loop; nobody searches the Web Store for "SEC filing analyzer" in volume. Realistic channels: HN/Show HN (the zero-egress engineering is a genuinely good post), FinTwit, r/SecurityAnalysis, accounting/audit communities.
4. **Willingness to pay is bimodal:** retail pays ~$0; professionals pay well but procure via IT — which, conveniently, is exactly who the zero-egress architecture is designed to convince. If monetization matters, the shape is a free core + a paid "professional" tier (multi-filing redline history, XBRL fact sheets, export packs, team policy docs).
5. **A platform-risk footnote:** the moat narrows as Chrome's built-in AI gets a bigger context window and every browser grows a "summarize" button. The durable assets are the positionMap/overlay engine, the redline pipeline, and the trust architecture — invest there, not in more prose generation.

**Strongest wedge, stated once:** *"The YoY redline you'd pay BamSEC for, plus an evidence-verified analyst read — free, on the EDGAR page itself, with provably zero egress."* Lead with the redline in every screenshot and demo; it's the feature with no free substitute.

---

*Deliverable 7 (context blurb) saved separately to [relic-context.md](relic-context.md).*
