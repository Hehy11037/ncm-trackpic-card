#!/usr/bin/env node
// Measure an icon reference image, and compare an icon against it.
//
//   node tools/measure-icon.mjs <reference.png> [--compare <my-256.png>]
//
// The owner sent a finished icon and said, plainly, not to change the inner pattern or the colours.
// That rules out designing *from* it - the numbers have to come *out of* it. So this reads the
// reference's pixels and reports every part of the mark in a 24-unit box:
//
//   * the red disc's bounding box, and the navy circle's, which gives the ratio between them;
//   * the white glyph's connected pieces - the outlined play triangle and each pause bar;
//   * the sliver of red at the triangle's tip;
//   * the exact colour of each part, taken as the modal colour of its region rather than guessed.
//
// With `--compare` it also classifies the pixels of a rendered icon the same way, aligns the two by
// the red disc, and reports how many pixels disagree - because "looks the same" is not a measurement
// and this is a reproduction, not an interpretation.

import { readFileSync } from 'node:fs';

import { decodePng, distance, pixelAt } from './lib/png.mjs';

const argv = process.argv.slice(2);
const file = argv[0];
const compareAt = argv.indexOf('--compare');
const compareFile = compareAt >= 0 ? argv[compareAt + 1] : null;
if (!file) {
  console.error('usage: node tools/measure-icon.mjs <reference.png> [--compare <icon.png>]');
  process.exit(1);
}

/* --------------------------------------------------------------- classification */

/**
 * Which part of the mark a pixel belongs to.
 *
 * Thresholds on hue rather than on fixed colours, so the reference's antialiasing and its very slight
 * gradient do not split a region in two. White and near-white is background *or* glyph; the two are
 * told apart by whether the pixel is inside the navy circle.
 */
function classify(rgb) {
  const [r, g, b] = rgb;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max - min < 26 && max > 224) return 'white';
  if (max - min < 30 && max < 90) return 'dark';
  if (r > 110 && r - g > 60 && r - b > 60) return 'red';
  return 'other';
}

/** The bounding box of every pixel of a class, or null. The predicate gets (pixel, x, y). */
function boundsOf(image, predicate) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let count = 0;
  for (let y = 0; y < image.height; y++) {
    for (let x = 0; x < image.width; x++) {
      if (!predicate(pixelAt(image, x, y), x, y)) continue;
      count++;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }
  return count ? { minX, minY, maxX, maxY, count, width: maxX - minX + 1, height: maxY - minY + 1 } : null;
}

/** The bounding box of a colour class, ignoring position. */
const boxOfClass = (image, name) => boundsOf(image, (p) => classify(p) === name);

/** The most common colour in a region, rounded to whole channels. The predicate gets (pixel, x, y). */
function modalColour(image, predicate) {
  const tally = new Map();
  for (let y = 0; y < image.height; y++) {
    for (let x = 0; x < image.width; x++) {
      const pixel = pixelAt(image, x, y);
      if (!predicate(pixel, x, y)) continue;
      const key = `${pixel[0] >> 2},${pixel[1] >> 2},${pixel[2] >> 2}`;
      const entry = tally.get(key) ?? { count: 0, sum: [0, 0, 0] };
      entry.count++;
      entry.sum[0] += pixel[0];
      entry.sum[1] += pixel[1];
      entry.sum[2] += pixel[2];
      tally.set(key, entry);
    }
  }
  let best = null;
  for (const entry of tally.values()) if (!best || entry.count > best.count) best = entry;
  if (!best) return null;
  return best.sum.map((v) => Math.round(v / best.count));
}

/* --------------------------------------------------------------------- measure */

const image = decodePng(readFileSync(file));
const isRed = (p) => classify(p) === 'red';
const isDark = (p) => classify(p) === 'dark';
const isWhite = (p) => classify(p) === 'white';

const red = boxOfClass(image, 'red');
const navy = boxOfClass(image, 'dark');
if (!red || !navy) {
  console.error('could not find both the red disc and the navy circle');
  process.exit(1);
}

const navyInside = (p, x, y) =>
  isWhite(p) && x >= navy.minX && x <= navy.maxX && y >= navy.minY && y <= navy.maxY;
const navyR = navy.width / 2;
const navyCx = navy.minX + navyR;
const navyCy = navy.minY + navyR;
/**
 * The sliver of red at the triangle's tip.
 *
 * "Red inside the navy circle's bounding box" also catches the circle's own antialiased edge, where
 * navy meets red and the pixels are brownish - which made the first measurement report the whole
 * circle. So the probe stays a few pixels inside the rim.
 */
