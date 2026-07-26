# Fix 02 — Remove unused dependencies

**Finding:** P4-03 (MEDIUM), P4-04 (LOW) — dependency hygiene.
**Execution order:** 2.

## Problem
Four declared dependencies are not used by the build or runtime:
- **`onnxruntime-web`** (`dependencies`, `^1.26.0`): the ORT that actually ships is the **nested** copy at `node_modules/@huggingface/transformers/node_modules/onnxruntime-web` (verified version `1.26.0-dev.20260416`). `vite.config.ts:44` copies the WASM from that nested path, and transformers.js resolves its own nested copy for JS. The top-level `^1.26.0` is never referenced and does not dedupe with the nested dev-snapshot.
- **`vite-plugin-static-copy`** (`devDependencies`): replaced by the custom `copyWasmPlugin`; only a stale comment mentions it (`vite.config.ts:32`).
- **`autoprefixer`**, **`postcss`** (`devDependencies`): there is no `postcss.config.*` or `tailwind.config.*`; Tailwind v4 via `@tailwindcss/vite` needs neither.

## Files to touch
- `package.json` — remove the four entries above.
- `package-lock.json` — regenerate via `npm install`.
- `vite.config.ts` — update the stale `vite-plugin-static-copy` and "onnxruntime-web 1.22" comments (`:31-46,190`) to reflect the nested `1.26.0-dev` reality.

## Do NOT touch
- `@huggingface/transformers` (provides the nested `onnxruntime-web` that ships — removing ORT there would break inference).
- `tailwindcss`, `@tailwindcss/vite` (Tailwind is used via `@import "tailwindcss"` in `sidepanel/index.css:1`).
- Any other dependency.

## Acceptance criteria
1. After `npm install` + `npm run build`, `dist/wasm/` still contains `ort-wasm-simd-threaded.{mjs,wasm}` and `ort-wasm-simd-threaded.asyncify.{mjs,wasm}`.
2. `npm run build` prints `✓ verify-dist: … looks shippable`.
3. `npm test` passes.
4. `grep -rE "onnxruntime-web|vite-plugin-static-copy|autoprefixer|\bpostcss\b" src/ *.config.ts` returns no *import* (comments/plugin-internals aside).
