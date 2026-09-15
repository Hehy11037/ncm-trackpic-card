#!/usr/bin/env node
// Draw the two draggable bars - the progress bar and the volume panel - from the numbers in the
// stylesheet.
//
//   node tools/render-controls.mjs [--out .scratch/controls] [--unit 8.8]
//
// `npm run icons` draws the SVG glyphs; this draws the things that are not SVG at all. Both bars are
// ordinary boxes with a fill and a thumb positioned by percentage, and every one of those numbers is
// in `card.css` - so they can be reconstructed exactly, which is the only way to see them without a
// browser.
//
// What it is for: the thumb's position at 0% and 100% (it is centred on the end, so it overhangs the
// track), the fill's proportions, and the volume panel's own layout next to the bar it belongs to.
// Text is not drawn - fonts are not available here - so the volume readout is a placeholder block of
// its declared `min-width`, which is all the layout depends on.

import { mkdirSync, writeFileSync } from 'node:fs';

import { makeCssReader, readStyle } from './css-values.mjs';
import { encodePng } from './svg-path.mjs';
import { transportRowLayout } from './transport-layout.mjs';

function parseArgs(argv) {
  const out = { out: '.scratch/controls', unit: 8.8 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') out.out = argv[++i];
    else if (a === '--unit') out.unit = Number(argv[++i]);
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const tokensText = readStyle('ui/styles/tokens.css');
const cardText = readStyle('ui/styles/card.css');
const css = makeCssReader({ tokens: tokensText, rules: `${tokensText}\n${cardText}` });
const layout = transportRowLayout(css);

/* ------------------------------------------------------------------ canvas */

const INK = [28, 28, 30];
const TRACK = [214, 216, 222];
const FAINT = [236, 238, 242];

function createCanvas(width, height) {
  const rgba = Buffer.alloc(width * height * 4, 255);
  for (let i = 3; i < rgba.length; i += 4) rgba[i] = 255;
  return { rgba, width, height };
}

/** Blend one pixel with coverage `a`. */
function blend(canvas, x, y, color, a) {
  if (a <= 0 || x < 0 || y < 0 || x >= canvas.width || y >= canvas.height) return;
  const at = (y * canvas.width + x) * 4;
  for (let channel = 0; channel < 3; channel++) {
    canvas.rgba[at + channel] = Math.round(canvas.rgba[at + channel] * (1 - a) + color[channel] * a);
  }
}

/**
 * A rounded rectangle, 4x supersampled, in device pixels.
 *
 * `radius` of half the height is what `border-radius: 999px` resolves to on these bars, which is why
 * the ends read as circles rather than as square caps.
 */
function roundRect(canvas, x, y, width, height, radius, color) {
  const steps = 4;
  const r = Math.max(0, Math.min(radius, width / 2, height / 2));
  for (let py = Math.floor(y * steps); py < Math.ceil((y + height) * steps); py++) {
    for (let px = Math.floor(x * steps); px < Math.ceil((x + width) * steps); px++) {
      const cx = (px + 0.5) / steps;
      const cy = (py + 0.5) / steps;
      // Distance to the rounded rect: shrink the box by r, then measure from the corner.
      const dx = Math.max(x + r - cx, 0, cx - (x + width - r));
      const dy = Math.max(y + r - cy, 0, cy - (y + height - r));
      const inside = dx * dx + dy * dy <= r * r && cx >= x && cx <= x + width && cy >= y && cy <= y + height;
      if (inside) blend(canvas, Math.floor(px / steps), Math.floor(py / steps), color, 1 / (steps * steps));
    }
  }
}

const circle = (canvas, cx, cy, radius, color) => roundRect(canvas, cx - radius, cy - radius, radius * 2, radius * 2, radius, color);

/* ------------------------------------------------------------- progress bar */

const trackTop = 6; // in u, where each preview strip puts its bar
const trackHeight = css.value('.progress-track', 'height');
const trackLeft = layout.padding.left;
const trackWidth = layout.rowWidth;
const thumbSize = css.value('.progress-thumb', 'size') || css.value('.progress-thumb', 'width');
const scrubSpread = 0.31; // the box-shadow's spread, also from the stylesheet geometry

function drawProgressRow(fraction, { scrubbing = false } = {}) {
  const unit = args.unit;
  const height = Math.round((trackTop * 2 + Math.max(trackHeight + 2 * scrubSpread, thumbSize)) * unit);
  const canvas = createCanvas(Math.round(100 * unit), height);
  const y = trackTop * unit;
  const h = trackHeight * unit;
  const x = trackLeft * unit;
  const w = trackWidth * unit;

  // The scrubbing ring first, so it reads as *behind* the track (a box-shadow does not paint over
  // the element's own background).
  if (scrubbing) {
    roundRect(canvas, x - scrubSpread * unit, y - scrubSpread * unit, w + 2 * scrubSpread * unit, h + 2 * scrubSpread * unit, (h + 2 * scrubSpread * unit) / 2, TRACK);
  }
  roundRect(canvas, x, y, w, h, h / 2, TRACK);
  roundRect(canvas, x, y, w * fraction, h, h / 2, INK);
  const thumbCentre = x + w * fraction;
  const thumbRadius = (thumbSize * unit) / 2;
  circle(canvas, thumbCentre, y + h / 2, thumbRadius, INK);
  return canvas;
}

/* -------------------------------------------------------------- volume panel */

const volumeBarWidth = css.value('.volume-bar', 'width');
const volumeBarHeight = css.value('.volume-bar', 'height');
const popPaddingY = css.shorthand('.volume-pop', 'padding', 0);
const popPaddingX = css.shorthand('.volume-pop', 'padding', 3);
const popGap = css.value('.volume-pop', 'gap');
const valueWidth = css.value('.volume-pop__value', 'min-width');
const volumeThumb = css.value('.volume-bar__thumb', 'width');
const popRight = layout.popover.right;
const popLeft = layout.popover.left;
const popHeight = popPaddingY * 2 + Math.max(volumeBarHeight, volumeThumb);

function drawVolumePanel(fraction) {
  const unit = args.unit;
  const height = Math.round((6 + popHeight + 6) * unit);
  const canvas = createCanvas(Math.round(100 * unit), height);
  const top = 6 * unit;
  const h = popHeight * unit;

  // The panel itself.
  roundRect(canvas, popLeft * unit, top, (popRight - popLeft) * unit, h, 1 * unit, FAINT);
  // The readout: text is not drawable here, so its declared box is drawn instead.
  roundRect(canvas, popLeft * unit + popPaddingX * unit, top + popPaddingY * unit, valueWidth * unit, h - 2 * popPaddingY * unit, 0.4 * unit, TRACK);
  // The bar.
  const barX = (popLeft + popPaddingX + valueWidth + popGap) * unit;
  const barY = top + h / 2 - (volumeBarHeight * unit) / 2;
  roundRect(canvas, barX, barY, volumeBarWidth * unit, volumeBarHeight * unit, (volumeBarHeight * unit) / 2, TRACK);
  roundRect(canvas, barX, barY, volumeBarWidth * unit * fraction, volumeBarHeight * unit, (volumeBarHeight * unit) / 2, INK);
  circle(canvas, barX + volumeBarWidth * unit * fraction, barY + (volumeBarHeight * unit) / 2, (volumeThumb * unit) / 2, INK);
  return canvas;
}

/* ------------------------------------------------------------------- output */

mkdirSync(args.out, { recursive: true });
const written = [];
const write = (name, canvas) => {
  const file = `${args.out}/${name}.png`;
  writeFileSync(file, encodePng(canvas.rgba, canvas.width, canvas.height));
  written.push(file);
};

/**
 * How tall the bar actually is in the rendered image, at one column.
 *
 * The picture is the point, but "looks about right" is not a measurement, and the two states that
 * are supposed to differ (idle and scrubbing) differ by 0.62u - exactly the sort of difference the
 * eye forgives. Counting the non-background rows in a column says whether the drawing code produced
 * the shape the stylesheet asked for.
 *
 * Note what this does and does not prove: the numbers drawn *come from* `card.css`, so this is a
 * check of the rasteriser (that a rounded rect of h device pixels really is h pixels tall), not a
 * second opinion about the design. The design's own assertions live in `check-interaction.mjs`.
 */
function barHeightAt(canvas, x) {
  let rows = 0;
  for (let y = 0; y < canvas.height; y++) {
    const at = (y * canvas.width + x) * 4;
    const [r, g, b] = [canvas.rgba[at], canvas.rgba[at + 1], canvas.rgba[at + 2]];
    if (r < 250 || g < 250 || b < 250) rows++;
  }
  return rows;
}

for (const fraction of [0, 0.5, 1]) {
  write(`progress-${Math.round(fraction * 100)}`, drawProgressRow(fraction));
}
write('progress-scrubbing-50', drawProgressRow(0.5, { scrubbing: true }));
for (const fraction of [0, 0.5, 1]) {
  write(`volume-${Math.round(fraction * 100)}`, drawVolumePanel(fraction));
}

// Measured, not eyeballed: the idle bar and the scrubbing bar are supposed to differ, by 0.62u.
const idleCanvas = drawProgressRow(0.5);
const scrubCanvas = drawProgressRow(0.5, { scrubbing: true });
const probeX = Math.round((trackLeft + trackWidth * 0.25) * args.unit);
const idleHeight = barHeightAt(idleCanvas, probeX);
const scrubHeight = barHeightAt(scrubCanvas, probeX);
const expectedIdle = Math.round(trackHeight * args.unit);
const expectedScrub = Math.round((trackHeight + 2 * scrubSpread) * args.unit);
const measured = [
  ['空闲时画出的高度', idleHeight, expectedIdle],
  ['拖动时画出的高度', scrubHeight, expectedScrub],
];

console.log(`按 ${args.unit}px/u 画（卡片实际约 4.4px/u）：`);
for (const file of written) console.log(`  ${file}`);
console.log(
  `\n进度条: 轨道 ${trackLeft.toFixed(2)}u → ${(trackLeft + trackWidth).toFixed(2)}u，高 ${trackHeight}u；` +
    `滑块 ${thumbSize}u，中心跟着百分比走（所以 0% 和 100% 时各自探出轨道 ${(thumbSize / 2).toFixed(2)}u）`,
);
console.log(
  `音量面板: ${popLeft.toFixed(2)}u → ${popRight.toFixed(2)}u（宽 ${(popRight - popLeft).toFixed(2)}u），` +
    `音量条 ${volumeBarWidth}x${volumeBarHeight}u，滑块 ${volumeThumb}u`,
);
console.log(`\n渲染器自检（画出的像素 vs 样式表里写的数）：`);
let failures = 0;
for (const [label, actual, expected] of measured) {
  const ok = Math.abs(actual - expected) <= 1;
  if (!ok) failures++;
  console.log(`  ${ok ? '✓' : '✗'} ${label} ${actual}px，样式表要求 ${expected}px`);
}
console.log(`\n${failures ? '✗ 绘制和数字对不上' : '✓ 绘制与样式表的数字一致'}`);
process.exit(failures ? 1 : 0);
