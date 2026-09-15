// Unit tests for the optimistic hold.
//
//   node ui/test/optimistic.test.mjs
//
// This rule is the fix for two reported bugs - "the play/pause button switches slowly" and "the mode
// button only has two modes" - and both are about the *order* two facts arrive in: the user has
// already moved, and the client has not said so yet.
//
// The tests are about the boundaries, because those are what a hand-written copy gets wrong: a hold
// that releases one snapshot too early flickers, and one that releases too late shows a value the
// client is not in. The timeout is passed in as `now` rather than waited for.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createOptimisticHold } from '../src/optimistic.js';

describe('createOptimisticHold', () => {
  it('draws the held value while the client still reports the old one', () => {
    const hold = createOptimisticHold({ timeoutMs: 1000 });
    hold.set('playing', 0);
    // The client is still saying "paused" - which is the whole reason the hold exists.
    assert.equal(hold.resolve('paused', 100), 'playing');
    assert.equal(hold.resolve('paused', 900), 'playing');
  });

  it('releases as soon as the client agrees', () => {
    const hold = createOptimisticHold({ timeoutMs: 1000 });
    hold.set('playing', 0);
    assert.equal(hold.resolve('playing', 50), 'playing');
    assert.equal(hold.active, false);
    // And nothing is held any more, so the client's word is final from here on.
    assert.equal(hold.resolve('paused', 60), 'paused');
  });

  it('releases at the timeout, not before', () => {
    const hold = createOptimisticHold({ timeoutMs: 1000 });
    hold.set('playing', 0);
    assert.equal(hold.resolve('paused', 1000), 'playing', 'exactly at the boundary it is still held');
    assert.equal(hold.resolve('paused', 1001), 'paused', 'and just past it, the client wins');
  });

  it('a second choice replaces the first', () => {
    const hold = createOptimisticHold({ timeoutMs: 1000 });
    hold.set('playing', 0);
    hold.set('paused', 10);
    assert.equal(hold.resolve('paused', 20), 'paused', 'the newer choice is the one drawn');
    assert.equal(hold.active, false);
  });

  it('walks a cycle when each choice is made before the client catches up', () => {
    // The mode button: four clicks in a row, with the client still reporting the starting mode.
    const hold = createOptimisticHold({ timeoutMs: 1000 });
    const cycle = ['playOrder', 'playCycle', 'playOneCycle', 'playRandom'];
    const drawn = [];
    for (const [index, mode] of cycle.entries()) {
      hold.set(mode, index * 10);
      drawn.push(hold.resolve('playOrder', index * 10 + 1));
    }
    assert.deepEqual(drawn, cycle, 'all four modes, never stuck on the second');
  });

  it('clear() releases without drawing anything new', () => {
    const hold = createOptimisticHold({ timeoutMs: 1000 });
    hold.set('playing', 0);
    assert.equal(hold.value, 'playing');
    hold.clear();
    assert.equal(hold.value, null);
    assert.equal(hold.resolve('paused', 10), 'paused');
  });

  it('takes a custom comparison, for values that are never exactly equal', () => {
    // The client stores volume as a float32, so 0.35 comes back as 0.34999999...
    const hold = createOptimisticHold({
      timeoutMs: 1000,
      equals: (client, mine) => typeof client === 'number' && Math.abs(client - mine) < 0.02,
    });
    hold.set(0.35, 0);
    assert.equal(hold.resolve(0.5, 10), 0.35, 'the old volume does not release the hold');
    assert.equal(hold.resolve(0.3499999940395355, 20), 0.3499999940395355, 'the echoed value does');
    assert.equal(hold.active, false);
  });

  it('never reports the held value once released', () => {
    // The invariant the card depends on: after `resolve`, what is drawn is either the user's value
    // or the client's, and the client's is always available to fall back to.
    const hold = createOptimisticHold({ timeoutMs: 1000 });
    hold.set('paused', 0);
    const drawn = hold.resolve('paused', 2000);
    assert.equal(drawn, 'paused');
    assert.equal(hold.value, null);
  });
});
