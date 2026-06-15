#!/usr/bin/env node
// Regenerate extension toolbar icons + in-app brand logo from public/icons/icon.svg.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const SVG = path.join(ROOT, 'public/icons/icon.svg');
const OUT_DIR = path.join(ROOT, 'public/icons');
const BRAND = path.join(ROOT, 'src/assets/brand-logo.png');
const SIZES = [16, 32, 48, 128];

if (!fs.existsSync(SVG)) {
  console.error(`Missing source SVG: ${SVG}`);
  process.exit(1);
}

for (const size of SIZES) {
  const out = path.join(OUT_DIR, `icon${size}.png`);
  const result = spawnSync(
    'npx',
    ['--yes', '@resvg/resvg-js-cli', '--fit-width', String(size), '--fit-height', String(size), SVG, out],
    { stdio: 'inherit' },
  );
  if (result.status !== 0) process.exit(result.status ?? 1);
}

fs.copyFileSync(path.join(OUT_DIR, 'icon128.png'), BRAND);
console.log('✓ generate-icons: public/icons/icon{16,32,48,128}.png + src/assets/brand-logo.png');
