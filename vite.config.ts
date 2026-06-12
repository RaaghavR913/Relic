import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import webExtension from 'vite-plugin-web-extension';
import path from 'path';
import fs from 'fs';

// ── Custom plugin: copy ONNX Runtime WASM binaries to dist/wasm/ (flat) ────────
// vite-plugin-static-copy preserves nested directory structure; this plugin does
// a direct fs.copyFile into the flat dest directory instead.
//
// CRITICAL: onnxruntime-web 1.22 loads each backend through an ES-module GLUE file
// (ort-wasm-simd-threaded.{,asyncify,jsep,jspi}.mjs) which it dynamically imports
// at runtime; that glue then fetches the matching .wasm binary. ORT resolves the
// glue URL as `${wasm.wasmPaths}<name>.mjs`, and our workers set wasmPaths to
// chrome.runtime.getURL('wasm/'). So BOTH the .mjs and the .wasm must live in
// dist/wasm/. Copying only the .wasm (the old behavior) left the glue missing and
// produced: "no available backend found" / "Failed to fetch dynamically imported
// module .../ort-wasm-simd-threaded.asyncify.mjs". Always copy them as a pair.
function copyWasmPlugin(isProd: boolean): Plugin {
  const ORT_WASM_DIR = path.resolve(
    __dirname,
    'node_modules/@huggingface/transformers/node_modules/onnxruntime-web/dist',
  );
  // Match every backend glue (.mjs) + binary (.wasm) the loader can request.
  const ORT_ASSET_RE = /^ort-wasm-simd-threaded.*\.(mjs|wasm)$/;

  return {
    name: 'copy-ort-wasm',
    apply: 'build',
    closeBundle() {
      const outDir = path.resolve(__dirname, 'dist/wasm');
      fs.mkdirSync(outDir, { recursive: true });

      let copied = 0;
      if (fs.existsSync(ORT_WASM_DIR)) {
        for (const file of fs.readdirSync(ORT_WASM_DIR)) {
          if (!ORT_ASSET_RE.test(file)) continue;
          // Skip sourcemaps for the glue modules (e.g. *.mjs.map) — runtime never needs them.
          if (file.endsWith('.map')) continue;
          fs.copyFileSync(path.join(ORT_WASM_DIR, file), path.join(outDir, file));
          copied++;
        }
      }
      if (copied === 0) {
        const msg = `copy-ort-wasm: no ort-wasm-* assets found in ${ORT_WASM_DIR} — sentiment/embeddings will fail to load.`;
        // In a production build this is a launch-blocking defect: a glue-less zip
        // throws "no available backend found" at runtime. Fail the build loudly so
        // it can never be uploaded silently. Dev/watch builds only warn.
        if (isProd) this.error(msg);
        else this.warn(msg);
      }

      // Deduplicate the (large) ONNX .wasm binary. onnxruntime-web references the
      // wasm via `new URL(..., import.meta.url)`, so Vite may also emit a hashed
      // copy into dist/assets/. That copy is never loaded at runtime — the workers
      // override wasmPaths to dist/wasm/. Remove only the orphaned assets/ *.wasm
      // (NOT the .mjs glue — leaving any emitted glue in assets/ is a harmless
      // fallback for the import.meta.url resolution branch). Saves ~23 MB on upload.
      const assetsDir = path.resolve(__dirname, 'dist/assets');
      if (fs.existsSync(assetsDir)) {
        for (const f of fs.readdirSync(assetsDir)) {
          if (/^ort-wasm-simd-threaded.*\.wasm$/.test(f)) {
            fs.rmSync(path.join(assetsDir, f), { force: true });
          }
        }
      }
    },
  };
}

