// Small helpers that are worth keeping out of main.mjs: window geometry and state
// persistence, and a generated tray icon.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';

/* ------------------------------------------------------------------ geometry */

/** The card's aspect ratio, 1 : 1.8136. Must match .stage in ui/styles/tokens.css. */
export const CARD_ASPECT = 181.36 / 100;

/** Sensible bounds so the window is neither unusable nor enormous. */
export const MIN_WIDTH = 260;
export const MAX_WIDTH = 620;
export const DEFAULT_WIDTH = 400;

/** Window height for a given width, clamped to the screen. */
export function heightForWidth(width, workArea) {
  const height = Math.round(width * CARD_ASPECT);
  if (!workArea) return height;
  // Never taller than the usable screen height, so the card cannot run off the bottom.
  return Math.min(height, Math.round(workArea.height * 0.96));
}

/* ---------------------------------------------------------------- window state */

/** Where the window was last, so reopening it does not move it. */
export function loadWindowState(file, displayBounds) {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    const width = clamp(Number(raw.width) || DEFAULT_WIDTH, MIN_WIDTH, MAX_WIDTH);
    const x = Number.isFinite(raw.x) ? raw.x : undefined;
    const y = Number.isFinite(raw.y) ? raw.y : undefined;
    // Reject a position that is no longer on any display (monitor unplugged).
    const onScreen =
      x !== undefined &&
      y !== undefined &&
      displayBounds.some((b) => x >= b.x - 20 && x < b.x + b.width && y >= b.y - 20 && y < b.y + b.height);
    return { width, x: onScreen ? x : undefined, y: onScreen ? y : undefined };
  } catch {
    return { width: DEFAULT_WIDTH, x: undefined, y: undefined };
  }
}

export function saveWindowState(file, bounds) {
  try {
    writeFileSync(
      file,
      JSON.stringify({ width: bounds.width, x: bounds.x, y: bounds.y }, null, 2),
      'utf8',
    );
  } catch {
    // A failed write only costs the remembered position.
  }
}

export function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

/* ----------------------------------------------------------------- tray icon */

/**
 * Build a PNG in memory for the tray and window icon.
 *
 * Generating it avoids shipping a binary asset for something this small, and lets the icon
 * take the card's accent colour so it matches the overlay.
 *
 * @param {{r:number,g:number,b:number}} color
 * @param {number} size
 * @returns {Buffer} PNG bytes
 */
export function makeIconPng(color, size = 32) {
  const rgba = Buffer.alloc(size * size * 4);
  const radius = size * 0.22; // rounded-square corner radius
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const inside = isInsideRoundedRect(x, y, size, radius);
      // A play triangle in the middle, on a transparent background.
      const play = inside && isInsidePlayTriangle(x, y, size);
      if (!inside) {
        rgba[i + 3] = 0;
        continue;
      }
      rgba[i] = play ? 255 : color.r;
      rgba[i + 1] = play ? 255 : color.g;
      rgba[i + 2] = play ? 255 : color.b;
      rgba[i + 3] = 255;
    }
  }
  return encodePng(size, size, rgba);
}

function isInsideRoundedRect(x, y, size, radius) {
  const cx = Math.min(x, size - 1 - x);
  const cy = Math.min(y, size - 1 - y);
  if (cx >= radius || cy >= radius) return true;
  const dx = radius - cx;
  const dy = radius - cy;
  return dx * dx + dy * dy <= radius * radius;
}

function isInsidePlayTriangle(x, y, size) {
  // Triangle pointing right, inset so it reads at 16px.
  const left = size * 0.36;
  const right = size * 0.7;
  const centre = size * 0.5;
  const half = size * 0.22;
  if (x < left || x > right) return false;
  const t = (x - left) / (right - left);
  const spread = half * (1 - t);
  return Math.abs(y - centre) <= spread;
}

/** Minimal PNG encoder: 8-bit RGBA, stored with zlib deflate. */
function encodePng(width, height, rgba) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  // Each scanline is prefixed with its filter type (0 = none).
  const raw = Buffer.alloc(height * (width * 4 + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }

  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData) >>> 0, 0);
  return Buffer.concat([length, typeAndData, crc]);
}

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return c ^ 0xffffffff;
}

export function stateFilePath(userDataDir) {
  return join(userDataDir, 'window-state.json');
}