const redInside = (p, x, y) =>
  isRed(p) && Math.hypot(x - navyCx, y - navyCy) < navyR - 4;
const whiteInside = boundsOf(image, navyInside);
const tip = boundsOf(image, redInside);

console.log(`参考图 ${image.width}x${image.height}`);
console.log(`  红盘    bbox ${red.minX},${red.minY} → ${red.maxX},${red.maxY}  直径 ${red.width}  颜色 ${modalColour(image, isRed)}`);
console.log(`  蓝圆    bbox ${navy.minX},${navy.minY} → ${navy.maxX},${navy.maxY}  直径 ${navy.width}  颜色 ${modalColour(image, isDark)}`);
console.log(
  `  蓝圆/红盘 = ${(navy.width / red.width).toFixed(4)}   圆心偏移 ${(navy.minX + navy.width / 2 - (red.minX + red.width / 2)).toFixed(1)},${(navy.minY + navy.height / 2 - (red.minY + red.height / 2)).toFixed(1)}`,
);
if (whiteInside) {
  console.log(`  白图形  bbox ${whiteInside.minX},${whiteInside.minY} → ${whiteInside.maxX},${whiteInside.maxY}  颜色 ${modalColour(image, navyInside)}`);
}
if (tip) {
  console.log(`  尖端红  bbox ${tip.minX},${tip.minY} → ${tip.maxX},${tip.maxY}  颜色 ${modalColour(image, (p, x, y) => isRed(p) && x > navy.minX && x < navy.maxX && y > navy.minY && y < navy.maxY)}`);
}

/*
 * The white glyph, split into its vertically separated pieces: scanning columns and grouping them by
 * whether any white pixel appears makes the triangle and the two bars come out as three runs.
 */
const columns = [];
for (let x = navy.minX; x <= navy.maxX; x++) {
  let top = Infinity;
  let bottom = -Infinity;
  let count = 0;
  for (let y = navy.minY; y <= navy.maxY; y++) {
    if (!navyInside(pixelAt(image, x, y), x, y)) continue;
    count++;
    if (y < top) top = y;
    if (y > bottom) bottom = y;
  }
  columns.push({ x, top, bottom, count });
}
const runs = [];
let current = null;
for (const column of columns) {
  if (column.count > 0) {
    if (!current) current = { from: column.x, to: column.x, top: Infinity, bottom: -Infinity };
    current.to = column.x;
    current.top = Math.min(current.top, column.top);
    current.bottom = Math.max(current.bottom, column.bottom);
  } else if (current) {
    runs.push(current);
    current = null;
  }
}
if (current) runs.push(current);

const to24 = (value) => (value * 24) / red.width;
console.log('\n换算到 24 单位（红盘直径 = 24，圆心 = 12,12）:');
console.log(`  红盘半径 ${(to24(red.width) / 2).toFixed(2)}   蓝圆半径 ${(to24(navy.width) / 2).toFixed(2)}`);
console.log(`  蓝圆心 ${to24(navy.minX + navy.width / 2 - red.minX).toFixed(2)},${to24(navy.minY + navy.height / 2 - red.minY).toFixed(2)}`);
for (const run of runs) {
  const left = to24(run.from - red.minX);
  const right = to24(run.to - red.minX);
  const top = to24(run.top - red.minY);
  const bottom = to24(run.bottom - red.minY);
  console.log(
    `  白块 x ${left.toFixed(2)}→${right.toFixed(2)}（宽 ${(right - left).toFixed(2)}）  y ${top.toFixed(2)}→${bottom.toFixed(2)}（高 ${(bottom - top).toFixed(2)}）`,
  );
}
if (tip) {
  console.log(
    `  尖端红 x ${to24(tip.minX - red.minX).toFixed(2)}→${to24(tip.maxX - red.minX).toFixed(2)}  y ${to24(tip.minY - red.minY).toFixed(2)}→${to24(tip.maxY - red.minY).toFixed(2)}`,
  );
}
// The stroke width: the white band's thickness measured *across* the triangle's left edge, which is
// vertical - so a horizontal probe at the glyph's vertical centre crosses it once.
const leftRun = runs[0];
if (leftRun) {
  const probeY = Math.round((leftRun.top + leftRun.bottom) / 2);
  let thickness = 0;
  for (let x = navy.minX; x <= navy.maxX; x++) {
    if (!navyInside(pixelAt(image, x, probeY), x, probeY)) continue;
    thickness++;
    // Stop at the first gap: that is the inside of the triangle.
    if (!navyInside(pixelAt(image, x + 1, probeY), x + 1, probeY)) break;
  }
  console.log(`  左侧描边厚度 ≈ ${to24(thickness).toFixed(2)} 单位（在 y=${to24(probeY - red.minY).toFixed(2)} 处横向量得）`);
}

