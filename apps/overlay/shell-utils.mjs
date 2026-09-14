// Small helpers that are worth keeping out of main.mjs: window geometry and state
// persistence, the pointer -> collapse state machine, and a generated tray icon.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';

/* ------------------------------------------------------------------ geometry */

/**
 * The card's aspect ratio, 1 : 1.8136.
 *
 * Declared in three places because three languages need it - CSS (`--card-aspect`), the
 * renderer (STAGE_ASPECT in ui/src/layout.js) and here. tools/check-shell.mjs compares all
 * three, so a one-sided edit is a test failure rather than a window that no longer fits its
 * card.
 */
export const CARD_ASPECT = 1.8136;

/** Height of the rolled-up bar as a fraction of the card width. Mirror of `--mini-ratio`. */
export const MINI_RATIO = 0.17;

/**
 * Transparent margin around the card, in CSS pixels, so its floating shadow has room to
 * render inside the window instead of being clipped by the window edge. Mirror of
 * `--shadow-pad` in ui/styles/tokens.css.
 */
export const SHADOW_PAD = 24;

/**
 * Card widths. The lower bound is legibility, not taste: below 380px the reference's 4.63u
 * title renders under 17px and the hex labels under 5px. Keep in sync with MIN_STAGE_WIDTH
 * in ui/src/layout.js and `max(380px, ...)` on `--card-w` in ui/styles/tokens.css.
 */
export const CARD_WIDTH_MIN = 380;
export const CARD_WIDTH_MAX = 620;
export const CARD_WIDTH_DEFAULT = 400;

/** Presets offered by the tray menu. */
export const CARD_WIDTH_PRESETS = [
  { label: '小', width: 380 },
  { label: '中', width: 440 },
  { label: '大', width: 520 },
];

/** Window widths, i.e. card + the shadow margin on each side. */
export const MIN_WIDTH = CARD_WIDTH_MIN + SHADOW_PAD * 2;
export const MAX_WIDTH = CARD_WIDTH_MAX + SHADOW_PAD * 2;
export const DEFAULT_WIDTH = CARD_WIDTH_DEFAULT + SHADOW_PAD * 2;

export function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

/**
 * Window size for a wanted card width, in both states.
 *
 * The screen is respected by shrinking the *card*, never by clipping the height. An earlier
 * version clamped the height alone, which silently broke the aspect ratio: the card then
 * overflowed the window and the bottom of it was cut off.
 *
 * @param {number} cardWidth wanted card width in CSS pixels
 * @param {{width:number,height:number}} [workArea]
 * @returns {{cardWidth:number,width:number,height:number,collapsedHeight:number}}
 */
export function fitWindow(cardWidth, workArea) {
  let card = clamp(Math.round(Number(cardWidth) || CARD_WIDTH_DEFAULT), CARD_WIDTH_MIN, CARD_WIDTH_MAX);

  if (workArea?.height) {
    const maxWindowHeight = Math.round(workArea.height * 0.96);
    const largestThatFits = Math.floor((maxWindowHeight - SHADOW_PAD * 2) / CARD_ASPECT);
    // Never below CARD_WIDTH_MIN: an unreadable card is worse than one that overflows a
    // very short screen, which is the same call the stylesheet makes.
    card = clamp(Math.min(card, largestThatFits), CARD_WIDTH_MIN, CARD_WIDTH_MAX);
  }

  return {
    cardWidth: card,
    width: card + SHADOW_PAD * 2,
    height: Math.round(card * CARD_ASPECT) + SHADOW_PAD * 2,
    collapsedHeight: Math.round(card * MINI_RATIO) + SHADOW_PAD * 2,
  };
}

/** The card width a given window width implies. */
export function cardWidthForWindow(windowWidth) {
  return clamp(Math.round(windowWidth) - SHADOW_PAD * 2, CARD_WIDTH_MIN, CARD_WIDTH_MAX);
}

/* ------------------------------------------------- pointer -> collapse state */

