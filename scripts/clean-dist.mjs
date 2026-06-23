// ============================================================
// Disclora — pre-build dist cleaner (runs BEFORE `vite build`)
// ------------------------------------------------------------
// Guarantees a HERMETIC build: dist/ ends up containing only what the current
// build produced. Without this, dist/ silently accumulates artifacts across
// builds because vite-plugin-web-extension forces `emptyOutDir: false` — it runs
// several sequential sub-builds into one dir, so auto-emptying would clobber the
// output of earlier sub-builds. Net effect: a build just layers on top of
// whatever the previous build (or a `npm run dev` watch) left behind.
//
// The symptom this was written for: a production `npm run build` failing
// verify-dist's "no sourcemaps" gate because a prior `npm run dev`
// (--mode development → sourcemaps ON) had left .map files in the shared dist/.
//
// We delete everything in dist/ EXCEPT the dirs in PRESERVE — currently just
// models/. The 131 MB of on-device ONNX weights are copied verbatim from the repo
// `models/` dir and cached across builds via a sentinel check in copyModelsPlugin
// (vite.config.ts); wiping them would force a multi-second 131 MB re-copy on every
// build. Pass `--all` (or set CLEAN_ALL=1) to drop models/ too — use that after
// the repo weights change, since the sentinel only checks existence, not freshness.
//
// Runs ONCE, before any vite sub-build, so it can never clobber build output.
// Complements scripts/verify-dist.mjs (the post-build OUTPUT gate).
// ============================================================

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');

// Dirs the build caches across runs (expensive to regenerate). Preserved unless --all.
const PRESERVE = new Set(['models']);
const cleanAll = process.argv.includes('--all') || process.env.CLEAN_ALL === '1';

if (!fs.existsSync(DIST)) {
  console.log('• clean-dist: dist/ does not exist yet — nothing to clean.');
  process.exit(0);
}

let removed = 0;
for (const entry of fs.readdirSync(DIST)) {
  if (!cleanAll && PRESERVE.has(entry)) continue;
  fs.rmSync(path.join(DIST, entry), { recursive: true, force: true });
  removed++;
}

const kept = cleanAll ? [] : [...PRESERVE].filter((d) => fs.existsSync(path.join(DIST, d)));
console.log(
  `✓ clean-dist: removed ${removed} dist/ entr${removed === 1 ? 'y' : 'ies'}; ` +
    `kept ${kept.length ? kept.join(', ') : 'nothing'}.`,
);
