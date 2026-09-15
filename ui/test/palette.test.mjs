// Unit tests for palette extraction.
//
//   node ui/test/palette.test.mjs
//
// The pipeline is pure once the cover's pixels are in hand (`paletteFromPixels`), so it can be
// tested without a canvas. That matters: every failure here has been invisible from the tooling
// side and obvious on screen.
//
//   "大部分颜色都是深蓝色...结果最深色却是深灰色，没有提取到深蓝色"
//
// Two bugs produced that, one after the other, and the assertions below are shaped by both.
//
//  1. `chosen.map(boostSaturation)` - `Array.prototype.map` passes the index as the second
//     argument, which is `boostSaturation`'s `factor`. So the first swatch was multiplied by 0,
//     collapsing every channel onto the colour's midpoint and yielding a **pure grey**; the second
//     was left alone (factor 1); and the rest were multiplied by 2, 3 and 4, blowing the darkest
//     blues out to saturated primaries. Hence "第一个颜色是没有明显出现的深灰色，蓝色往往只以较亮
//     的蓝色形式出现在第三四个位置" - and hence a palette that looked fine on light covers, where
//     the midpoint of a bright colour is a plausible-looking light neutral.
//  2. Before that, the "too dark to be worth showing" guard was written against the **WCAG
//     relative luminance** with a 0.06 cut. That is the measure for contrast: it weights blue at
//     0.0722 and linearises, so a rich dark blue measures 0.034 and was thrown away while the same
//     colour is 48 on the 0-255 luma.
//
// So the tests assert on the *character* of the palette - no grey where the artwork has none, no
// hue the artwork does not contain, no saturation the artwork does not have - rather than on exact
// values, which would pin the quantiser instead of the behaviour.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { hue, luma255, paletteFromPixels, saturation } from '../src/palette.js';

/** A pixel list from `[count, r, g, b]` groups. */
const pixels = (...groups) =>
  groups.flatMap(([count, r, g, b]) => Array.from({ length: count }, () => [r, g, b]));

/** A cover described as colours with pixel counts, so its own properties can be asserted on. */
const coverPixels = (cover) =>
  cover.flatMap(({ color, count }) => Array.from({ length: count }, () => [color.r, color.g, color.b]));

/** The darkest swatch, by the same measure the ramp is built on. */
const darkest = (colors) => [...colors].sort((a, b) => luma255(a) - luma255(b))[0];

/** Hue distance in degrees, taking the 0/360 wrap into account. */
const hueDistance = (a, b) => Math.min(Math.abs(a - b), 360 - Math.abs(a - b));

/**
 * Assert that a palette came from this artwork.
 *
 * @param {{r:number,g:number,b:number}[]} colors
 * @param {{color:{r:number,g:number,b:number}, count:number}[]} cover
 * @param {string} label
 */
function assertPaletteMatches(colors, cover, label) {
  const coverColors = cover.map((entry) => entry.color);
  const coverHues = coverColors.map(hue);
  const maxCoverSaturation = Math.max(...coverColors.map(saturation));
  const coverHasNeutrals = coverColors.some((color) => saturation(color) < 0.1);

  for (const [i, color] of colors.entries()) {
    const sat = saturation(color);
    const h = hue(color);

    if (!coverHasNeutrals) {
      // A neutral swatch when nothing in the artwork is neutral is the grey the bug fabricated.
      assert.ok(
        sat >= 0.1,
        `${label}: 第 ${i} 个色块是中性灰 rgb(${color.r},${color.g},${color.b})，但封面里没有中性色`,
      );
      // ... and its hue must be one the artwork contains. The saturation nudge preserves the hue,
      // so a fabricated or blown-out colour shows up here.
      const nearest = Math.min(...coverHues.map((coverHue) => hueDistance(coverHue, h)));
      assert.ok(
        nearest <= 12,
        `${label}: 第 ${i} 个色块色相 ${h.toFixed(0)}° 不在封面里（最近 ${nearest.toFixed(0)}°）`,
      );
    }

    // The nudge is a nudge: it must not invent saturation the artwork does not have. With the
    // `map` bug, swatches 3-5 came back at full saturation regardless of the cover.
    assert.ok(
      sat <= maxCoverSaturation * 1.3 + 0.05,
      `${label}: 第 ${i} 个色块饱和度 ${sat.toFixed(2)} 远超封面最高 ${maxCoverSaturation.toFixed(2)}`,
    );
  }
}

/** The dark-blue shape reported for ロンググッドバイ. */
const DARK_BLUE_COVER = [
  { color: { r: 0x12, g: 0x1a, b: 0x38 }, count: 6000 },
  { color: { r: 0x2a, g: 0x4a, b: 0x8a }, count: 2500 },
  { color: { r: 0x4a, g: 0x7a, b: 0xd0 }, count: 1000 },
  { color: { r: 0x08, g: 0x09, b: 0x0c }, count: 500 },
];

/** The same failure in another hue, because "the first swatch is grey" was never about blue. */
const DARK_RED_COVER = [
  { color: { r: 0x3a, g: 0x0c, b: 0x12 }, count: 6000 },
  { color: { r: 0x84, g: 0x1c, b: 0x24 }, count: 2500 },
  { color: { r: 0xc0, g: 0x40, b: 0x48 }, count: 1000 },
  { color: { r: 0x08, g: 0x08, b: 0x08 }, count: 500 },
];

describe('luma255', () => {
  it('is the 0-255 brightness, not the WCAG contrast luminance', () => {
    assert.equal(Math.round(luma255({ r: 255, g: 255, b: 255 })), 255);
    assert.equal(luma255({ r: 0, g: 0, b: 0 }), 0);
    // The distinction behind bug 2: a rich dark blue is 48 here but 0.034 as WCAG luminance.
    const darkBlue = { r: 0x20, g: 0x30, b: 0x60 };
    assert.ok(luma255(darkBlue) > 44 && luma255(darkBlue) < 52, String(luma255(darkBlue)));
  });
});

