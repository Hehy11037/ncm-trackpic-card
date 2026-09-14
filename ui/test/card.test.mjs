// Unit tests for the card's pointer maths.
//
//   node ui/test/card.test.mjs
//
// The colour band is the background picker, and a click that lands in its enlarged hit area -
// rather than exactly on a swatch - is resolved from the pointer's x position instead. That
// path had a reported failure ("色带不能点击选颜色"), so the mapping is pinned down here
// rather than left to a screenshot: an off-by-one picks the neighbouring colour, which looks
// like the click half-worked.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { bandIndexFromX } from '../src/card.js';

/** A 500px-wide band of five swatches starting at x = 100. */
const band = (clientX) => bandIndexFromX(clientX, 100, 500, 5);

describe('bandIndexFromX', () => {
  it('maps each fifth of the band to its own swatch', () => {
    assert.equal(band(100), 0, '最左端是第一块');
    assert.equal(band(199), 0);
    assert.equal(band(200), 1, '第二块从 1/5 处开始');
    assert.equal(band(300), 2);
    assert.equal(band(400), 3);
    assert.equal(band(500), 4);
  });

  it('keeps the last swatch for the final pixel', () => {
    // `clientX` is exclusive of the right edge, but a hit test can still report it.
    assert.equal(band(600), 4, '右端不会越界');
    assert.equal(band(9999), 4);
  });

  it('clamps a click left of the band', () => {
    assert.equal(band(0), 0);
    assert.equal(band(-50), 0);
  });

  it('handles a zero-width band instead of returning NaN', () => {
    // The band has no box before the first layout pass, and a NaN index would set
    // `palette[NaN]` - i.e. undefined - as the background.
    assert.equal(bandIndexFromX(300, 0, 0, 5), 0);
    assert.equal(bandIndexFromX(300, 100, 0, 5), 0);
    assert.equal(bandIndexFromX(300, 100, -10, 5), 0);
  });

  it('handles an empty palette', () => {
    assert.equal(bandIndexFromX(300, 100, 500, 0), 0);
  });

  it('works for any swatch count', () => {
    assert.equal(bandIndexFromX(349, 100, 500, 2), 0);
    assert.equal(bandIndexFromX(351, 100, 500, 2), 1);
  });
});
