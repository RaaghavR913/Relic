// ============================================================
// Relic — bundle on-device model weights (zero-egress build step)
// ------------------------------------------------------------
// Downloads the open-source ONNX model files Relic runs locally into
// `models/<repo>/…` so the build can bundle them into the shipped extension.
// This is a BUILD-TIME developer step on your machine — the extension itself
// makes no Hugging Face request at runtime (env.allowRemoteModels = false).
//
// Run once (or whenever MODELS below changes):  npm run fetch-models
//
// Precision: quantized int8 (`onnx/model_quantized.onnx`, dtype 'q8' in the
// workers). ~134 MB total. To re-bundle a different precision, change the onnx
// filename here and the `dtype` in src/workers/*.worker.ts together.
// ============================================================

import { mkdir, writeFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, 'models');
const HOST = 'https://huggingface.co';
const REVISION = 'main';

/** Files Transformers.js requests for a text-classification / feature-extraction model. */
const FILES = [
  { p: 'config.json', required: true },
  { p: 'tokenizer.json', required: true },
  { p: 'tokenizer_config.json', required: true },
  { p: 'special_tokens_map.json', required: false },
  { p: 'vocab.txt', required: false },
  { p: 'onnx/model_quantized.onnx', required: true },
];

const MODELS = ['Xenova/finbert', 'mixedbread-ai/mxbai-embed-xsmall-v1'];

function fmt(bytes) {
  return `${(bytes / 1_048_576).toFixed(1)} MiB`;
}

async function fetchOne(repo, file) {
  const url = `${HOST}/${repo}/resolve/${REVISION}/${file.p}`;
  const dest = path.join(OUT_DIR, repo, file.p);

  if (existsSync(dest)) {
    const s = await stat(dest);
    if (s.size > 0) {
      console.log(`  skip  ${repo}/${file.p} (have ${fmt(s.size)})`);
      return s.size;
    }
  }

  const res = await fetch(url);
  if (!res.ok) {
    if (!file.required && res.status === 404) {
      console.log(`  miss  ${repo}/${file.p} (optional, 404)`);
      return 0;
    }
    throw new Error(`Failed ${url} → HTTP ${res.status}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  await mkdir(path.dirname(dest), { recursive: true });
  await writeFile(dest, buf);
  console.log(`  ok    ${repo}/${file.p} (${fmt(buf.length)})`);
  return buf.length;
}

let total = 0;
for (const repo of MODELS) {
  console.log(`\n${repo}`);
  for (const file of FILES) {
    total += await fetchOne(repo, file);
  }
}
console.log(`\nDone. Bundled model payload: ${fmt(total)} → ${path.relative(ROOT, OUT_DIR)}/`);
