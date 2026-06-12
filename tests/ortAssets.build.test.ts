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
const ORT_ASSET_RE = /^ort-wasm-simd-threaded.*\.(mjs|wasm)$/;

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

    // Every glue + binary is selected by the copy regex.
    for (const f of [...wasms, ...mjss]) {
      expect(ORT_ASSET_RE.test(f), `${f} must be copied by the build`).toBe(true);
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

  it('ships the WASM backend glue specifically (the file the runtime error named)', () => {
    const required = [
      'ort-wasm-simd-threaded.mjs', // WASM fallback glue
      'ort-wasm-simd-threaded.wasm',
    ];
    for (const name of required) {
      expect(fs.existsSync(path.join(DIST_WASM, name)), `${name} missing from dist/wasm`).toBe(true);
    }
  });
});
