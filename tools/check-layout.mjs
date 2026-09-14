// Verify the card's vertical layout against the reference's measured positions.
//
//   node tools/check-layout.mjs
//
// No browser is available in this environment, so this recomputes where each element
// lands by resolving the stylesheet's custom properties and summing the boxes and
// margins, then compares the result with the reference measurements (1080x1920, so
// 1u = 10.8px). It is the check that catches "type three times too small" or "the
// cover is squashed" without needing a screenshot.
//
// Three parsing traps are handled explicitly, each of which caused a silent hang or
// crash while this script was being written:
//   1. `calc(var(--u) * 2.6)` has nested parentheses - a regex cannot strip `calc()`.
//   2. A declaration must not run past `{` into the next rule.
//   3. A shorthand's components contain spaces inside parentheses, so splitting on
//      whitespace is wrong.

import { readFileSync } from 'node:fs';

const tokens = readFileSync('ui/styles/tokens.css', 'utf8');
const card = readFileSync('ui/styles/card.css', 'utf8');

/** Reference measurements in u (1u = 1% of the image width). */
const REFERENCE = {
  coverTop: 17.69,
  coverSize: 85.93,
  coverRadius: 0.74,
  titleTop: 108.89,
  titleHeight: 4.63,
  artistTop: 115.93,
  artistHeight: 2.31,
  progressTop: 121.2,
  progressHeight: 1.48,
  timesTop: 123.52,
  controlsCentre: 134.6,
  playDiameter: 15.74,
  bandTop: 148.33,
  bandHeight: 1.3,
  hexTop: 152.87,
  creditTop: 169.07,
};

/* ------------------------------------------------------------ custom properties */

const props = new Map();
for (const m of tokens.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;}]+)[;}]/gi)) props.set(m[1], m[2].trim());

const cache = new Map();

