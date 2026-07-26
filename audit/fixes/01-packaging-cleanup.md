# Fix 01 — Remove stray files from the build output

**Finding:** P4-02 (LOW) — packaging cleanliness.
**Execution order:** 1 (do before packaging the CWS zip).

## Problem
Two non-runtime files leak into `dist/` via Vite's `publicDir`:
- `public/.DS_Store` (6148 B) is copied to `dist/.DS_Store` on **every** build (verified byte-identical). macOS junk in the uploaded package.
- `public/icons/icon-source.png` (1024²) is copied to `dist/icons/icon-source.png`. It is only the **input** to `scripts/generate-icons.mjs:12`, not a runtime asset.

## Files to touch
- `public/.DS_Store` — delete.
- `public/icons/icon-source.png` — move OUT of `public/` (e.g. to `assets-src/icon-source.png`).
- `scripts/generate-icons.mjs` — update the source path (currently reads `public/icons/icon-source.png` near line 12) to the new location.
- `.gitignore` — already ignores `.DS_Store`; add a note. Optionally add a guard in `scripts/verify-dist.mjs` that fails if any `.DS_Store` exists under `dist/`.

## Do NOT touch
- `public/icons/icon16.png`, `icon32.png`, `icon48.png`, `icon128.png` (runtime + manifest icons).
- The manifest `icons`/`action.default_icon` blocks.
- Any other file under `public/`.

## Acceptance criteria
1. `rm -f public/.DS_Store` and a clean `npm run build`, then `find dist -name .DS_Store` prints nothing.
2. `ls dist/icons/` shows exactly `icon16.png icon32.png icon48.png icon128.png` (no `icon-source.png`).
3. `node scripts/generate-icons.mjs` still regenerates the four icons from the moved source without error.
4. `npm run build` prints `✓ verify-dist: … looks shippable`.