describe('a dark-blue cover', () => {
  const cover = coverPixels(DARK_BLUE_COVER);

  it('keeps a dark blue swatch rather than filling the dark end with grey', () => {
    const { colors } = paletteFromPixels(cover, 5);
    const dark = darkest(colors);
    assert.ok(dark, '应当有调色板');
    assert.ok(
      saturation(dark) > 0.25,
      `最深的色块应当是有色相的深蓝，实际 rgb(${dark.r},${dark.g},${dark.b}) 饱和度 ${saturation(dark).toFixed(3)}`,
    );
    const h = hue(dark);
    assert.ok(h > 200 && h < 260, `色相应当落在蓝色区间，实际 ${h.toFixed(1)}°`);
  });

  /*
   * The direct assertion for bug 1, and the one that would have caught it.
   *
   * `darkest(colors)` was not enough on its own: with the index-as-factor bug, the last swatch was
   * boosted by 4, which drove two channels to zero and left a colour that was *darker* than the
   * fabricated grey - so a "the darkest swatch is blue" test passed for entirely the wrong reason.
   * The first slot is what the bug destroyed, so the first slot is what is asserted on.
   */
  it('the first swatch is the cover colour, not a grey', () => {
    const { colors } = paletteFromPixels(cover, 5);
    assert.ok(
      saturation(colors[0]) > 0.25,
      `第一个色块应当有色相，实际 rgb(${colors[0].r},${colors[0].g},${colors[0].b})`,
    );
    assert.ok(
      saturation(colors[0]) <= Math.max(...DARK_BLUE_COVER.map((c) => saturation(c.color))) * 1.3 + 0.05,
      `第一个色块不应被过度加饱和: ${saturation(colors[0]).toFixed(2)}`,
    );
  });

  it('produces a blue-dominant palette overall', () => {
    const { colors } = paletteFromPixels(cover, 5);
    const blue = colors.filter((c) => {
      const h = hue(c);
      return saturation(c) > 0.2 && h > 200 && h < 260;
    });
    assert.ok(blue.length >= 3, `五块里应当至少三块偏蓝，实际 ${blue.length}`);
  });

  it('every swatch looks like something in the artwork', () => {
    assertPaletteMatches(paletteFromPixels(cover, 5).colors, DARK_BLUE_COVER, '深蓝封面');
  });

  it('is ordered dark to light', () => {
    const lumas = paletteFromPixels(cover, 5).colors.map(luma255);
    assert.deepEqual(lumas, [...lumas].sort((a, b) => a - b), `应当由暗到亮: ${lumas.map(Math.round).join(',')}`);
  });

  it('still returns exactly as many swatches as asked for', () => {
    for (const count of [3, 5, 6]) {
      assert.equal(paletteFromPixels(cover, count).colors.length, count);
    }
  });
});

describe('a dark-red cover', () => {
  it('every swatch looks like something in the artwork', () => {
    assertPaletteMatches(paletteFromPixels(coverPixels(DARK_RED_COVER), 5).colors, DARK_RED_COVER, '深红封面');
  });
});

describe('other covers still behave', () => {
  it('gives a dark-to-light ramp for a greyscale cover', () => {
    const grey = pixels([2000, 0x20, 0x20, 0x20], [2000, 0x80, 0x80, 0x80], [2000, 0xd0, 0xd0, 0xd0]);
    const { colors } = paletteFromPixels(grey, 5);
    const lumas = colors.map(luma255);
    assert.ok(Math.max(...lumas) - Math.min(...lumas) > 40, `应当有明暗跨度: ${lumas.map(Math.round).join(',')}`);
  });

  it('shows both extremes of a black-and-white cover', () => {
    const mono = pixels([3000, 0xf4, 0xf4, 0xf4], [3000, 0x0c, 0x0c, 0x0c]);
    const { colors } = paletteFromPixels(mono, 5);
    const lumas = colors.map(luma255);
    assert.ok(Math.min(...lumas) < 60, `应当有近黑色: ${lumas.map(Math.round).join(',')}`);
    assert.ok(Math.max(...lumas) > 200, `应当有近白色: ${lumas.map(Math.round).join(',')}`);
  });

  it('does not invent a near-black swatch for a cover that barely has one', () => {
    // The extreme detector requires 1.5% of the pixels before treating a tone as a deliberate
    // area, so a handful of dark pixels in an otherwise mid-blue cover must not drag the dark end
    // down to black. (A cover that is *genuinely* half black and half white is expected to show
    // both - that is the documented intent, and the test above covers it.)
    const cover = pixels([5000, 0x40, 0x60, 0xa0], [20, 0x00, 0x00, 0x00]);
    const darkestLuma = Math.min(...paletteFromPixels(cover, 5).colors.map(luma255));
    assert.ok(darkestLuma > 20, `不应出现近黑: ${darkestLuma.toFixed(1)}`);
  });

  it('handles a flat-colour cover without inventing swatches', () => {
    // A perfectly flat cover has only as many distinct colours as candidates, so the palette may
    // be shorter than the requested count. What matters is that every swatch is still close to the
    // artwork rather than made up.
    const flat = pixels([5000, 0x40, 0x80, 0x40]);
    const { colors } = paletteFromPixels(flat, 5);
    assert.ok(colors.length >= 1 && colors.length <= 5, `数量应在 1..5，实际 ${colors.length}`);
    for (const color of colors) {
      const luma = luma255(color);
      assert.ok(luma > 60 && luma < 160, `应当贴近原色: rgb(${color.r},${color.g},${color.b})`);
    }
  });
});
