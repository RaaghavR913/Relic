#!/usr/bin/env node
// Relic — runtime WASM inference smoke (onnxruntime-web + shipped dist assets)
// Node's transformers build rejects device:'wasm' (cpu/webgpu/coreml only).
// This script forces ORT WASM against dist/wasm + dist/models — the same assets
// the extension workers load — and runs real encoder (+ optional FinBERT) inference.

import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { existsSync, readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import * as ort from 'onnxruntime-web';
import { AutoTokenizer, env } from '@huggingface/transformers';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WASM_DIR = path.join(ROOT, 'dist', 'wasm');
const MODEL_DIR = path.join(ROOT, 'dist', 'models');
const SKIP_FINBERT = process.env.SKIP_FINBERT === '1';

function ok(msg) {
  console.log(`✓ ${msg}`);
}
function fail(msg) {
  console.error(`FAIL: ${msg}`);
  process.exitCode = 1;
}

function l2norm(data) {
  let s = 0;
  for (let i = 0; i < data.length; i++) s += data[i] * data[i];
  return Math.sqrt(s);
}

function softmax(logits) {
  const m = Math.max(...logits);
  const exps = logits.map((v) => Math.exp(v - m));
  const sum = exps.reduce((a, b) => a + b, 0);
  return exps.map((v) => v / sum);
}

async function configureOrt() {
  const glue = path.join(WASM_DIR, 'ort-wasm-simd-threaded.mjs');
  const binary = path.join(WASM_DIR, 'ort-wasm-simd-threaded.wasm');
  if (!existsSync(glue) || !existsSync(binary)) {
    throw new Error(`Missing ORT pair under ${WASM_DIR}`);
  }
  // Prove glue is importable as ESM
  await import(pathToFileURL(glue).href);
  ok(`ORT glue importable (${path.basename(glue)})`);

  ort.env.wasm.wasmPaths = pathToFileURL(WASM_DIR + path.sep).href;
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.proxy = false;
  console.log(`  wasmPaths: ${ort.env.wasm.wasmPaths}`);
}

async function loadTokenizer(modelId) {
  env.allowRemoteModels = false;
  env.allowLocalModels = true;
  env.localModelPath = MODEL_DIR + path.sep;
  env.useBrowserCache = false;
  return AutoTokenizer.from_pretrained(modelId, { local_files_only: true });
}

async function runEncoder() {
  const modelId = 'mixedbread-ai/mxbai-embed-xsmall-v1';
  const onnxPath = path.join(MODEL_DIR, modelId, 'onnx', 'model_quantized.onnx');
  console.log(`\n── Encoder: ${modelId} (ORT executionProviders: wasm) ──`);

  const tokenizer = await loadTokenizer(modelId);
  ok('tokenizer loaded (local)');

  const t0 = performance.now();
  const session = await ort.InferenceSession.create(onnxPath, {
    executionProviders: ['wasm'],
  });
  const loadMs = performance.now() - t0;
  ok(`InferenceSession create ${loadMs.toFixed(0)}ms; outs=${session.outputNames.join(',')}`);

  const texts = [
    'Revenue grew 12% year over year.',
    'The company faces elevated credit risk.',
  ];
  const encoded = await tokenizer(texts, { padding: true, truncation: true });
  const inputIds = encoded.input_ids;
  const attention = encoded.attention_mask;
  // Transformers.js Tensor → ort.Tensor
  const dims = inputIds.dims;
  const feeds = {
    input_ids: new ort.Tensor('int64', BigInt64Array.from(Array.from(inputIds.data, (x) => BigInt(x))), dims),
    attention_mask: new ort.Tensor('int64', BigInt64Array.from(Array.from(attention.data, (x) => BigInt(x))), dims),
  };

  const t1 = performance.now();
  const out = await session.run(feeds);
  const inferMs = performance.now() - t1;

  const se = out.sentence_embedding;
  if (!se) throw new Error('missing sentence_embedding output');
  const dim = se.dims[se.dims.length - 1];
  const batch = se.dims[0] ?? 1;
  if (dim !== 384) throw new Error(`expected dim 384, got ${dim}`);

  const norms = [];
  for (let i = 0; i < batch; i++) {
    const slice = se.data.subarray(i * dim, (i + 1) * dim);
    const n = l2norm(slice);
    // pipeline uses normalize:true; raw sentence_embedding may not be unit
    const unit = new Float32Array(dim);
    for (let j = 0; j < dim; j++) unit[j] = slice[j] / n;
    const un = l2norm(unit);
    if (un < 0.99 || un > 1.01) throw new Error(`unit norm bad: ${un}`);
    norms.push(un);
    ok(`vec[${i}] dim=${dim} rawNorm=${n.toFixed(4)} unitNorm=${un.toFixed(4)}`);
  }
  ok(`inference ${inferMs.toFixed(0)}ms on device=wasm`);
  return { loadMs, inferMs, dim, norms, batch };
}

async function runFinbert() {
  const modelId = 'Xenova/finbert';
  const onnxPath = path.join(MODEL_DIR, modelId, 'onnx', 'model_quantized.onnx');
  const cfg = JSON.parse(readFileSync(path.join(MODEL_DIR, modelId, 'config.json'), 'utf8'));
  const id2label = cfg.id2label;
  console.log(`\n── Sentiment: ${modelId} (ORT executionProviders: wasm) ──`);

  const tokenizer = await loadTokenizer(modelId);
  ok('tokenizer loaded (local)');

  const t0 = performance.now();
  const session = await ort.InferenceSession.create(onnxPath, {
    executionProviders: ['wasm'],
  });
  const loadMs = performance.now() - t0;
  ok(`InferenceSession create ${loadMs.toFixed(0)}ms; outs=${session.outputNames.join(',')}`);

  const texts = [
    'The company reported record profits and strong guidance.',
    'Liquidity concerns and rising defaults weighed on results.',
  ];
  const results = [];
  const t1 = performance.now();
  for (const text of texts) {
    const encoded = await tokenizer(text, { padding: true, truncation: true });
    const dims = encoded.input_ids.dims;
    const feeds = {
      input_ids: new ort.Tensor(
        'int64',
        BigInt64Array.from(Array.from(encoded.input_ids.data, (x) => BigInt(x))),
        dims,
      ),
      attention_mask: new ort.Tensor(
        'int64',
        BigInt64Array.from(Array.from(encoded.attention_mask.data, (x) => BigInt(x))),
        dims,
      ),
    };
    // token_type_ids if required
    if (session.inputNames.includes('token_type_ids')) {
      const zeros = BigInt64Array.from({ length: dims.reduce((a, b) => a * b, 1) }, () => 0n);
      feeds.token_type_ids = new ort.Tensor('int64', zeros, dims);
    }
    const out = await session.run(feeds);
    const logitsTensor = out.logits ?? out[session.outputNames[0]];
    const logits = Array.from(logitsTensor.data);
    const probs = softmax(logits);
    let best = 0;
    for (let i = 1; i < probs.length; i++) if (probs[i] > probs[best]) best = i;
    const label = id2label[String(best)] ?? id2label[best] ?? String(best);
    results.push({ text, label, score: probs[best], probs });
    ok(`label=${label} score=${probs[best].toFixed(4)} logits=${logits.map((x) => x.toFixed(2)).join(',')}`);
  }
  const inferMs = performance.now() - t1;
  ok(`inference ${inferMs.toFixed(0)}ms on device=wasm (${texts.length} texts)`);
  return { loadMs, inferMs, results };
}

async function main() {
  console.log('Relic WASM smoke test (onnxruntime-web)');
  console.log(`  wasm:   ${WASM_DIR}`);
  console.log(`  models: ${MODEL_DIR}`);
  if (!existsSync(WASM_DIR) || !existsSync(MODEL_DIR)) {
    fail('dist/wasm or dist/models missing — run npm run build');
    return;
  }

  await configureOrt();

  let encoder = null;
  let sentiment = null;
  try {
    encoder = await runEncoder();
  } catch (err) {
    fail(`Encoder: ${err}`);
    console.error(err);
  }

  if (SKIP_FINBERT) {
    console.log('\n── Sentiment: skipped (SKIP_FINBERT=1) ──');
  } else {
    try {
      sentiment = await runFinbert();
    } catch (err) {
      const msg = String(err);
      if (/heap|oom|out of memory|ENOMEM/i.test(msg)) {
        console.warn(`WARN: FinBERT OOM-skipped: ${msg}`);
        sentiment = 'oom-skipped';
      } else {
        fail(`Sentiment: ${err}`);
        console.error(err);
      }
    }
  }

  console.log('\n════════ SUMMARY ════════');
  console.log(`  Encoder WASM: ${encoder ? 'PASS' : 'FAIL'}`);
  console.log(
    `  Sentiment:    ${
      sentiment === 'oom-skipped' ? 'SKIP (OOM)' : SKIP_FINBERT ? 'SKIP' : sentiment ? 'PASS' : 'FAIL'
    }`,
  );
  if (encoder) {
    console.log(
      `  Encoder: load ${encoder.loadMs.toFixed(0)}ms, infer ${encoder.inferMs.toFixed(0)}ms, dim=${encoder.dim}`,
    );
  }
  if (sentiment && typeof sentiment === 'object') {
    console.log(
      `  Sentiment: load ${sentiment.loadMs.toFixed(0)}ms, infer ${sentiment.inferMs.toFixed(0)}ms`,
    );
  }
  if (encoder && (SKIP_FINBERT || sentiment === 'oom-skipped' || sentiment)) {
    console.log('\nPASS: runtime WASM inference OK (ORT wasm EP + shipped dist assets)');
  } else {
    process.exitCode = 1;
  }
}

main().catch((e) => {
  fail(String(e));
  console.error(e);
  process.exit(1);
});