// ── Custom plugin: bundle on-device model weights into dist/models/ ────────────
// Zero-egress architecture: the quantized ONNX weights ship inside the extension
// instead of being fetched from huggingface.co at runtime. They live in the repo
// `models/` dir (populated by `npm run fetch-models`) and are copied verbatim
// into the build output, where the workers load them via
// chrome.runtime.getURL('models/').
function copyModelsPlugin(isProd: boolean): Plugin {
  const SRC = path.resolve(__dirname, 'models');
  const DEST = path.resolve(__dirname, 'dist/models');
  const SENTINEL = path.join(DEST, 'Xenova/finbert/onnx/model_quantized.onnx');

  return {
    name: 'copy-models',
    apply: 'build',
    closeBundle() {
      if (!fs.existsSync(SRC)) {
        const msg =
          'models/ not found — run `npm run fetch-models` to bundle the on-device ' +
          'model weights, or sentiment/summaries/redline will fail to load at runtime.';
        // A model-less zip is a broken extension. Fail the production build loudly
        // (closes the "fresh clone / CI ships a model-less build" trap); dev only warns.
        if (isProd) this.error(msg);
        else this.warn(msg);
        return;
      }
      // closeBundle fires once per sub-build; the 131 MB payload only needs copying
      // once. Skip if the output already has it.
      if (fs.existsSync(SENTINEL)) return;
      fs.cpSync(SRC, DEST, { recursive: true });
    },
  };
}

// ── Custom plugin: route shared chunks under assets/ ───────────────────────────
// vite-plugin-web-extension forces chunkFileNames to `[name].js`, so a chunk
// shared by the offscreen + sidepanel entries (the redline/diff + extractive
// utilities) drops a loose `diff.js` at the dist root. We name that shared code
// via manualChunks so it lands at `assets/filinglens-shared.js` instead.
//
// manualChunks is only valid for code-split (ES, multi-entry) builds; the
// service-worker and content scripts build as single-file IIFE libs where
// rolldown forbids it. So we attach it via outputOptions and gate on format,
// rather than putting it in the shared build config.
function sharedChunkRouterPlugin(): Plugin {
  return {
    name: 'shared-chunk-router',
    apply: 'build',
    outputOptions(opts) {
      if (opts.format === 'es' && !opts.inlineDynamicImports && !opts.manualChunks) {
        opts.manualChunks = (id: string) =>
          id.includes('/src/redline/') || id.includes('/src/summarizer/')
            ? 'assets/filinglens-shared'
            : undefined;
      }
      return opts;
    },
  };
}

export default defineConfig(({ mode }) => ({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
  plugins: [
    react(),
    tailwindcss(),
    ...(mode !== 'test'
      ? [
          webExtension({
            // Single source of truth for the release version: package.json. The
            // shipped manifest's `version` is always overwritten with pkg.version
            // at build time, so the two can't silently drift (L3). manifest.json's
            // own version field is just a default for tooling that reads it raw.
            manifest: () => {
              const base = JSON.parse(
                fs.readFileSync(path.resolve(__dirname, 'manifest.json'), 'utf8'),
              ) as Record<string, unknown>;
              const pkg = JSON.parse(
                fs.readFileSync(path.resolve(__dirname, 'package.json'), 'utf8'),
              ) as { version: string };
              return { ...base, version: pkg.version };
            },
            // Bundle the offscreen document alongside the extension.
            additionalInputs: ['src/offscreen/offscreen.html'],
          }),
          // Copy ONNX Runtime WASM binaries to dist/wasm/ (flat directory) so the
          // encoder worker can load them via chrome.runtime.getURL('wasm/').
          // Missing assets fail the build in production (see plugin).
          copyWasmPlugin(mode === 'production'),
          // Bundle the quantized model weights so nothing is fetched at runtime.
          copyModelsPlugin(mode === 'production'),
          // Keep shared chunks out of the dist root (see plugin comment).
          sharedChunkRouterPlugin(),
        ]
      : []),
  ],
  build: {
    target: 'es2022',
    minify: false,
    // Sourcemaps in dev only. Production (CWS) builds ship no .map files: this
    // keeps the upload smaller, avoids shipping original source to the store, and
    // ensures stripped code (e.g. the dev-only DevSettings UI) leaves no trace in
    // the dist output — not even as a string in a sourcemap.
    sourcemap: mode === 'development',
  },
  // Web Workers in Vite: treat .worker.ts imports as module workers.
  worker: {
    format: 'es',
  },
  // NOTE: the Vitest config lives in vitest.config.ts (real test runner). No `test`
  // block here — a stale one pointing at a non-existent src/__tests__ dir was removed.
}));