/*
 * Whether the pause bars are rounded: compare each bar's width at its top row with its width at the
 * middle. A square-ended bar is the same width; a rounded one is narrower at the end.
 */
for (const [index, run] of runs.slice(1).entries()) {
  const widthAt = (y) => {
    let count = 0;
    for (let x = run.from; x <= run.to; x++) if (navyInside(pixelAt(image, x, y), x, y)) count++;
    return count;
  };
  const middle = Math.round((run.top + run.bottom) / 2);
  console.log(
    `  暂停条 ${index + 1}: 宽 ${to24(run.to - run.from + 1).toFixed(2)}  高 ${to24(run.bottom - run.top + 1).toFixed(2)}` +
      `  顶端宽 ${to24(widthAt(run.top + 1)).toFixed(2)}  中间宽 ${to24(widthAt(middle)).toFixed(2)}（差 ${to24(widthAt(middle) - widthAt(run.top + 1)).toFixed(2)} → ${widthAt(middle) - widthAt(run.top + 1) > 2 ? '圆头' : '方头'}）`,
  );
}
// Where each bar sits, and where the tip's red is.
const to24x = (value) => to24(value - red.minX);
const to24y = (value) => to24(value - red.minY);
runs.slice(1).forEach((run, index) => {
  console.log(`  暂停条 ${index + 1} 位置 x ${to24x(run.from).toFixed(2)}→${to24x(run.to).toFixed(2)}  y ${to24y(run.top).toFixed(2)}→${to24y(run.bottom).toFixed(2)}`);
});

/* --------------------------------------------------------------------- compare */

if (compareFile) {
  const mine = decodePng(readFileSync(compareFile));
  const mineRed = boundsOf(mine, isRed);
  if (!mineRed) {
    console.error(`\n对照图 ${compareFile} 里找不到红盘`);
    process.exit(1);
  }
  const scale = mineRed.width / red.width;
  /**
   * Read a rendered icon as it would appear on a white page.
   *
   * The icon has a transparent background and the reference was saved on white. Without compositing,
   * every corner differs and the comparison reports 20% before a single shape is considered - which
   * is exactly what the first run of this did.
   */
  const mineAt = (x, y) => {
    const pixel = pixelAt(mine, x, y);
    const a = pixel[3] / 255;
    return [
      Math.round(pixel[0] * a + 255 * (1 - a)),
      Math.round(pixel[1] * a + 255 * (1 - a)),
      Math.round(pixel[2] * a + 255 * (1 - a)),
    ];
  };

  let same = 0;
  let total = 0;
  const confusion = new Map();
  // The outermost 2% is antialiasing in both images and says nothing about the shapes.
  const rim = red.width * 0.02;
  for (let y = 0; y < red.height; y++) {
    for (let x = 0; x < red.width; x++) {
      const px = red.minX + x;
      const py = red.minY + y;
      if (Math.hypot(px - (red.minX + red.width / 2), py - (red.minY + red.height / 2)) > red.width / 2 - rim) {
        continue;
      }
      const mineX = Math.round(mineRed.minX + x * scale);
      const mineY = Math.round(mineRed.minY + y * scale);
      if (mineX >= mine.width || mineY >= mine.height) continue;
      const a = classify(pixelAt(image, px, py));
      const b = classify(mineAt(mineX, mineY));
      total++;
      if (a === b) same++;
      else {
        const key = `${a}→${b}`;
        confusion.set(key, (confusion.get(key) ?? 0) + 1);
      }
    }
  }
  const mismatch = 100 * (1 - same / total);
  console.log(`\n与参考图逐像素比较（按红盘对齐，只看盘内、去掉最外 2% 锯齿带，共 ${total} 点）:`);
  console.log(`  不一致 ${mismatch.toFixed(2)}%`);
  [...confusion.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .forEach(([key, count]) => console.log(`    ${key.padEnd(12)} ${count} 点 (${((100 * count) / total).toFixed(2)}%)`));
  void distance;
}
