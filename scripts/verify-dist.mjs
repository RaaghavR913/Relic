// ============================================================
// Relic — production dist sanity gate (runs after `vite build`)
// ------------------------------------------------------------
// Catches "builds clean but ships broken" classes of failure before a zip is
// ever uploaded: missing manifest entry files, missing/empty model weights,
// missing ORT backend glue, a weakened CSP, or stray sourcemaps. Exits non-zero
// with a list of problems so CI / a pre-submit step fails loudly.
//
// Complements:
//   - vite.config.ts copyModels/copyWasm plugins (fail the build if SOURCE assets
//     are absent) — this checks the OUTPUT.
//   - tests/ortAssets.build.test.ts (test-time guard) — this is the build-time guard.
// ============================================================

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');

const errors = [];
const fail = (m) => errors.push(m);
const distHas = (p) => fs.existsSync(path.join(DIST, p));

function walk(dir, onFile) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const fp = path.join(dir, e.name);
    if (e.isDirectory()) walk(fp, onFile);
    else onFile(fp);
  }
}

if (!fs.existsSync(DIST)) {
  console.error('✗ verify-dist: dist/ not found — run `npm run build` first.');
  process.exit(1);
}

// ── 1. manifest + every entry file it names ──────────────────────────────────
let manifest;
try {
  manifest = JSON.parse(fs.readFileSync(path.join(DIST, 'manifest.json'), 'utf8'));
} catch (e) {
  console.error('✗ verify-dist: dist/manifest.json missing or invalid:', String(e));
  process.exit(1);
}

const entryPaths = [
  manifest.background?.service_worker,
  ...(manifest.content_scripts ?? []).flatMap((cs) => cs.js ?? []),
  manifest.side_panel?.default_path,
  'src/offscreen/offscreen.html', // additionalInput, not in manifest
];
for (const p of entryPaths) {
  if (!p) fail('a manifest entry has no path');
  else if (!distHas(p)) fail(`manifest entry file not in dist: ${p}`);
}

// ── 2. CSP + host_permissions integrity (defense against accidental loosening) ─
const csp = manifest.content_security_policy?.extension_pages ?? '';
if (!/wasm-unsafe-eval/.test(csp)) fail('CSP is missing wasm-unsafe-eval (ORT WASM will not run)');
if (!/connect-src[^;]*sec\.gov/.test(csp)) fail('CSP connect-src no longer restricts to sec.gov');
// default-src 'none' is the load-bearing part of the "zero egress by construction" claim:
// without it, img-src/media-src/font-src/style-src/frame-src all fall back to allow-all, so a
// script could exfiltrate via <img src=...>, a remote stylesheet, etc. connect-src alone is not enough.
if (!/default-src\s+'none'/.test(csp)) fail("CSP no longer sets default-src 'none' — non-connect fetch directives fall open (img/media/font/style/frame egress)");
// form-action does NOT fall back to default-src, so it must be pinned explicitly or a
// <form> could POST the filing to any origin even with default-src 'none'.
if (!/form-action\s+'none'/.test(csp)) fail("CSP no longer sets form-action 'none' — a form could POST data off-device (form-action does not inherit default-src)");
if (!(manifest.host_permissions ?? []).some((h) => /sec\.gov/.test(h))) {
  fail('host_permissions no longer includes sec.gov');
}

// COOP + COEP enable cross-origin isolation, which unlocks multi-threaded ORT for
// the WASM sentiment path. Dropping them still "builds", but sentiment silently
// falls back to single-threaded (minutes on a large 10-K) — guard them like the CSP.
if (manifest.cross_origin_embedder_policy?.value !== 'require-corp') {
  fail('cross_origin_embedder_policy is not "require-corp" — threaded ORT disabled (crossOriginIsolated=false)');
}
if (manifest.cross_origin_opener_policy?.value !== 'same-origin') {
  fail('cross_origin_opener_policy is not "same-origin" — threaded ORT disabled (crossOriginIsolated=false)');
}

// ── 3. model weights present and non-trivial ─────────────────────────────────
const modelsDir = path.join(DIST, 'models');
if (!fs.existsSync(modelsDir)) {
  fail('dist/models/ missing — run `npm run fetch-models` then rebuild');
} else {
  const onnx = [];
  walk(modelsDir, (f) => f.endsWith('.onnx') && onnx.push(f));
  if (onnx.length === 0) fail('no .onnx weights under dist/models/');
  for (const f of onnx) {
    const size = fs.statSync(f).size;
    if (size < 1_000_000) fail(`ONNX weight suspiciously small (<1MB): ${path.relative(DIST, f)} (${size}B)`);
  }
}