/** Replace `calc(...)` with a plain parenthesised expression, counting depth. */
function stripCalc(text) {
  let result = text;
  for (let guard = 0; guard < 50; guard++) {
    const start = result.indexOf('calc(');
    if (start < 0) return result;
    let depth = 0;
    let end = -1;
    for (let i = start + 4; i < result.length; i++) {
      if (result[i] === '(') depth++;
      else if (result[i] === ')') {
        depth--;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    if (end < 0) return result;
    result = `${result.slice(0, start)}(${result.slice(start + 5, end)})${result.slice(end + 1)}`;
  }
  return result;
}

/** Evaluate a declaration to a number of units. Bounded: returns 0 rather than spins. */
function evaluate(expression, depth = 0) {
  if (expression === null || expression === undefined) return 0;
  if (depth > 10) return 0;
  let text = String(expression).trim();
  if (!text) return 0;

  text = text.replace(/var\((--[a-z0-9-]+)(?:\s*,\s*([^)]+))?\)/gi, (_m, name, fallback) => {
    // `--u-pure` is the reference's exact unit before the legibility floor is applied
    // at runtime. Using it here keeps this check comparing like with like: the rendered
    // unit can be clamped, which would otherwise distort every derived size.
    if (name === '--u' || name === '--u-pure') return '1';
    if (cache.has(name)) return String(cache.get(name));
    if (props.has(name)) {
      const resolved = evaluate(props.get(name), depth + 1);
      cache.set(name, resolved);
      return String(resolved);
    }
    return fallback !== undefined ? String(evaluate(fallback, depth + 1)) : '0';
  });

  // `max(a, b)` is used to floor font sizes for legibility; for the reference
  // comparison the unfloored value is the one to check.
  while (/max\(/.test(text)) {
    const start = text.indexOf('max(');
    let depth = 0;
    let end = -1;
    for (let i = start + 3; i < text.length; i++) {
      if (text[i] === '(') depth++;
      else if (text[i] === ')') {
        depth--;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    if (end < 0) break;
    const args = text.slice(start + 4, end);
    // `max()` separates its arguments with commas, unlike a CSS shorthand's spaces.
    const parts = splitTopLevel(args);
    text = `${text.slice(0, start)}(${parts[0] ?? '0'})${text.slice(end + 1)}`;
  }

  text = stripCalc(text);
  const numeric = text.replace(/px|deg|em|%/g, '').trim();
  if (!/^[\d\s+\-*/().]+$/.test(numeric)) return 0;
  try {
    const out = Function(`"use strict"; return (${numeric});`)();
    return Number.isFinite(out) ? out : 0;
  } catch {
    return 0;
  }
}

const unit = (name) => evaluate(props.get(name));

/* ---------------------------------------------------------------- declarations */

function declaration(selector, property) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const block = new RegExp(`${escaped}\\s*\\{([^}]*)\\}`).exec(card);
  if (!block) return null;
  // `[^;{}]`: a value must not run past the end of the rule into the next one.
  const found = new RegExp(`(?:^|;|\\s)${property}\\s*:\\s*([^;{}]+)`).exec(block[1]);
  return found ? found[1].trim() : null;
}

/** Split on any top-level separator (whitespace or comma), ignoring parentheses. */
function splitTopLevel(text) {
  const parts = [];
  let depth = 0;
  let current = '';
  for (const ch of String(text)) {
    if (ch === '(') depth++;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    const isSeparator = (/\s/.test(ch) || ch === ',') && depth === 0;
    if (isSeparator) {
      if (current.trim()) parts.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

/** Split a shorthand into components, ignoring spaces inside parentheses. */
function splitShorthand(text) {  const parts = [];
  let depth = 0;
  let current = '';
  for (const ch of String(text)) {
    if (ch === '(') depth++;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    if (/\s/.test(ch) && depth === 0) {
      if (current) parts.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  if (current) parts.push(current);
  return parts;
}

const value = (selector, property) => evaluate(declaration(selector, property));
const shorthand = (selector, property, index) => {
  const raw = declaration(selector, property);
  if (!raw) return 0;
  const parts = splitShorthand(raw);
  return evaluate(parts[Math.min(index, parts.length - 1)]);
};

/**
 * Stage height in units.
 *
 * Measured from the reference's own pixels: its content area is 1080 x 1958, so the card
 * is 181.36 units tall, not 177.78 (which would be 9:16). Using 9:16 was the reason the
 * front face's text was clipped: at that height the reference's literal type is
 * proportionally too large, and the content total exceeded the card.
 */
const STAGE_HEIGHT_UNITS = 181.36;

const cardHeight = STAGE_HEIGHT_UNITS;
const padTop = shorthand('.face', 'padding', 0);
const padLeft = shorthand('.face', 'padding', 1);
const contentWidth = 100 - padLeft * 2;

const coverSize = contentWidth * (shorthand('.cover-wrap', 'width', 0) / 100);
/*
 * Line boxes are read from the stylesheet, not assumed. They were hardcoded here before, so
 * changing them in CSS silently made this check disagree with the real layout - exactly the
 * kind of drift that let clipped text keep coming back.
 */
const titleHeight = unit('--fs-title') * value('.title', 'line-height');
const artistHeight = unit('--fs-artist') * value('.artist', 'line-height');

const titleTop = padTop + coverSize + shorthand('.title', 'margin', 0);
const artistTop = titleTop + titleHeight + shorthand('.artist', 'margin', 0);
const progressTop = artistTop + artistHeight + value('.progress', 'margin-top');
const progressHeight = value('.progress-track', 'height');
const timesTop = progressTop + progressHeight + value('.progress-times', 'margin-top');
const controlsTop = timesTop + unit('--fs-time') * 1.2 + value('.controls', 'margin-top');
const controlsHeight = value('.controls', 'height');
const controlsCentre = controlsTop + controlsHeight / 2;
const bandTop = controlsTop + controlsHeight + value('.foot', 'margin-top');
const bandHeight = value('.band', 'height');
const hexTop = bandTop + bandHeight + value('.foot', 'gap');
const creditTop = hexTop + unit('--fs-hex') * 1.2 + value('.credit', 'margin-top');
const bottomInset = cardHeight - creditTop;

/* ---------------------------------------------------------------------- report */

const rows = [
  ['封面顶部', padTop, REFERENCE.coverTop],
  ['封面边长', coverSize, REFERENCE.coverSize],
  ['封面圆角', unit('--radius-cover'), REFERENCE.coverRadius],
  ['标题顶部', titleTop, REFERENCE.titleTop],
  ['标题字高', unit('--fs-title'), REFERENCE.titleHeight],
  ['艺术家顶部', artistTop, REFERENCE.artistTop],
  ['艺术家字高', unit('--fs-artist'), REFERENCE.artistHeight],
  ['进度条顶部', progressTop, REFERENCE.progressTop],
  ['进度条高', progressHeight, REFERENCE.progressHeight],
  ['时间行顶部', timesTop, REFERENCE.timesTop],
  ['播放键直径', value('.ctrl--primary', 'width'), REFERENCE.playDiameter],
  ['播放键中心', controlsCentre, REFERENCE.controlsCentre],
  ['色带顶部', bandTop, REFERENCE.bandTop],
  ['色带高', bandHeight, REFERENCE.bandHeight],
  ['色号顶部', hexTop, REFERENCE.hexTop],
  ['credit 顶部', creditTop, REFERENCE.creditTop],
];

console.log(
  `舞台 100u x ${cardHeight.toFixed(2)}u   左右内边距 ${padLeft.toFixed(2)}u   顶部内边距 ${padTop.toFixed(2)}u\n`,
);
console.log('项目              当前(u)   参考(u)    偏差  判定');

let failures = 0;
for (const [label, actual, expected] of rows) {
  const delta = actual - expected;
  const ok = Math.abs(delta) <= 1.0;
  if (!ok) failures++;
  console.log(
    `  ${label.padEnd(14)} ${actual.toFixed(2).padStart(7)}  ${expected
      .toFixed(2)
      .padStart(7)}  ${`${delta >= 0 ? '+' : ''}${delta.toFixed(2)}`.padStart(6)}  ${ok ? 'ok' : 'FAIL'}`,
  );
}

const checks = [
  ['封面为正方形', String(declaration('.cover-wrap', 'aspect-ratio')).replace(/\s/g, '') === '1/1'],
  ['上留白 > 左右留白', padTop > padLeft],
  ['封面圆角 <1.5u', unit('--radius-cover') < 1.5],
  ['无 backdrop 模糊', !card.includes('backdrop-filter')],
  ['封面窄于内容列', coverSize <= contentWidth],
  ['底部留白 5..25u', bottomInset > 5 && bottomInset < 25],
  /*
   * The critical one. The content must fit inside the card: `overflow: hidden` clips
   * whatever runs past the bottom, which is exactly how the title and artist disappeared
   * in an earlier revision. A negative bottom inset means overflow.
   */
  ['内容不溢出卡片（正文被裁的根因）', creditTop < cardHeight],
  ['内容充分占满卡片', bottomInset < 20],
];

console.log('\n几何约束:');
for (const [label, ok] of checks) {
  if (!ok) failures++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}`);
}

console.log(
  `\n封面底 ${(padTop + coverSize).toFixed(2)}u   credit 后到底边 ${bottomInset.toFixed(2)}u（参考 ${(
    cardHeight - REFERENCE.creditTop
  ).toFixed(2)}u）`,
);
console.log(`\n${failures ? `❌ ${failures} 项不匹配` : '✅ 布局与参考测量一致'}`);
process.exit(failures ? 1 : 0);
