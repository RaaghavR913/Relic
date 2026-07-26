# Relic — Chrome Web Store Readiness Checklist

Version 3.1.6 · commit `d383a57` · audited 2026-07-26. Verdicts: **PASS** / **FAIL** / **UNVERIFIED** / **ACTION** (non-code submission step the developer must complete). Evidence cites `file:line` or an AUDIT.md finding ID.

## Program Policies

| # | Policy | Verdict | Evidence |
|---|---|---|---|
| 1 | **Manifest V3** (no persistent background, event SW) | **PASS** | `manifest.json:2` MV3; `background.service_worker` module (`:40`); top-level listeners (`service-worker.ts:72,342`). |
| 2 | **No remotely hosted code** | **PASS** | Phase 1.1/1.2: zero runtime fetch of executable content; jsPDF+transformers.js CDN loaders excised (`vite.config.ts:163-228`), re-asserted by `verify-dist.mjs:160-187`; huggingface host rewritten to `.invalid`. `script-src 'self' 'wasm-unsafe-eval'` (no `unsafe-eval`). |
| 3 | **Single purpose** (clear, narrow) | **PASS** | `CWS_SUBMISSION.md:8-13` — "analyzes SEC/EDGAR filings and comparable investor documents on-device." Behavior matches (content script on sec.gov; on-device analysis panels). |
| 4 | **Minimum permissions** | **PASS** | Phase 1.6: all 5 permissions (`storage`, `sidePanel`, `activeTab`, `offscreen`, `scripting`) have call sites; none orphaned. No `tabs`, no `<all_urls>`, no `unlimitedStorage`. |
| 5 | **Host permissions minimal at install** | **PASS** | Only `https://*.sec.gov/*` at install (`manifest.json:23-25`); 11 financial hosts are `optional_host_permissions` requested via `chrome.permissions.request()` on user action (`:26-38`, `service-worker.ts:298`). Minimal install prompt. |
| 6 | **`activeTab`/`scripting` used as justified** | **PASS** | Toolbar-click gesture → `executeScript(files:[CONTENT_SCRIPT_FILE])` static (`service-worker.ts:90,326,58`); no `func:`/dynamic files. Justification `CWS_SUBMISSION.md:35-44`. |
| 7 | **User data — no collection/transmission** | **PASS** | Phase 1.5: only egress is `*.sec.gov` (prior-filing data, user-initiated, toggle-off `RedlinePanel.tsx:356`); no telemetry/analytics/beacon/WS/remote-font. On-device models (`transformersEnv.ts:21` `allowRemoteModels=false`). |
| 8 | **Data-use certifications** (no sale, no unrelated use, no creditworthiness) | **PASS** (attest in dashboard) | `PRIVACY.md:66-70`, `CWS_SUBMISSION.md:74-80`. Consistent with observed behavior (no data leaves device). |
| 9 | **Privacy policy** present & accurate | **PASS (content)** / **ACTION (host)** | `PRIVACY.md` accurate vs behavior (Phase 1.7). Must be hosted at a public URL and pasted into the listing — `STORE_LISTING.md:171`, `CWS_SUBMISSION.md:82-85`. |
| 10 | **Metadata accuracy** (listing matches behavior) | **PASS** (1 LOW note) | Phase 1.7 — all major claims supported. Note **P1-03**: "only network request is to SEC.gov" omits the same-origin PDF re-read (`content/ingest/pdf.ts:87`); no data egress, but worth a footnote. |
| 11 | **No investment advice** (content policy + own disclaimer) | **PASS** (1 LOW note) | Two-layer guardrail: prompt (`prompts.ts:25`) + post-gen `scrubAdvice` filter (`evidence.ts:89-103`) removing buy/sell/short/hold + directional predictions; disclaimer `prompts.ts:16`. Note **P3-02**: explicit "price target" phrasing not pattern-matched. |
| 12 | **Content Security Policy** hardened | **PASS** (1 LOW note) | `default-src 'none'`, `connect-src 'self' https://*.sec.gov`, `object-src`/`base-uri`/`form-action` pinned (`manifest.json:15`). Note **P1-04**: `object-src`/`frame-src` could tighten to `'none'`. |
| 13 | **Cross-origin isolation** (COOP/COEP) valid | **PASS** | `manifest.json:17-22` COOP `same-origin` + COEP `require-corp`; guarded by `verify-dist.mjs:77-82`. Enables threaded ORT. |
| 14 | **No obfuscated code** (minified OK) | **PASS** | Production build minified, not obfuscated; sourcemaps dev-only (`vite.config.ts:325`); `verify-dist.mjs:153-158` blocks `.map` in prod. |
| 15 | **Package: no secrets / sourcemaps / dev code** | **PASS** | Own scan: `dist/` has no `import.meta.env`, no `debugLog`, no bare `console.log`, no `.map`; dev-force UI stripped. Only intentional `console.warn/error` in catch handlers. (Phase 5 subagent corroborates full inventory.) |
| 16 | **Package size within limits** | **PASS** | 171 MB unpacked (Phase 0.4); far under the CWS package ceiling. Compressed upload zip size measured in Phase 5.5. |
| 17 | **Icons & required assets** | **PASS** (assets) / **ACTION (screenshots)** | 16/32/48/128 icons validated by `verify-dist.mjs:128-151`. Store screenshots (1280×800) still to be captured — `STORE_LISTING.md:113`, `CWS_SUBMISSION.md:94`. |
| 18 | **Reproducible / clean build** | **PASS** | Phase 0.4: two clean builds byte-identical; no build-time network; `verify-dist` gate passes. |

## Blocking status

**No policy FAILs.** Remaining items before submission are **ACTION** steps (not code defects):

- **ACTION-1** — Host `PRIVACY.md` at a public URL; paste into the listing's Privacy policy field.
- **ACTION-2** — Capture ≥1 store screenshot (1280×800) per `STORE_LISTING.md:113-138`.
- **ACTION-3** — In the dashboard: paste permission justifications (`CWS_SUBMISSION.md:22-70`) and check the four data-use certifications.
- **ACTION-4** — Zip **the contents of `dist/`** (not the folder), excluding `.DS_Store` (see Phase 5).

Optional pre-submit hardening (all LOW, none blocking): P1-03 (privacy copy footnote), P1-04 (tighten `object-src`/`frame-src`), P3-02 (price-target filter), P6-01 (cache version-keying).

_Store-policy verdict: **READY** pending the four ACTION items; no code changes are required to pass review._
