#!/usr/bin/env node
// Regenerate extension toolbar icons + in-app brand logo from public/icons/icon-source.png.
//
// Handles two common master-asset shapes:
//   • Full-bleed rounded-square artwork (opaque corners) — center-crop to square.
//   • Exports with checkerboard / white halo — crop to content, flood-fill padding.
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

const ROOT = path.resolve(import.meta.dirname, '..');
const SOURCE = path.join(ROOT, 'public/icons/icon-source.png');
const OUT_DIR = path.join(ROOT, 'public/icons');
const BRAND = path.join(ROOT, 'src/assets/brand-logo.png');
const SIZES = [16, 32, 48, 128];

if (!fs.existsSync(SOURCE)) {
  console.error(`Missing source icon: ${SOURCE}`);
  process.exit(1);
}

/** Pixels that belong to export padding, not icon artwork. */
function isPaddingPixel(r, g, b, a = 255) {
  if (a < 16) return true;
  const spread = Math.max(r, g, b) - Math.min(r, g, b);
  const avg = (r + g + b) / 3;
  if (r > 235 && g > 235 && b > 235) return true;
  if (spread < 18 && avg > 185) return true;
  return false;
}

function cornerLooksLikePadding(data, width, height, channels) {
  const corners = [
    [0, 0],
    [width - 1, 0],
    [0, height - 1],
    [width - 1, height - 1],
  ];
  return corners.every(([x, y]) => {
    const i = (y * width + x) * channels;
    return isPaddingPixel(data[i], data[i + 1], data[i + 2], data[i + 3]);
  });
}

function contentBounds(data, width, height, channels) {
  let minX = width;
  let minY = height;
  let maxX = 0;
  let maxY = 0;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * channels;
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      const a = data[i + 3];
      if (!isPaddingPixel(r, g, b, a)) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }

  if (maxX < minX || maxY < minY) {
    return { left: 0, top: 0, width, height };
  }

  const cropW = maxX - minX + 1;
  const cropH = maxY - minY + 1;
  const side = Math.max(cropW, cropH);
  const left = Math.max(0, Math.floor(minX - (side - cropW) / 2));
  const top = Math.max(0, Math.floor(minY - (side - cropH) / 2));
  const right = Math.min(width, left + side);
  const bottom = Math.min(height, top + side);

  return {
    left,
    top,
    width: right - left,
    height: bottom - top,
  };
}

/** Flood-fill padding from image edges; mark those pixels transparent. */
function knockOutPadding(data, width, height, channels) {
  const visited = new Uint8Array(width * height);
  const queue = [];

  const enqueue = (x, y) => {
    const idx = y * width + x;
    if (visited[idx]) return;
    const i = idx * channels;
    if (!isPaddingPixel(data[i], data[i + 1], data[i + 2], data[i + 3])) return;
    visited[idx] = 1;
    queue.push(idx);
  };

  for (let x = 0; x < width; x++) {
    enqueue(x, 0);
    enqueue(x, height - 1);
  }
  for (let y = 0; y < height; y++) {
    enqueue(0, y);
    enqueue(width - 1, y);
  }

  while (queue.length > 0) {
    const idx = queue.pop();
    const x = idx % width;
    const y = (idx - x) / width;
    const alpha = idx * channels + 3;
    data[alpha] = 0;

    if (x > 0) enqueue(x - 1, y);
    if (x < width - 1) enqueue(x + 1, y);
    if (y > 0) enqueue(x, y - 1);
    if (y < height - 1) enqueue(x, y + 1);
  }
}

function centerSquareBounds(width, height) {
  const side = Math.min(width, height);
  return {
    left: Math.floor((width - side) / 2),
    top: Math.floor((height - side) / 2),
    width: side,
    height: side,
  };
}

async function prepareMaster() {
  const trimmed = await sharp(SOURCE).ensureAlpha().trim({ threshold: 10 }).toBuffer();
  const { data, info } = await sharp(trimmed).raw().toBuffer({ resolveWithObject: true });

  const bounds = cornerLooksLikePadding(data, info.width, info.height, info.channels)
    ? contentBounds(data, info.width, info.height, info.channels)
    : centerSquareBounds(info.width, info.height);

  const cropped = await sharp(trimmed).extract(bounds).ensureAlpha().raw().toBuffer({
    resolveWithObject: true,
  });

  if (cornerLooksLikePadding(cropped.data, cropped.info.width, cropped.info.height, cropped.info.channels)) {
    knockOutPadding(cropped.data, cropped.info.width, cropped.info.height, cropped.info.channels);
  }

  return sharp(cropped.data, {
    raw: {
      width: cropped.info.width,
      height: cropped.info.height,
      channels: cropped.info.channels,
    },
  }).png();
}

const master = await prepareMaster();

for (const size of SIZES) {
  const out = path.join(OUT_DIR, `icon${size}.png`);
  await master
    .clone()
    .resize(size, size, { fit: 'fill' })
    .png()
    .toFile(out);
}

fs.copyFileSync(path.join(OUT_DIR, 'icon128.png'), BRAND);
console.log('✓ generate-icons: public/icons/icon{16,32,48,128}.png + src/assets/brand-logo.png');
