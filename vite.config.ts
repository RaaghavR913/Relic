import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import webExtension from 'vite-plugin-web-extension';
import path from 'path';
import fs from 'fs';

function copyExtensionAssetsPlugin(): Plugin {
  const ASSETS: Array<{ src: string; dest: string }> = [
    {
      src: path.resolve(__dirname, 'src/assets/brand-logo.png'),
      dest: path.resolve(__dirname, 'dist/brand-logo.png'),
    },
  ];

  return {
    name: 'copy-extension-assets',
    apply: 'build',
    closeBundle() {
      for (const { src, dest } of ASSETS) {
        if (!fs.existsSync(src)) {
          this.warn(`copy-extension-assets: ${src} missing.`);
          continue;
        }
        fs.copyFileSync(src, dest);
      }
    },
  };
}

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
  // Allowlist — ONLY the two backend pairs Relic actually loads at runtime:
  //   • ort-wasm-simd-threaded.{mjs,wasm}          — CPU / WASM path
  //   • ort-wasm-simd-threaded.asyncify.{mjs,wasm} — WebGPU path (transformers.js
  //     imports ORT's `webgpu` build, which bridges async GPU work via Asyncify)
  //
  // onnxruntime-web ALSO ships .jsep and .jspi pairs, but no built worker chunk
  // imports their glue. Verified empirically: with both pairs deleted, the encoder
  // and FinBERT workers still reached `webgpu: ok` against a live adapter, fetching
  // only asyncify.wasm, and the WASM path was unaffected. Copying them shipped
  // ~41 MB of dead weight in the CWS upload.
  //
  // Narrowing the glob means a dependency rename could silently drop a pair we DO
  // need (copied > 0, so the count guard below would not fire), so verify-dist.mjs
  // asserts both surviving pairs are present in dist/ — keep the two in sync.
  const ORT_ASSET_RE = /^ort-wasm-simd-threaded(\.asyncify)?\.(mjs|wasm)$/;

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

// ── Custom plugin: strip remote-code loaders from vendored dependencies ────────
// CWS rejected v1.2.7 ("Blue Argon": remotely hosted code in a Manifest V3
// item). The flagged snippet is jsPDF's `output("pdfobjectnewwindow")` branch,
// which opens a window and injects a <script> pointing at
// cdnjs.cloudflare.com/.../pdfobject.min.js. Relic only ever calls
// `doc.save()`, so the branch is dead code — but the store's static scan
// (reasonably) flags the URL + script-injection pattern regardless of
// reachability. transformers.js has the same class of pattern: when
// `wasm.wasmPaths` is unset it falls back to loading ORT's .mjs/.wasm glue
// from cdn.jsdelivr.net (ours is always set to the bundled dist/wasm/ before
// any session is created, so that fallback is likewise never fetched).
//
// This plugin excises both loaders from the module source before bundling, so
// no remote-code URL ships at all. Each replacement is asserted: if a
// dependency upgrade moves the code and a pattern stops matching — or a CDN
// URL survives the rewrite — the build fails loudly rather than shipping a
// rejectable zip. scripts/verify-dist.mjs re-checks the emitted output.
//
// Requires the `jspdf` resolve.alias below: jsPDF's package entry is the
// minified build, whose text isn't stable enough to pattern-match; the alias
// swaps in the unminified dist/jspdf.es.js (same code, same optional dynamic
// imports), which production minification then re-compresses anyway.
function stripRemoteCodeLoadersPlugin(): Plugin {
  return {
    name: 'strip-remote-code-loaders',
    apply: 'build',
    transform(code, id) {
      if (id.includes('jspdf/dist/jspdf.es.js')) {
        // Replace the whole case body (URL, SRI hash, script injection) with a
        // throw, preserving the switch's shape for the cases that follow it.
        const caseRe = /case "pdfobjectnewwindow":[\s\S]+?(?=case "pdfjsnewwindow":)/;
        if (!caseRe.test(code)) {
          this.error(
            'strip-remote-code-loaders: jsPDF "pdfobjectnewwindow" branch not found — ' +
              'the jspdf version changed shape; update the pattern before shipping.',
          );
        }
        const out = code.replace(
          caseRe,
          'case "pdfobjectnewwindow":\n' +
            '        throw new Error("pdfobjectnewwindow is removed from this build (MV3: no remotely hosted code).");\n' +
            '      ',
        );
        if (out.includes('cdnjs.cloudflare.com')) {
          this.error('strip-remote-code-loaders: cdnjs URL survived the jsPDF rewrite.');
        }
        return { code: out, map: null };
      }

      if (id.includes('@huggingface/transformers/dist/transformers.web.js')) {
        // Neutralize the CDN fallback prefix. The branch only runs when
        // wasmPaths is unset — our workers always set it first — so pointing it
        // at a never-resolving local path changes nothing at runtime while
        // removing the remote URL (and turning any future regression into a
        // loud local 404 instead of silent network egress).
        const urlRe = /`https:\/\/cdn\.jsdelivr\.net\/npm\/onnxruntime-web@\$\{[^}]+\}\/dist\/`/;
        if (!urlRe.test(code)) {
          this.error(
            'strip-remote-code-loaders: transformers.js jsdelivr wasm fallback not found — ' +
              'the @huggingface/transformers version changed shape; update the pattern before shipping.',
          );
        }
        let out = code.replace(urlRe, '"/__relic-no-remote-wasm__/"');
        if (out.includes('cdn.jsdelivr.net')) {
          this.error('strip-remote-code-loaders: jsdelivr URL survived the transformers.js rewrite.');
        }

        // Neutralize the Hugging Face Hub host baked into transformers.js's model
        // defaults: env.remoteHost / remotePathTemplate, an example-asset URL, and
        // the auth-host allowlist. All are dead in this build — env.allowRemoteModels
        // is false and weights load from the bundled localModelPath — so no fetch to
        // the Hub can happen (and the CSP blocks it regardless). This strip only
        // removes the unreachable data-host string from the shipped JS so it can't be
        // mistaken for a live loader. Not egress-critical, so assert on the RESULT
        // (no host survives) rather than requiring the input to look a certain way —
        // a dependency bump that renames/drops one of these must not fail the build.
        out = out.replaceAll('huggingface.co', 'huggingface.invalid');
        if (out.includes('huggingface.co')) {
          this.error('strip-remote-code-loaders: a huggingface.co host survived the transformers.js rewrite.');
        }

        return { code: out, map: null };
      }

      return null;
    },
  };
}

