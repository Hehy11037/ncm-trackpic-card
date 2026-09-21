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

import { makeCssReader, readStyle } from './css-values.mjs';

const css = makeCssReader({
  tokens: readStyle('ui/styles/tokens.css'),
  rules: readStyle('ui/styles/card.css'),
});

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

const { props, rules, evaluate, declaration, unit, value, shorthand } = css;

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

/*
 * The descender headroom, which the check has to model or it cannot see it.
 *
 * Both text lines carry a `padding-bottom` (room for a glyph's tail inside the clip box) cancelled by an
 * equal negative `margin-bottom` (so nothing below moves). Reading only `line-height` - as this did -
 * meant the padding could be added, forgotten, doubled or left uncompensated without the check noticing,
 * and the positions it reports would be the positions the *model* believes in, not the ones the browser
 * will compute.
 */
const longhand = (selector, prop) => {
  try {
    return value(selector, prop);
  } catch {
    return 0;
  }
};
const titleTail = longhand('.title', 'padding-bottom') + longhand('.title', 'margin-bottom');
const artistTail = longhand('.artist', 'padding-bottom') + longhand('.artist', 'margin-bottom');

const titleTop = padTop + coverSize + shorthand('.title', 'margin', 0);
const artistTop = titleTop + titleHeight + titleTail + shorthand('.artist', 'margin', 0);
const progressTop = artistTop + artistHeight + artistTail + value('.progress', 'margin-top');
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
  ['无 backdrop 模糊', !rules.includes('backdrop-filter')],
  ['封面窄于内容列', coverSize <= contentWidth],
  ['底部留白 5..25u', bottomInset > 5 && bottomInset < 25],
  /*
   * The critical one. The content must fit inside the card: `overflow: hidden` clips
   * whatever runs past the bottom, which is exactly how the title and artist disappeared
   * in an earlier revision. A negative bottom inset means overflow.
   */
  ['内容不溢出卡片（正文被裁的根因）', creditTop < cardHeight],
  ['内容充分占满卡片', bottomInset < 20],
  /*
   * The same question with a **two-line** title, which is what `-webkit-line-clamp: 2` allows and what
   * this check never modelled. The stack was only ever measured with one line, so a long title could push
   * the column past the card - and then the flex algorithm *shrinks* the text instead of overflowing, and
   * a shrunk line box under `overflow: hidden` slices the bottom off the glyphs. That is the mechanism
   * behind "字母下半段显示不全"; the offsets are `flex: none` against it, this is the arithmetic.
   */
  ['标题两行时内容仍不溢出卡片', creditTop + titleHeight < cardHeight],
  ['标题两行时底部仍有留白', cardHeight - (creditTop + titleHeight) > 0],
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
