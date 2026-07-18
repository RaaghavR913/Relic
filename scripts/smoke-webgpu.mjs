#!/usr/bin/env node
// Relic — WebGPU backend-selection smoke (Chrome headless + shipped dist assets)
// ------------------------------------------------------------
// Node cannot reliably exercise ORT's WebGPU EP. This script:
//   1. Verifies the jsep (WebGPU) ORT glue+binary pair ships in dist/wasm/
//   2. Serves dist/ + a harness that INITs production workers with preferredDevice:'webgpu'
//   3. Asserts READY.device / attempts (webgpu: ok when adapter present; wasm: ok otherwise)
//
// Full tensor inference is covered by scripts/smoke-wasm.mjs (non-regression).
// Headless Transformers.js pipeline *calls* are flaky even after READY succeeds;
// this smoke focuses on backend selection — the WebGPU hardening surface.
//
// Env: SKIP_FINBERT=1 to skip sentiment worker. Requires `npm run build`.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
const WASM_DIR = path.join(DIST, 'wasm');
const SKIP_FINBERT = process.env.SKIP_FINBERT === '1';
const TIMEOUT_MS = Number(process.env.SMOKE_TIMEOUT_MS ?? 240_000);

function ok(msg) {
  console.log(`✓ ${msg}`);
}
function fail(msg) {
  console.error(`FAIL: ${msg}`);
  process.exitCode = 1;
}

function findWorker(role) {
  const assets = path.join(DIST, 'assets');
  if (!fs.existsSync(assets)) return null;
  const re =
    role === 'encoder' ? /^encoder\.worker-.*\.js$/ : /^sentiment\.worker-.*\.js$/;
  return fs.readdirSync(assets).find((f) => re.test(f)) ?? null;
}

function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    'google-chrome',
    'google-chrome-stable',
    'chromium',
    'chromium-browser',
  ].filter(Boolean);
  for (const c of candidates) {
    if (c.includes('/') && fs.existsSync(c)) return c;
    if (!c.includes('/')) return c;
  }
  return null;
}

function contentType(p) {
  if (p.endsWith('.js') || p.endsWith('.mjs')) return 'text/javascript; charset=utf-8';
  if (p.endsWith('.wasm')) return 'application/wasm';
  if (p.endsWith('.json')) return 'application/json';
  if (p.endsWith('.onnx')) return 'application/octet-stream';
  return 'application/octet-stream';
}

function buildHarness(encoderWorker, sentimentWorker) {
  return `<!doctype html>
<html><head><meta charset="utf-8"/><title>Relic WebGPU smoke</title></head>
<body>
<script type="module">
const SKIP_FINBERT = ${SKIP_FINBERT ? 'true' : 'false'};
const result = { ok: false, steps: [] };
function step(msg, extra) {
  result.steps.push(extra ? { msg, ...extra } : { msg });
  console.log('[smoke]', msg, extra ?? '');
}
async function report() {
  try {
    await fetch('/result', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(result),
    });
  } catch (e) {
    console.error('report failed', e);
  }
}

async function initWorker(url, initExtra) {
  return new Promise((resolve, reject) => {
    const w = new Worker(url, { type: 'module' });
    const t = setTimeout(() => {
      w.terminate();
      reject(new Error('worker timeout'));
    }, 180000);
    w.onerror = (e) => {
      clearTimeout(t);
      w.terminate();
      reject(e.error ?? new Error(e.message || 'worker error'));
    };
    w.onmessage = (e) => {
      const msg = e.data;
      if (msg.type === 'READY') {
        clearTimeout(t);
        step('READY', { device: msg.device, attempts: msg.diag?.attempts, modelId: initExtra.modelId });
        w.terminate();
        resolve(msg);
      } else if (msg.type === 'ERROR' && !msg.id) {
        clearTimeout(t);
        w.terminate();
        reject(new Error(msg.message));
      }
    };
    w.postMessage({
      type: 'INIT',
      wasmPaths: location.origin + '/wasm/',
      modelBasePath: location.origin + '/models/',
      numThreads: 1,
      preferredDevice: 'webgpu',
      ...initExtra,
    });
  });
}

try {
  const adapter = await navigator.gpu?.requestAdapter({ powerPreference: 'high-performance' });
  step('adapter', { present: Boolean(adapter) });
  await initWorker('/assets/${encoderWorker}', { modelId: 'mixedbread-ai/mxbai-embed-xsmall-v1' });
  if (!SKIP_FINBERT) {
    await initWorker('/assets/${sentimentWorker}', { modelId: 'Xenova/finbert' });
  }
  result.ok = true;
  step('done');
} catch (err) {
  result.ok = false;
  result.error = String(err && err.message ? err.message : err);
  console.error('[smoke] error', err);
}
await report();
</script>
</body></html>`;
}

