/**
 * ONNX Runtime asset-shipping invariants (Bug 2 regression).
 *
 * The sentiment/encoder workers failed with "no available backend found" /
 * "Failed to fetch dynamically imported module .../ort-wasm-simd-threaded.asyncify.mjs"
 * because the build copied only the ORT `.wasm` binaries and not the ES-module
 * GLUE files (`.mjs`) that onnxruntime-web dynamically imports at runtime.
 *
 * Two layers of defense:
 *   1. Source invariant (always runs): every ORT backend glue+binary in the
 *      installed package matches the build's copy regex — so a future "only copy
 *      .wasm" mistake fails here without needing a build.
 *   2. Dist assertion (runs only when dist/ has been built): every ort-wasm-*
 *      module referenced by the built worker bundles actually exists in dist/wasm/
 *      (or dist/assets/). This is the end-to-end guard for CI after `npm run build`.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const ORT_DIR = path.resolve(
  ROOT,
  'node_modules/@huggingface/transformers/node_modules/onnxruntime-web/dist',
);
const DIST = path.resolve(ROOT, 'dist');
const DIST_WASM = path.join(DIST, 'wasm');
const DIST_ASSETS = path.join(DIST, 'assets');

/** The regex the build uses to select ORT assets to copy (keep in sync with vite.config.ts). */
const ORT_ASSET_RE = /^ort-wasm-simd-threaded(\.asyncify)?\.(mjs|wasm)$/;

/** Backend pairs Relic actually loads: CPU/WASM ('') and the Asyncify-based WebGPU path. */
const REQUIRED_VARIANTS = ['', '.asyncify'] as const;

/**
 * Pairs onnxruntime-web ships that NO built worker chunk imports, so the build
 * deliberately does not copy them (~41 MB of dead weight in the CWS upload).
 * Verified empirically: with both pairs deleted, the encoder and FinBERT workers
 * still reached `webgpu: ok` against a live adapter, fetching only asyncify.wasm.
 */
const EXCLUDED_VARIANTS = ['.jsep', '.jspi'] as const;

const PAIR_EXTS = ['mjs', 'wasm'] as const;

const distBuilt = fs.existsSync(DIST_ASSETS) && fs.existsSync(DIST_WASM);

describe('ORT package source invariant', () => {
  it('every backend glue (.mjs) ships next to a matching binary (.wasm)', () => {
    if (!fs.existsSync(ORT_DIR)) {
      throw new Error(`onnxruntime-web dist not found at ${ORT_DIR} — run npm install`);
    }
    const files = fs.readdirSync(ORT_DIR);
    const wasms = files.filter((f) => /^ort-wasm-simd-threaded.*\.wasm$/.test(f));
    const mjss = files.filter((f) => /^ort-wasm-simd-threaded.*\.mjs$/.test(f));

    // Sanity: the package actually ships glue modules (the thing we used to drop).
    expect(mjss.length).toBeGreaterThan(0);
    expect(wasms.length).toBeGreaterThan(0);

    // The pairs we DO load must exist in the package and be selected by the copy regex.
    for (const v of REQUIRED_VARIANTS) {
      for (const ext of PAIR_EXTS) {
        const f = `ort-wasm-simd-threaded${v}.${ext}`;
        expect(files.includes(f), `${f} missing from the onnxruntime-web package`).toBe(true);
        expect(ORT_ASSET_RE.test(f), `${f} must be copied by the build`).toBe(true);
      }
    }

    // The unused pairs must NOT be selected — this is what keeps ~41 MB out of the zip.
    // If a future ORT version actually starts loading one of these, this assertion is
    // the tripwire: widen ORT_ASSET_RE here AND in vite.config.ts together.
    for (const v of EXCLUDED_VARIANTS) {
      for (const ext of PAIR_EXTS) {
        const f = `ort-wasm-simd-threaded${v}.${ext}`;
        expect(ORT_ASSET_RE.test(f), `${f} must NOT be copied by the build`).toBe(false);
      }
    }

    // For each .wasm there is a same-named .mjs glue (the pair that must ship together).
    for (const w of wasms) {
      const glue = w.replace(/\.wasm$/, '.mjs');
      expect(mjss.includes(glue), `missing glue ${glue} for ${w}`).toBe(true);
    }
  });
});

describe.skipIf(!distBuilt)('dist ships every referenced ORT module', () => {
  /** Names like ort-wasm-simd-threaded.asyncify.mjs referenced inside built bundles. */
  function referencedOrtModules(): Set<string> {
    const refs = new Set<string>();
    const re = /ort-wasm-simd-threaded[\w.]*\.(?:mjs|wasm)/g;
    const scan = (dir: string) => {
      if (!fs.existsSync(dir)) return;
      for (const f of fs.readdirSync(dir)) {
        if (!f.endsWith('.js') && !f.endsWith('.mjs')) continue;
        const body = fs.readFileSync(path.join(dir, f), 'utf8');
        for (const m of body.matchAll(re)) refs.add(m[0]);
      }
    };
    scan(DIST_ASSETS);
    return refs;
  }

  it('resolves every referenced glue/binary to dist/wasm or dist/assets', () => {
    const refs = referencedOrtModules();
    // The worker bundles must reference at least the threaded glue we depend on.
    expect(refs.size).toBeGreaterThan(0);

    const existsSomewhere = (name: string) =>
      fs.existsSync(path.join(DIST_WASM, name)) || fs.existsSync(path.join(DIST_ASSETS, name));

    const missing = [...refs].filter((name) => !existsSomewhere(name));
    expect(missing, `referenced but missing from dist: ${missing.join(', ')}`).toEqual([]);
  });

  it('ships exactly the backend pairs the workers load — and not the unused ones', () => {
    // Both loaded pairs must be present: the WASM fallback glue (the file the original
    // runtime error named) and the Asyncify pair that backs the WebGPU path.
    for (const v of REQUIRED_VARIANTS) {
      for (const ext of PAIR_EXTS) {
        const name = `ort-wasm-simd-threaded${v}.${ext}`;
        expect(fs.existsSync(path.join(DIST_WASM, name)), `${name} missing from dist/wasm`).toBe(true);
      }
    }
    // And the unused pairs must not be shipped (end-to-end guard for the ~41 MB trim).
    for (const v of EXCLUDED_VARIANTS) {
      for (const ext of PAIR_EXTS) {
        const name = `ort-wasm-simd-threaded${v}.${ext}`;
        expect(
          fs.existsSync(path.join(DIST_WASM, name)),
          `${name} should not ship — no worker chunk imports it`,
        ).toBe(false);
      }
    }
  });
});
