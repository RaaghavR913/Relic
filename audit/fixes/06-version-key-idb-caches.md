# Fix 06 — Version-key the IndexedDB caches so a schema change auto-invalidates

**Finding:** P6-01 (LOW/MEDIUM) — no cache migration / stale-cache-on-update risk.
**Execution order:** 6.

## Problem
The four cache DBs are pinned at `DB_VERSION = 1` with a create-only `onupgradeneeded`, and their entries are keyed only by content hash (`rawTextHash`) (+ tier for analyses). There is no app/schema-version component. A future update that changes the shape of a stored object (analysis / summary / sentiment / redline) would read old-shaped entries as-is — stale or mis-rendered results — until the user manually runs Settings → *Cached analyses → Clear*.

- `src/redline/redlineStore.ts:18-19` (`relic-redlines`, `DB_VERSION=1`)
- `src/analyst/analysisStore.ts:14-15` (`relic-analyses`)
- `src/db/sentimentStore.ts:12-13` (`relic-sentiment`)
- `src/summarizer/summaryStore.ts:14-15` (`relic-summaries`)

## Approach (pick ONE; A is lowest-risk)
**A. Add a schema-version segment to every cache key.** Introduce a shared constant, e.g. `export const CACHE_SCHEMA_VERSION = 2;` in a small module (`src/shared/cacheVersion.ts`), and prefix it into each store's key (e.g. `` `${CACHE_SCHEMA_VERSION}:${rawTextHash}` ``). Bumping the constant when a stored shape changes makes old entries unreachable (they age out via `idbEvict`).

**B. Bump `DB_VERSION` and drop the store in `onupgradeneeded`** for any DB whose shape changed, recreating it empty.

## Files to touch
- New: `src/shared/cacheVersion.ts` (approach A).
- `src/redline/redlineStore.ts`, `src/analyst/analysisStore.ts`, `src/db/sentimentStore.ts`, `src/summarizer/summaryStore.ts` — thread the version into the key (A) or the DB version (B).
- Corresponding `get`/`put` call sites and any tests that assert cache keys.

## Do NOT touch
- `src/shared/clearCaches.ts` `CACHE_DB_NAMES` (the manual clear stays as a safety net).
- The eviction logic in `src/lib/idbEvict.ts`.

## Acceptance criteria
1. `npm test` passes (update key-format assertions as needed).
2. Bumping `CACHE_SCHEMA_VERSION` (or `DB_VERSION`) causes a fresh read to miss the old entry and recompute (add a test that writes at v1, bumps, and asserts a miss at v2).
3. `npm run build` passes `verify-dist`.