function startServer(encoderWorker, sentimentWorker) {
  const harness = buildHarness(encoderWorker, sentimentWorker);
  /** @type {{ resolve: (v: unknown) => void, reject: (e: Error) => void } | null} */
  let pendingResult = null;
  const resultPromise = new Promise((resolve, reject) => {
    pendingResult = { resolve, reject };
  });

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');

    if (url.pathname === '/result' && req.method === 'POST') {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          pendingResult?.resolve(body);
          pendingResult = null;
          res.writeHead(200, { 'Content-Type': 'text/plain' });
          res.end('ok');
        } catch (err) {
          pendingResult?.reject(err instanceof Error ? err : new Error(String(err)));
          pendingResult = null;
          res.writeHead(400);
          res.end('bad json');
        }
      });
      return;
    }

    if (url.pathname === '/' || url.pathname === '/harness.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(harness);
      return;
    }

    const rel = decodeURIComponent(url.pathname.replace(/^\//, ''));
    const file = path.normalize(path.join(DIST, rel));
    if (!file.startsWith(DIST) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': contentType(file),
      'Access-Control-Allow-Origin': '*',
    });
    fs.createReadStream(file).pipe(res);
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());
      resolve({ server, port, resultPromise });
    });
  });
}

function runChrome(chromePath, url) {
  const userData = fs.mkdtempSync(path.join(tmpdir(), 'relic-webgpu-smoke-'));
  const args = [
    '--headless=new',
    '--enable-unsafe-webgpu',
    '--enable-webgpu-developer-features',
    '--no-first-run',
    '--no-default-browser-check',
    `--user-data-dir=${userData}`,
    url,
  ];
  const child = spawn(chromePath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (d) => {
    stderr += d.toString();
  });
  return {
    child,
    stderr: () => stderr,
    cleanup: () => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
      try {
        fs.rmSync(userData, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    },
  };
}

async function main() {
  console.log('Relic WebGPU smoke\n');

  const jsepMjs = path.join(WASM_DIR, 'ort-wasm-simd-threaded.jsep.mjs');
  const jsepWasm = path.join(WASM_DIR, 'ort-wasm-simd-threaded.jsep.wasm');
  if (!fs.existsSync(jsepMjs) || !fs.existsSync(jsepWasm)) {
    fail('missing WebGPU ORT pair (ort-wasm-simd-threaded.jsep.{mjs,wasm}) in dist/wasm/');
    return;
  }
  ok('dist/wasm ships jsep (WebGPU) glue+binary');

  const encoderWorker = findWorker('encoder');
  const sentimentWorker = findWorker('sentiment');
  if (!encoderWorker) {
    fail('dist/assets/encoder.worker-*.js missing — run npm run build');
    return;
  }
  if (!SKIP_FINBERT && !sentimentWorker) {
    fail('dist/assets/sentiment.worker-*.js missing — run npm run build');
    return;
  }

  const chrome = findChrome();
  if (!chrome) {
    console.log('⚠ Chrome/Chromium not found — static jsep check only (skip runtime).');
    console.log('  Set CHROME_PATH to run the full WebGPU smoke.');
    ok('static WebGPU asset check passed (runtime skipped)');
    return;
  }
  ok(`using Chrome: ${chrome}`);

  const { server, port, resultPromise } = await startServer(encoderWorker, sentimentWorker);
  const url = `http://127.0.0.1:${port}/harness.html`;
  console.log(`  harness: ${url}`);

  const chromeRun = runChrome(chrome, url);
  const timer = setTimeout(() => {
    fail(`timed out after ${TIMEOUT_MS}ms waiting for harness /result`);
    chromeRun.cleanup();
    server.close();
  }, TIMEOUT_MS);

  try {
    const parsed = /** @type {{ ok: boolean, error?: string, steps: Array<Record<string, unknown>> }} */ (
      await resultPromise
    );
    clearTimeout(timer);
    console.log(JSON.stringify(parsed, null, 2));
    if (!parsed.ok) {
      fail(parsed.error ?? 'harness reported ok:false');
      return;
    }
    const ready = parsed.steps.filter((s) => s.msg === 'READY');
    const adapterStep = parsed.steps.find((s) => s.msg === 'adapter');
    if (adapterStep?.present) {
      const webgpuOk = ready.some((s) => s.device === 'webgpu');
      if (!webgpuOk) {
        const wasmOk = ready.every(
          (s) =>
            Array.isArray(s.attempts) &&
            s.attempts.some((a) => String(a).startsWith('wasm: ok')),
        );
        if (!wasmOk) {
          fail('adapter present but neither webgpu nor wasm READY');
          return;
        }
        console.log('⚠ adapter present but workers used WASM — acceptable fallback');
      } else {
        ok('workers initialized on WebGPU');
      }
    } else {
      const wasmOk = ready.every(
        (s) =>
          s.device === 'wasm' ||
          (Array.isArray(s.attempts) && s.attempts.some((a) => String(a).includes('wasm: ok'))),
      );
      if (!wasmOk) {
        fail('no adapter and WASM fallback failed');
        return;
      }
      ok('no WebGPU adapter — clean WASM fallback');
    }
    ok('WebGPU smoke passed');
  } catch (err) {
    clearTimeout(timer);
    fail(String(err));
    const errTail = chromeRun.stderr().slice(-2000);
    if (errTail) console.error(errTail);
  } finally {
    chromeRun.cleanup();
    server.close();
  }
}

main().catch((err) => {
  fail(String(err));
  console.error(err);
});
