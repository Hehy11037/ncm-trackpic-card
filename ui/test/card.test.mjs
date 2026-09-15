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

import { bandIndexFromX, CardView, MODE_CYCLE } from '../src/card.js';

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

/*
 * The transport controls' rendering, on a hand-built `this`.
 *
 * `new CardView()` needs a document, and the parts worth testing here - which mode maps to which
 * glyph, what the speaker shows at a given volume, and whether a scrub preview survives the next
 * frame - are all reachable through the prototype without one.
 */
function fakeView() {
  const view = Object.create(CardView.prototype);
  view.el = {
    card: { dataset: {} },
    mode: { dataset: {}, title: '' },
    volume: { dataset: {}, title: '' },
    volumeBar: { dataset: {}, setAttribute() {} },
    volumeFill: { style: {} },
    volumeThumb: { style: {} },
    volumeValue: { textContent: '' },
    progress: { dataset: {}, removeAttribute: () => delete view.el.progress.dataset.scrubbing },
    fill: { style: {} },
    progressThumb: { style: {} },
    timeNow: { textContent: '' },
    miniFill: { style: {} },
    progressTrack: { dataset: {}, setAttribute: (name, value) => { view.el.progressTrack[name] = value; } },
  };
  view.scrubFraction = null;
  view.lastFraction = -1;
  view.lastSecond = -1;
  return view;
}

describe('CardView.setMode', () => {
  it('draws the mode and names it', () => {
    const view = fakeView();
    view.setMode('playCycle');
    assert.equal(view.el.mode.dataset.mode, 'playCycle');
    assert.match(view.el.mode.title, /列表循环/);
    view.setMode('playOneCycle');
    assert.match(view.el.mode.title, /单曲循环/);
  });

  it('falls back to a known mode rather than drawing nothing', () => {
    // The client also has playAi and playFm, which the card does not offer as modes.
    const view = fakeView();
    view.setMode('playAi');
    assert.ok(MODE_CYCLE.includes(view.el.mode.dataset.mode));
  });

  it('knows the four modes', () => {
    assert.deepEqual(MODE_CYCLE, ['playOrder', 'playCycle', 'playOneCycle', 'playRandom']);
  });
});

describe('CardView.setVolume', () => {
  it('draws the level and the percentage', () => {
    const view = fakeView();
    view.setVolume(0.3, false);
    assert.equal(view.el.volume.dataset.level, 'low');
    assert.equal(view.el.volumeFill.style.width, '30%');
    assert.equal(view.el.volumeValue.textContent, '30');
    view.setVolume(0.8, false);
    assert.equal(view.el.volume.dataset.level, 'high');
  });

  it('shows muted from the client flag as well as from a zero volume', () => {
    const view = fakeView();
    view.setVolume(0, false);
    assert.equal(view.el.volume.dataset.level, 'mute');
    // `muteVolume` is the volume *remembered* while muted, so the flag alone must be enough.
    view.setVolume(0.5, true);
    assert.equal(view.el.volume.dataset.level, 'mute');
  });

  it('does not fight a drag in progress', () => {
    const view = fakeView();
    view.setVolume(0.4, false);
    assert.equal(view.el.volumeFill.style.width, '40%');
    // The client sends a snapshot mid-drag; the bar the user is holding must not jump.
    view.el.volumeBar.dataset.scrubbing = 'true';
    view.setVolume(0.9, false);
    assert.equal(view.el.volumeFill.style.width, '40%');
  });
});

describe('CardView.setScrub', () => {
  it('draws the preview and stops the clock from overwriting it', () => {
    const view = fakeView();
    view.setScrub(0.5, 60_000);
    assert.equal(view.el.fill.style.width, '50.00%');
    assert.equal(view.el.timeNow.textContent, '1:00');
    assert.equal(view.el.progress.dataset.scrubbing, 'true');

    // A frame from the playback clock must leave the preview alone: the user is dragging precisely
    // because they want to see where they are going, and the playhead is still at the old position.
    view.tick(1_000, 0.01);
    assert.equal(view.el.fill.style.width, '50.00%');
    assert.equal(view.el.timeNow.textContent, '1:00');
    // The rolled-up bar follows the clock, since it has no scrub of its own.
    assert.equal(view.el.miniFill.style.width, '1.00%');
  });

  it('hands the bar back to the clock afterwards', () => {
    const view = fakeView();
    view.setScrub(0.5, 60_000);
    view.setScrub(null);
    assert.equal(view.el.progress.dataset.scrubbing, undefined);
    view.tick(2_000, 0.25);
    assert.equal(view.el.fill.style.width, '25.00%');
    assert.equal(view.el.timeNow.textContent, '0:02');
  });

  it('keeps the slider role honest while playing and while dragging', () => {
    // `role="slider"` with an `aria-valuenow` frozen at 0 reports a position that never changes.
    const view = fakeView();
    view.tick(2_000, 0.25);
    assert.equal(view.el.progressTrack['aria-valuenow'], '25');
    view.setScrub(0.7, 10_000);
    assert.equal(view.el.progressTrack['aria-valuenow'], '70');
    // Back to the clock, and back to the clock's value.
    view.setScrub(null);
    view.tick(4_000, 0.4);
    assert.equal(view.el.progressTrack['aria-valuenow'], '40');
  });
});