// ── Custom plugin: route shared chunks under assets/ ───────────────────────────
// vite-plugin-web-extension forces chunkFileNames to `[name].js`, so a chunk
// shared by the offscreen + sidepanel entries (the redline/diff + extractive
// utilities) drops a loose `diff.js` at the dist root. We name that shared code
// via manualChunks so it lands at `assets/relic-shared.js` instead.
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
            ? 'assets/relic-shared'
            : undefined;
      }
      return opts;
    },
  };
}

export default defineConfig(({ mode }) => ({
  resolve: {
    alias: [
      { find: '@', replacement: path.resolve(__dirname, 'src') },
      // jsPDF's package entry is the minified ESM build; point the bare import
      // at the unminified one so stripRemoteCodeLoadersPlugin can excise the
      // "pdfobjectnewwindow" remote-code branch with a stable pattern (see the
      // plugin comment). Production minification re-compresses it afterwards.
      {
        find: /^jspdf$/,
        replacement: path.resolve(__dirname, 'node_modules/jspdf/dist/jspdf.es.js'),
      },
      // jsPDF's optional lazy integrations — html2canvas + dompurify (only for
      // doc.html()) and canvg (only for doc.addSvgAsImage()). Relic's export is
      // pure text/vector drawing, so these would ship ~376 KB of dead chunks in
      // the CWS zip. Stubbed out; see src/vendor/jspdf-optional-stub.ts.
      {
        find: /^(html2canvas|dompurify|canvg)$/,
        replacement: path.resolve(__dirname, 'src/vendor/jspdf-optional-stub.ts'),
      },
    ],
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
          copyExtensionAssetsPlugin(),
          // Bundle the quantized model weights so nothing is fetched at runtime.
          copyModelsPlugin(mode === 'production'),
          // Keep shared chunks out of the dist root (see plugin comment).
          sharedChunkRouterPlugin(),
          // Excise dead CDN loaders (jsPDF pdfobjectnewwindow, transformers.js
          // jsdelivr wasm fallback) — CWS rejects MV3 items whose shipped code
          // contains remote-code URLs, reachable or not (see plugin comment).
          stripRemoteCodeLoadersPlugin(),
        ]
      : []),
  ],
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 700,
    // Minify production builds only — dev/watch keeps readable output for debugging.
    minify: mode === 'production',
    // Sourcemaps in dev only. Production (CWS) builds ship no .map files: this
    // keeps the upload smaller, avoids shipping original source to the store, and
    // ensures stripped code (e.g. the dev-only DevSettings UI) leaves no trace in
    // the dist output — not even as a string in a sourcemap.
    sourcemap: mode === 'development',
  },
  // Web Workers in Vite: treat .worker.ts imports as module workers.
  worker: {
    format: 'es',
    // Worker bundles have their own plugin pipeline — the top-level plugins
    // array does NOT apply. Without this, transformers.js's jsdelivr wasm
    // fallback ships inside the worker chunks (verify-dist catches it).
    plugins: () => [stripRemoteCodeLoadersPlugin()],
  },
  // NOTE: the Vitest config lives in vitest.config.ts (real test runner). No `test`
  // block here — a stale one pointing at a non-existent src/__tests__ dir was removed.
}));
