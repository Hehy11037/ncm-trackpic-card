#!/usr/bin/env node
// Precise measurement of the reference layout via connected-component labelling.
//
//   node tools/measure-reference.mjs <image.png>
//
// Previous attempts guessed from a screenshot and were wrong repeatedly. This reads
// the PNG, finds every distinct element as a connected region of non-background
// pixels, and reports exact bounding boxes, heights and gaps - which is what the
// stylesheet actually needs. Everything is reported both in pixels and in `u`
// (1u = 1% of the image width), so the numbers transfer to the card directly.

import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';

const file = process.argv[2];
if (!file) {
  console.error('usage: node tools/measure-reference.mjs <image.png>');
  process.exit(1);
}

/* --------------------------------------------------------------- PNG decoding */

const buffer = readFileSync(file);
let offset = 8;
let width = 0;
let height = 0;
let bitDepth = 0;
let colorType = 0;
const idat = [];
while (offset < buffer.length) {
  const length = buffer.readUInt32BE(offset);
  const type = buffer.toString('ascii', offset + 4, offset + 8);
  const data = buffer.subarray(offset + 8, offset + 8 + length);
  if (type === 'IHDR') {
    width = data.readUInt32BE(0);
    height = data.readUInt32BE(4);
    bitDepth = data[8];
    colorType = data[9];
    if (data[12] !== 0) {
      console.error('interlaced PNGs unsupported');
      process.exit(1);
    }
  } else if (type === 'IDAT') idat.push(data);
  else if (type === 'IEND') break;
  offset += 12 + length;
}
const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[colorType];
if (bitDepth !== 8 || !channels) {
  console.error(`unsupported PNG (depth ${bitDepth}, type ${colorType})`);
  process.exit(1);
}

const raw = inflateSync(Buffer.concat(idat));
const stride = width * channels;
const pixels = Buffer.alloc(height * stride);
for (let y = 0; y < height; y++) {
  const filter = raw[y * (stride + 1)];
  const source = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
  const target = pixels.subarray(y * stride, (y + 1) * stride);
  const prior = y > 0 ? pixels.subarray((y - 1) * stride, y * stride) : null;
  for (let x = 0; x < stride; x++) {
    const a = x >= channels ? target[x - channels] : 0;
    const b = prior ? prior[x] : 0;
    const c = prior && x >= channels ? prior[x - channels] : 0;
    const v = source[x];
    let out;
    switch (filter) {
      case 1: out = v + a; break;
      case 2: out = v + b; break;
      case 3: out = v + ((a + b) >> 1); break;
      case 4: {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        out = v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
        break;
      }
      default: out = v;
    }
    target[x] = out & 0xff;
  }
}

const at = (x, y) => {
  const i = y * stride + x * channels;
  return [pixels[i], pixels[i + 1], pixels[i + 2]];
};
const dist = (a, b) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]);

function modal(list) {
  const counts = new Map();
  for (const [r, g, b] of list) {
    const key = `${r >> 2},${g >> 2},${b >> 2}`;
    const entry = counts.get(key) ?? { count: 0, sum: [0, 0, 0] };
    entry.count++;
    entry.sum[0] += r;
    entry.sum[1] += g;
    entry.sum[2] += b;
    counts.set(key, entry);
  }
  let best = null;
  for (const entry of counts.values()) if (!best || entry.count > best.count) best = entry;
  return best ? best.sum.map((s) => Math.round(s / best.count)) : [0, 0, 0];
}

const page = modal([
  ...Array.from({ length: width }, (_, x) => at(x, 2)),
  ...Array.from({ length: width }, (_, x) => at(x, height - 3)),
]);
console.log(`image ${width} x ${height}   1u = ${(width / 100).toFixed(2)}px`);
console.log(`page background rgb(${page.join(', ')})`);

// "Ink" = meaningfully different from the page background.
const INK_THRESHOLD = 26;
const ink = new Uint8Array(width * height);
for (let y = 0; y < height; y++) {
  for (let x = 0; x < width; x++) {
    ink[y * width + x] = dist(at(x, y), page) > INK_THRESHOLD ? 1 : 0;
  }
}

/* --------------------------------------------- connected components (row spans) */

const label = new Int32Array(width * height).fill(-1);
const components = [];

for (let y = 0; y < height; y++) {
  for (let x = 0; x < width; x++) {
    const index = y * width + x;
    if (!ink[index] || label[index] >= 0) continue;

    // Flood fill this component (4-connected).
    const stack = [index];
    label[index] = components.length;
    let minX = x;
    let maxX = x;
    let minY = y;
    let maxY = y;
    let size = 0;

    while (stack.length) {
      const current = stack.pop();
      const cy = Math.floor(current / width);
      const cx = current % width;
      size++;
      if (cx < minX) minX = cx;
      if (cx > maxX) maxX = cx;
      if (cy < minY) minY = cy;
      if (cy > maxY) maxY = cy;

      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = cx + dx;
        const ny = cy + dy;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const next = ny * width + nx;
        if (!ink[next] || label[next] >= 0) continue;
        label[next] = components.length;
        stack.push(next);
      }
    }

    components.push({ minX, maxX, minY, maxY, size });
  }
}

// Keep components big enough to be real elements, then merge those that overlap
// vertically and are close horizontally (e.g. the letters of one line).
const MIN_SIZE = 12;
const real = components.filter((c) => c.size >= MIN_SIZE && c.maxY - c.minY >= 1);
console.log(`\ncomponents: ${components.length} total, ${real.length} kept`);

function mergeRows(items, verticalGap = 6, horizontalOverlap = true) {
  const sorted = [...items].sort((a, b) => a.minY - b.minY || a.minX - b.minX);
  const out = [];
  for (const item of sorted) {
    const last = out[out.length - 1];
    const overlapsV = last && item.minY <= last.maxY + verticalGap;
    const overlapsH =
      last && !(item.maxX < last.minX - 8 || item.minX > last.maxX + 8);
    if (overlapsV && (!horizontalOverlap || overlapsH)) {
      last.minX = Math.min(last.minX, item.minX);
      last.maxX = Math.max(last.maxX, item.maxX);
      last.maxY = Math.max(last.maxY, item.maxY);
      last.size += item.size;
    } else {
      out.push({ ...item });
    }
  }
  return out;
}

const rows = mergeRows(real, 8, true).sort((a, b) => a.minY - b.minY);

const u = (px) => (px / width) * 100;
console.log('\n=== 元素（自上而下）===');
console.log('   #   y(px)        x(px)      高(px)  宽(px)   顶部u    高u     说明');
let previous = null;
rows.forEach((r, i) => {
  const h = r.maxY - r.minY + 1;
  const w = r.maxX - r.minX + 1;
  if (h < 2 && w < 2) return;
  const gap = previous ? r.minY - previous.maxY - 1 : r.minY;
  const note = `${gap > 0 ? `与上一块间隔 ${gap}px = ${u(gap).toFixed(2)}u` : ''}`;
  console.log(
    `  ${String(i).padStart(3)}  ${String(r.minY).padStart(5)}..${String(r.maxY).padStart(5)}  ` +
      `${String(r.minX).padStart(4)}..${String(r.maxX).padStart(4)}  ${String(h).padStart(5)}  ${String(w).padStart(5)}  ` +
      `${u(r.minY).toFixed(2).padStart(7)}  ${u(h).toFixed(2).padStart(6)}  ${note}`,
  );
  previous = r;
});
