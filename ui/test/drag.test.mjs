// Unit tests for the drag-to-move gesture.
//
//   node ui/test/drag.test.mjs
//
// Dragging the window is a pointer gesture rather than a `-webkit-app-region` region (see
// ui/src/drag.js for why), which makes its arithmetic something we own and can get wrong. The
// two properties worth pinning are that the window position is a pure function of the *total*
// pointer delta - so a dropped or coalesced event cannot make the window drift - and that a
// press which never moves is a click, not a zero-length drag.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { DRAG_THRESHOLD_PX, dragTarget, isDragGesture } from '../src/drag.js';

describe('isDragGesture', () => {
  it('treats a press that does not move as a click', () => {
    assert.equal(isDragGesture(0, 0), false);
    assert.equal(isDragGesture(1, -1), false);
    assert.equal(isDragGesture(DRAG_THRESHOLD_PX - 1, 0), false);
  });

  it('accepts movement past the threshold on either axis', () => {
    assert.equal(isDragGesture(DRAG_THRESHOLD_PX, 0), true);
    assert.equal(isDragGesture(0, -DRAG_THRESHOLD_PX), true);
    assert.equal(isDragGesture(50, 50), true);
  });

  it('honours a custom threshold', () => {
    assert.equal(isDragGesture(5, 0, 10), false);
    assert.equal(isDragGesture(10, 0, 10), true);
  });
});

describe('dragTarget', () => {
  it('applies the total delta to the bounds captured at the press', () => {
    assert.deepEqual(dragTarget({ x: 100, y: 200 }, 30, -40), { x: 130, y: 160 });
  });

  it('is a pure function of the total delta, not an accumulation', () => {
    // A pointer that arrives at +50,+20 in one event and in five events must land identically:
    // a dropped event cannot move the window somewhere else.
    const start = { x: 10, y: 10 };
    assert.deepEqual(dragTarget(start, 50, 20), { x: 60, y: 30 });
    // ... same total, reached in steps - the caller always passes the total.
    assert.deepEqual(dragTarget(start, 25 + 25, 10 + 10), { x: 60, y: 30 });
  });

  it('rounds, so a scaled display does not get a blurry window', () => {
    assert.deepEqual(dragTarget({ x: 0, y: 0 }, 10.4, 10.6), { x: 10, y: 11 });
    assert.deepEqual(dragTarget({ x: 5, y: 5 }, -10.5, -0.4), { x: -5, y: 5 });
  });

  it('allows negative positions (a second monitor to the left)', () => {
    assert.deepEqual(dragTarget({ x: -1920, y: 0 }, -30, 0), { x: -1950, y: 0 });
  });

  it('does not mutate the captured bounds', () => {
    const start = { x: 1, y: 2 };
    dragTarget(start, 100, 100);
    assert.deepEqual(start, { x: 1, y: 2 }, '拖动原点必须保持不变，否则窗口会累积漂移');
  });
});
