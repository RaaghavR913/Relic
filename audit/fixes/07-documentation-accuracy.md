# Fix 07 — Documentation & comment accuracy (no behavior change)

**Findings:** P1-03 (LOW), P1-05 (LOW), P5-01 (LOW). Three non-behavioral prose corrections. Each part is independently applicable.
**Execution order:** 7.

## Part A — Privacy/store copy: note the same-origin PDF re-read (P1-03)
The copy states "the only network request Relic makes is to SEC.gov" (`STORE_LISTING.md:82`, echoed in `PRIVACY.md:32-36`). When analyzing a PDF, the content script also issues a **same-origin** `XMLHttpRequest` to re-read the current document's bytes (`src/content/ingest/pdf.ts:87`). No data leaves the device, but a reviewer watching network traffic on a non-SEC financial PDF will see a request the copy doesn't mention.
- **Files:** `PRIVACY.md`, `STORE_LISTING.md`.
- **Change:** add one sentence, e.g. "When you analyze a PDF, Relic re-reads that same document's bytes locally (a same-origin request to the page you're already on) to extract its text; nothing is sent anywhere."
- **Do NOT** change any factual claim about SEC.gov being the only *external/cross-origin* request.

## Part B — Correct the load-bearing XSS-safety comment (P1-05)
`src/content/highlight/flagOverlay.ts:221-222` comments that `flag.term`/`flag.note` "come from bundled lexicons only; no user-supplied or filing-page content." That is **false** — `flag.term` is `match[0]`, i.e. page-derived filing text (`src/flagging/flagLanguage.ts:92`). The `innerHTML` at `:223` is safe **only because** `escHtml()` (`:242-248`) escapes it.
- **Files:** `src/content/highlight/flagOverlay.ts` (comment only — do NOT change the code).
- **Change:** rewrite the comment to state that `flag.term`/`flag.note` are page-derived and that `escHtml()` is load-bearing (must not be removed).
- **Optional:** add a test asserting a `flag.term` containing `<img src=x onerror=...>` renders escaped (no live element) via the tooltip path.

## Part C — Update or date-stamp stale review docs (P5-01)
`REVIEW.md` (and the similarly dated `relic-review.md`) describe a **superseded** build: H1 flags `web_accessible_resources` granting `*.fool.com`/`*.seekingalpha.com`, H2 flags a 114 MB zip with **four** ORT WASM variants (`REVIEW.md:30-31,59-63`). The current build has **no** `web_accessible_resources`, sec.gov-only host permissions, **two** WASM binaries, and a 105 MiB zip — both HIGH issues are already resolved.
- **Files:** `REVIEW.md`, `relic-review.md`.
- **Change:** update to the current build state, or add a header dating them to the old build and noting H1/H2 are resolved. (These docs are not shipped to the store, so this is repo hygiene.)

## Do NOT touch
- Any executable code in `flagOverlay.ts` (Part B is comment-only).
- The `dist/` output.

## Acceptance criteria
1. Part A: `PRIVACY.md`/`STORE_LISTING.md` mention the same-origin PDF re-read; the SEC.gov external-request claim is unchanged.
2. Part B: the `flagOverlay.ts` comment no longer claims "no filing-page content"; `npm run build` + `npm test` still pass (comment-only change).
3. Part C: `REVIEW.md`/`relic-review.md` no longer describe 4 WASM variants or `web_accessible_resources` as current.
