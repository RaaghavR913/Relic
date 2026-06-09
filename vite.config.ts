import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import webExtension from 'vite-plugin-web-extension';
import path from 'path';
import fs from 'fs';

// ── Custom plugin: copy ONNX Runtime WASM binaries to dist/wasm/ (flat) ────────
// vite-plugin-static-copy preserves nested directory structure; this plugin does
// a direct fs.copyFile into the flat dest directory instead.
function copyWasmPlugin(): Plugin {
  const ORT_WASM_DIR = path.resolve(
    __dirname,
    'node_modules/@huggingface/transformers/node_modules/onnxruntime-web/dist',
  );
  const WASM_FILES = [
    'ort-wasm-simd-threaded.jsep.wasm',
    'ort-wasm-simd-threaded.wasm',
    'ort-wasm-simd-threaded.asyncify.wasm',
    'ort-wasm-simd-threaded.jspi.wasm',
  ];

  return {
    name: 'copy-ort-wasm',
    apply: 'build',
    closeBundle() {
      const outDir = path.resolve(__dirname, 'dist/wasm');
      fs.mkdirSync(outDir, { recursive: true });
      for (const file of WASM_FILES) {
        const src = path.join(ORT_WASM_DIR, file);
        const dest = path.join(outDir, file);
        if (fs.existsSync(src)) {
          fs.copyFileSync(src, dest);
        }
      }

      // Deduplicate the ONNX WASM binary. onnxruntime-web references the wasm via
      // `new URL(..., import.meta.url)`, so Vite also emits a (hashed) copy into
      // dist/assets/. That copy is never loaded at runtime — the encoder/sentiment
      // workers override `env.backends.onnx.wasm.wasmPaths` to
      // chrome.runtime.getURL('wasm/'), so ORT always loads from dist/wasm/ above.
      // Remove the orphaned assets/ copies so the binary ships exactly once
      // (~23 MB saved from the CWS upload).
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
function copyModelsPlugin(): Plugin {
  const SRC = path.resolve(__dirname, 'models');
  const DEST = path.resolve(__dirname, 'dist/models');
  const SENTINEL = path.join(DEST, 'Xenova/finbert/onnx/model_quantized.onnx');

  return {
    name: 'copy-models',
    apply: 'build',
    closeBundle() {
      if (!fs.existsSync(SRC)) {
        this.warn(
          'models/ not found — run `npm run fetch-models` to bundle the on-device ' +
            'model weights, or sentiment/Q&A will fail to load at runtime.',
        );
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
            manifest: './manifest.json',
            // Bundle the offscreen document alongside the extension.
            additionalInputs: ['src/offscreen/offscreen.html'],
          }),
          // Copy ONNX Runtime WASM binaries to dist/wasm/ (flat directory) so the
          // encoder worker can load them via chrome.runtime.getURL('wasm/').
          copyWasmPlugin(),
          // Bundle the quantized model weights so nothing is fetched at runtime.
          copyModelsPlugin(),
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
  test: {
    environment: 'jsdom',
    include: ['src/__tests__/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/content/**/*.ts'],
    },
  },
}));
