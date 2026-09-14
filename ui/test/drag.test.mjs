// Unit tests for the drag gesture's threshold.
//
//   node ui/test/drag.test.mjs
//
// Dragging is a pointer gesture rather than a `-webkit-app-region` region (see ui/src/drag.js for
// why). The window's position is computed in the shell from the OS cursor - `dragTarget` and
// `clampToWorkArea` in apps/overlay/shell-utils.mjs, covered by tools/check-shell.mjs - so what is
// left here is the one decision the renderer makes: whether a press has moved enough to be a drag
// rather than a click.
//
// That matters because the window follows the cursor: without a threshold, the tremor of an
// ordinary click would nudge the card a pixel or two.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { DRAG_THRESHOLD_PX, isDragGesture } from '../src/drag.js';

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
