// Unit tests for palette extraction.
//
//   node ui/test/palette.test.mjs
//
// The pipeline is pure once the cover's pixels are in hand (`paletteFromPixels`), so it can be
// tested without a canvas. That matters because the failure being pinned here is invisible from
// the tooling side and obvious on screen:
//
//   "大部分颜色都是深蓝色...结果最深色却是深灰色，没有提取到深蓝色"
//
// The cause was a unit mismatch. The "too dark to be worth showing" guard was written against the
// **WCAG relative luminance** with a 0.06 cut - the measure for contrast, which weights blue at
// 0.0722 and then linearises. A rich dark blue lands at 0.034, so the guard rejected exactly the
// swatches a dark-blue cover is made of, and the darkest band had to be filled with whatever grey
// was left. The choosing thresholds are now on the 0-255 luma, where the same colour is 48.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { hue, luma255, paletteFromPixels, saturation } from '../src/palette.js';

/** A pixel list from `[count, r, g, b]` groups. */
const pixels = (...groups) =>
  groups.flatMap(([count, r, g, b]) => Array.from({ length: count }, () => [r, g, b]));

/** The darkest swatch, by the same measure the ramp is built on. */
const darkest = (colors) => [...colors].sort((a, b) => luma255(a) - luma255(b))[0];

describe('luma255', () => {
  it('is the 0-255 brightness, not the WCAG contrast luminance', () => {
    assert.equal(Math.round(luma255({ r: 255, g: 255, b: 255 })), 255);
    assert.equal(luma255({ r: 0, g: 0, b: 0 }), 0);
    // The distinction that caused the bug: a rich dark blue is 48 here but 0.034 as WCAG
    // luminance, well under the old 0.06 guard.
    const darkBlue = { r: 0x20, g: 0x30, b: 0x60 };
    assert.ok(luma255(darkBlue) > 44 && luma255(darkBlue) < 52, String(luma255(darkBlue)));
  });
});

describe('a dark-blue cover', () => {
  // Mostly deep blue, with a lighter blue highlight and a little near-black - the shape reported
  // for ロンググッドバイ: broad dark blue areas, including at the edges.
  const cover = pixels([3000, 0x18, 0x24, 0x52], [2000, 0x20, 0x32, 0x68], [900, 0x4a, 0x74, 0xc0], [100, 0x08, 0x0a, 0x14]);

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

  it('produces a blue-dominant palette overall', () => {
    const { colors } = paletteFromPixels(cover, 5);
    const blue = colors.filter((c) => {
      const h = hue(c);
      return saturation(c) > 0.2 && h > 200 && h < 260;
    });
    assert.ok(blue.length >= 3, `五块里应当至少三块偏蓝，实际 ${blue.length}`);
  });

  it('still returns exactly as many swatches as asked for', () => {
    for (const count of [3, 5, 6]) {
      assert.equal(paletteFromPixels(cover, count).colors.length, count);
    }
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