/**
 * Decide when the overlay rolls up and when it comes back.
 *
 * A pure state machine rather than logic inlined in the polling loop, because the awkward
 * parts (a hover that must not be interrupted, a collapse that must not immediately undo
 * itself) are exactly what a test can pin down and an eyeball cannot.
 *
 * The hysteresis is:
 *   - collapse only after the pointer has been *outside* the window continuously for
 *     `collapseDelayMs`, so brushing past the edge does not roll the card up;
 *   - expand only after the pointer has been *inside* for `expandDelayMs`. That cannot
 *     oscillate, because the window only ever shrinks to a region inside its expanded
 *     bounds: a pointer outside the expanded window is outside the rolled-up one too, so
 *     reaching the bar always requires a deliberate move back.
 *   - `locked` wins outright.
 */
export function createHoverState(options = {}) {
  const collapseDelayMs = options.collapseDelayMs ?? 600;
  const expandDelayMs = options.expandDelayMs ?? 80;

  let collapsed = false;
  let inside = null;
  let insideSince = null;
  let outsideSince = null;

  return {
    get collapsed() {
      return collapsed;
    },
    get inside() {
      return inside;
    },

    /** Forget where the pointer was; the next update re-adopts it. Used while hidden. */
    reset() {
      inside = null;
      insideSince = null;
      outsideSince = null;
    },

    /**
     * @param {number} now monotonically increasing milliseconds
     * @param {boolean} isInside whether the pointer is within the window bounds
     * @param {boolean} locked user asked for "do not auto-collapse"
     * @returns {boolean} true when `collapsed` changed and the window must be resized
     */
    update(now, isInside, locked = false) {
      if (inside === null) {
        inside = isInside;
        if (isInside) insideSince = now;
        else outsideSince = now;
      } else if (isInside !== inside) {
        inside = isInside;
        if (isInside) {
          insideSince = now;
          outsideSince = null;
        } else {
          outsideSince = now;
          insideSince = null;
        }
      }

      if (locked) {
        if (!collapsed) return false;
        collapsed = false;
        return true;
      }

      if (!collapsed) {
        if (inside || outsideSince === null) return false;
        if (now - outsideSince < collapseDelayMs) return false;
        collapsed = true;
        return true;
      }

      if (!inside || insideSince === null) return false;
      if (now - insideSince < expandDelayMs) return false;
      collapsed = false;
      return true;
    },
  };
}

/* ---------------------------------------------------------------- window state */

/**
 * Remember the card width and where the window was, so reopening it does not move it.
 *
 * Stores the *card* width rather than the window width, because the window width carries the
 * shadow margin - which is a rendering detail that has already changed once, and a persisted
 * window width would have silently changed the card size with it.
 */
export function loadWindowState(file, displayBounds) {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    const stored = Number(raw.cardWidth);
    const legacy = Number(raw.width);
    // Older files stored the window width; recover the card width from it.
    const wanted = Number.isFinite(stored) && stored > 0 ? stored : legacy - SHADOW_PAD * 2;
    const cardWidth = clamp(Math.round(wanted) || CARD_WIDTH_DEFAULT, CARD_WIDTH_MIN, CARD_WIDTH_MAX);
    const x = Number.isFinite(raw.x) ? raw.x : undefined;
    const y = Number.isFinite(raw.y) ? raw.y : undefined;
    // Reject a position that is no longer on any display (monitor unplugged).
    const onScreen =
      x !== undefined &&
      y !== undefined &&
      displayBounds.some((b) => x >= b.x - 20 && x < b.x + b.width && y >= b.y - 20 && y < b.y + b.height);
    return { cardWidth, x: onScreen ? x : undefined, y: onScreen ? y : undefined };
  } catch {
    return { cardWidth: CARD_WIDTH_DEFAULT, x: undefined, y: undefined };
  }
}

export function saveWindowState(file, state) {
  try {
    writeFileSync(
      file,
      JSON.stringify({ cardWidth: state.cardWidth, x: state.x, y: state.y }, null, 2),
      'utf8',
    );
  } catch {
    // A failed write only costs the remembered position.
  }
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