// ── 4. ORT backend glue ships next to every binary ───────────────────────────
const wasmDir = path.join(DIST, 'wasm');
if (!fs.existsSync(wasmDir)) {
  fail('dist/wasm/ missing — ORT backends cannot load');
} else {
  const files = fs.readdirSync(wasmDir);
  const wasms = files.filter((f) => /^ort-wasm-simd-threaded.*\.wasm$/.test(f));
  if (wasms.length === 0) fail('no ort-wasm-*.wasm binaries in dist/wasm/');
  for (const w of wasms) {
    const glue = w.replace(/\.wasm$/, '.mjs');
    if (!files.includes(glue)) fail(`ORT binary ${w} is missing its ${glue} glue (runtime import 404)`);
  }
}

// ── 5. extension icons are real assets, not 1×1 placeholders ───────────────────
function pngDimensions(fp) {
  const buf = fs.readFileSync(fp);
  if (buf.length < 24 || buf.toString('ascii', 1, 4) !== 'PNG') return null;
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}

const iconSets = [manifest.icons, manifest.action?.default_icon].filter(Boolean);
for (const set of iconSets) {
  for (const [size, rel] of Object.entries(set)) {
    const fp = path.join(DIST, rel);
    if (!fs.existsSync(fp)) {
      fail(`icon missing from dist: ${rel} (manifest ${size})`);
      continue;
    }
    const dim = pngDimensions(fp);
    const expected = Number(size);
    if (!dim || dim.w < 8 || dim.h < 8) {
      fail(`icon ${rel} looks like a placeholder (${dim?.w ?? '?'}×${dim?.h ?? '?'}) — rebuild after updating public/icons/`);
    } else if (Number.isFinite(expected) && (dim.w !== expected || dim.h !== expected)) {
      fail(`icon ${rel} is ${dim.w}×${dim.h}, manifest expects ${expected}×${expected}`);
    }
  }
}

// ── 6. no sourcemaps in a production dist ─────────────────────────────────────
const maps = [];
walk(DIST, (f) => f.endsWith('.map') && maps.push(path.relative(DIST, f)));
if (maps.length > 0) {
  fail(`production dist ships ${maps.length} sourcemap(s) — e.g. ${maps.slice(0, 3).join(', ')} (try a clean rebuild)`);
}

// ── 7. no remote-code loader URLs in shipped JS ───────────────────────────────
// CWS rejected v1.2.7 ("Blue Argon"): MV3 forbids remotely hosted code, and the
// reviewer's static scan flags CDN script/wasm URLs even in unreachable
// branches (jsPDF's pdfobjectnewwindow, transformers.js's jsdelivr wasm
// fallback — both excised by stripRemoteCodeLoadersPlugin in vite.config.ts).
// This makes the failure class unshippable: any code-hosting CDN host, or any
// absolute URL ending in .js/.mjs/.wasm, in an emitted script fails the build.
const REMOTE_CODE_HOSTS =
  /cdnjs\.cloudflare\.com|cdn\.jsdelivr\.net|unpkg\.com|raw\.githubusercontent\.com|cdn\.skypack\.dev|esm\.sh/;
// Matching every URL ending in ".js" is too noisy — doc links to projects
// *named* something.js (github.com/…/transformers.js, huggingface.co/docs/
// transformers.js) live in library error messages. Restrict to unambiguous
// code fetches (.min.js/.mjs/.wasm); plain-.js script CDNs are covered by the
// host denylist above.
const REMOTE_CODE_FILE = /https?:\/\/[^\s"'`)]+\.(?:min\.js|mjs|wasm)\b/;
const modelsPrefix = path.join(DIST, 'models') + path.sep;
walk(DIST, (f) => {
  if (!/\.m?js$/.test(f) || f.startsWith(modelsPrefix)) return;
  const text = fs.readFileSync(f, 'utf8');
  const hit = text.match(REMOTE_CODE_HOSTS) ?? text.match(REMOTE_CODE_FILE);
  if (hit) {
    fail(
      `remote-code URL in shipped JS: ${path.relative(DIST, f)} contains "${hit[0]}" ` +
        '(MV3 forbids remotely hosted code — see stripRemoteCodeLoadersPlugin in vite.config.ts)',
    );
  }
});

// ── report ───────────────────────────────────────────────────────────────────
if (errors.length > 0) {
  console.error(`\n✗ verify-dist: ${errors.length} problem(s) in dist/:`);
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}
console.log('✓ verify-dist: dist/ looks shippable (manifest entries, icons, models, ORT glue+binary, CSP, no sourcemaps, no remote-code URLs).');
