# Fix 04 — Tighten CSP `object-src` and `frame-src` to `'none'`

**Finding:** P1-04 (LOW) — defense-in-depth CSP hardening.
**Execution order:** 4.

## Problem
The extension-pages CSP sets `object-src 'self'` and `frame-src 'self'`, but no extension page creates an `<object>`, `<embed>`, or `<iframe>` (the only reference is a comment in `content/ingest/dom-root.ts:4` about reading EDGAR's *page* iframes, which is governed by the page CSP, not the extension CSP). Both directives can be `'none'` for a minimal policy.

## Files to touch
- `manifest.json:15` — in `content_security_policy.extension_pages`, change:
  - `object-src 'self'` → `object-src 'none'`
  - `frame-src 'self'` → `frame-src 'none'`

## Do NOT touch
- Every other CSP directive: `default-src 'none'`, `script-src 'self' 'wasm-unsafe-eval'`, `connect-src 'self' https://*.sec.gov`, `img-src 'self' data:`, `style-src 'self' 'unsafe-inline'`, `font-src 'self'`, `worker-src 'self'`, `form-action 'none'`, `base-uri 'none'`. (`verify-dist.mjs` guards several of these; do not weaken any.)
- COOP/COEP.

## Acceptance criteria
1. `npm run build` passes `verify-dist`.
2. Load the built extension unpacked (`MANUAL_TEST.md` §0) and run a full pass — open the side panel, analyze a 10-K on EDGAR, run Summary/Sentiment/Analyst/Redline, and open a PDF filing. **No new CSP-violation errors** appear in the service-worker, offscreen, side-panel, or page consoles.
3. WebGPU and WASM inference both still initialize (the workers/offscreen do not use frames/objects, so this is a regression check only).
