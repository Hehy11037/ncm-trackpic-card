// Unit tests for the stage's mode decision.
//
//   node ui/test/layout.test.mjs
//
// The card and the rolled-up strip are two separate subtrees, and which one is drawn is derived
// from the window's height alone - deliberately, so the drawing and the window can never disagree.
// The subtle part is *where* the threshold sits, because the window passes through every height in
// between while it animates.
//
// Getting that wrong is not a crash, it is a pop: switching to the strip halfway through a
// collapse makes the card vanish while the window is still tall, and switching back late leaves a
// strip stretched over a tall window. Both are exactly the kind of thing that cannot be seen from
// here, so they are pinned instead.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { MINI_RATIO, STAGE_ASPECT, stageModeFor } from '../src/layout.js';

/** A 400px card: 773px expanded, 116px rolled up, 48px of shadow margin. */
const CARD = 400;
const PAD = 24;
const expanded = Math.round(CARD * STAGE_ASPECT) + PAD * 2;
const collapsed = Math.round(CARD * MINI_RATIO) + PAD * 2;

describe('stageModeFor', () => {
  it('reports the full card at the expanded height', () => {
    assert.equal(stageModeFor(expanded, collapsed), 'expanded');
  });

  it('reports the strip at the collapsed height', () => {
    assert.equal(stageModeFor(collapsed, collapsed), 'mini');
  });

  it('stays on the card for almost the whole collapse', () => {
    // The window is most of the way down but not yet the strip: the card must still be the card,
    // clipped from below by the window, or the roll-up would pop instead of rolling.
    for (const height of [expanded - 1, expanded - 60, Math.round((expanded + collapsed) / 2), collapsed + 40]) {
      assert.equal(stageModeFor(height, collapsed), 'expanded', `height ${height} 应仍是卡片`);
    }
  });

  it('switches to the strip only within the tolerance of it', () => {
    assert.equal(stageModeFor(collapsed + 20, collapsed), 'expanded');
    assert.equal(stageModeFor(collapsed + 12, collapsed), 'mini', '容差边界包含在内');
    assert.equal(stageModeFor(collapsed + 1, collapsed), 'mini');
  });

  it('leaves the card immediately when expanding starts', () => {
    // One pixel above the strip is enough: the card is then drawn at full height with its top
    // visible and the growing window reveals it downwards.
    assert.equal(stageModeFor(collapsed + 13, collapsed), 'expanded');
  });

  it('honours a custom tolerance', () => {
    assert.equal(stageModeFor(collapsed + 5, collapsed, 2), 'expanded');
    assert.equal(stageModeFor(collapsed + 2, collapsed, 2), 'mini');
  });
});
