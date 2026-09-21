// Unit tests for the drag gesture's shape.
//
//   node ui/test/drag.test.mjs
//
// Dragging is a pointer gesture rather than a `-webkit-app-region` region (see ui/src/drag.js for
// why), and the window's position is computed in the shell from absolute screen coordinates -
// `dragTarget` and `clampToWorkArea` in apps/overlay/shell-utils.mjs, covered by
// tools/check-shell.mjs.
//
// What is tested here is the part the smoothness depends on: where the cursor position comes from
// and when it is sent. It is sent on `pointermove`, in step with the compositor, rather than polled
// on a timer in the shell. A timer fires *near* every frame rather than on it, so the window is
// sometimes moved twice within one frame and sometimes not at all - which the eye reads as stutter
// even though every step is the same size.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { installDragToMove } from '../src/drag.js';

/*
 * `requestAnimationFrame` does not exist in Node, and the gesture frames its sends with it. The
 * stub queues the callbacks so a test can decide when a frame happens.
 */
let frameQueue = [];
globalThis.requestAnimationFrame = (callback) => {
  frameQueue.push(callback);
  return frameQueue.length;
};
globalThis.cancelAnimationFrame = (id) => {
  frameQueue[id - 1] = null;
};
const runFrame = () => {
  const queue = frameQueue;
  frameQueue = [];
  for (const callback of queue) callback?.();
};

/** A minimal document whose listeners can be fired by hand. */
function fakeRoot() {
  const listeners = new Map();
  return {
    addEventListener(type, handler) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(handler);
    },
    removeEventListener(type, handler) {
      const list = listeners.get(type) ?? [];
      const at = list.indexOf(handler);
      if (at >= 0) list.splice(at, 1);
    },
    fire(type, event) {
      for (const handler of listeners.get(type) ?? []) handler(event);
    },
    count(type) {
      return (listeners.get(type) ?? []).length;
    },
  };
}

/** Install the gesture over a fake DOM, with a recording bridge. */
function harness() {
  const root = fakeRoot();
  const sent = [];
  const bridge = {
    dragStart: (x, y) => sent.push(['start', x, y]),
    dragMove: (x, y) => sent.push(['move', x, y]),
    dragEnd: () => sent.push(['end']),
  };
  // The gesture sets a flag on `<html>` so the stylesheet can drop the expensive shadow while the card
  // moves; a fake document is enough to check that the flag is raised and lowered.
  const dataset = {};
  const previousDocument = globalThis.document;
  globalThis.document = { documentElement: { dataset } };
  const uninstall = installDragToMove({ shell: () => bridge, root });
  const restore = () => {
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
  };
  return { root, sent, uninstall, dataset, restore };
}

const pointer = (over = {}) => ({
  button: 0,
  buttons: 1,
  pointerId: 1,
  screenX: 100,
  screenY: 100,
  target: { closest: () => null, setPointerCapture() {}, releasePointerCapture() {} },
  ...over,
});

const kinds = (sent) => sent.map(([kind]) => kind);

describe('installDragToMove', () => {
  it('starts on the press, with no dead zone', () => {
    const t = harness();
    t.root.fire('pointerdown', pointer({ screenX: 10, screenY: 20 }));
    assert.deepEqual(t.sent, [['start', 10, 20]], '按下就应当开始，不需要先移动几个像素');
    t.uninstall();
  });

  it('ignores a press on a control', () => {
    const t = harness();
    const control = { closest: () => ({ tagName: 'BUTTON' }), setPointerCapture() {} };
    t.root.fire('pointerdown', pointer({ target: control }));
    assert.deepEqual(t.sent, [], '按下控件绝不能开始拖动');
    t.uninstall();
  });

  it('ends the gesture for a press that never moved', () => {
    // A leaked drag makes the shell skip every auto-collapse tick, which stops the card rolling up
    // altogether - so `dragEnd` must go out even when nothing happened.
    const t = harness();
    t.root.fire('pointerdown', pointer());
    t.root.fire('pointerup', pointer());
    assert.deepEqual(kinds(t.sent), ['start', 'end']);
    t.uninstall();
  });

  it('re-arms when a cancel interrupts a held button', () => {
    const t = harness();
    t.root.fire('pointerdown', pointer());
    t.root.fire('pointercancel', pointer());
    assert.equal(kinds(t.sent).filter((k) => k === 'end').length, 1);
    // The button is still down, so the next move starts a fresh gesture rather than leaving the
    // window stuck where the cancel left it.
    t.root.fire('pointermove', pointer({ screenX: 140, screenY: 160 }));
    assert.equal(kinds(t.sent).filter((k) => k === 'start').length, 2, '应当重新开始拖动');
    t.uninstall();
  });

  it('sends absolute positions, never deltas', () => {
    const t = harness();
    t.root.fire('pointerdown', pointer({ screenX: 50, screenY: 50 }));
    t.root.fire('pointermove', pointer({ screenX: 400, screenY: 300 }));
    runFrame();
    const moves = t.sent.filter(([kind]) => kind === 'move');
    assert.equal(moves.length, 1);
    // A dropped event then costs nothing, because the next one carries the whole correction.
    assert.deepEqual(moves[0], ['move', 400, 300]);
    t.uninstall();
  });

  it('sends at most once per frame, with the newest position', () => {
    // A 500Hz mouse would otherwise cross the bridge ten times between two frames; nine of those
    // would be discarded by the compositor anyway, and the cost of sending them is the stutter.
    const t = harness();
    t.root.fire('pointerdown', pointer({ screenX: 50, screenY: 50 }));
    t.root.fire('pointermove', pointer({ screenX: 60, screenY: 60 }));
    t.root.fire('pointermove', pointer({ screenX: 70, screenY: 70 }));
    t.root.fire('pointermove', pointer({ screenX: 80, screenY: 80 }));
    assert.equal(t.sent.filter(([kind]) => kind === 'move').length, 0, '帧之前不应发送');

    runFrame();
    const moves = t.sent.filter(([kind]) => kind === 'move');
    assert.equal(moves.length, 1, '一帧只发一次');
    assert.deepEqual(moves[0], ['move', 80, 80], '应当是最新的位置');
    t.uninstall();
  });

  it('stops sending after the gesture ends', () => {
    const t = harness();
    t.root.fire('pointerdown', pointer());
    t.root.fire('pointermove', pointer({ screenX: 200, screenY: 200 }));
    t.root.fire('pointerup', pointer());
    const before = t.sent.length;
    runFrame();
    assert.equal(t.sent.length, before, '结束后不应再有发送');
    t.uninstall();
  });

  it('raises the dragging flag for the gesture and lowers it after', () => {
    /*
     * The flag is what lets the stylesheet swap four blurred shadow layers for one while the card is
     * moving - the difference between a smooth drag and a stuttering one. It has to be set on the press
     * (not the first move, or the first frames are the expensive ones) and cleared on every way out.
     */
    const t = harness();
    assert.equal(t.dataset.dragging, undefined, '空闲时不应有标记');
    t.root.fire('pointerdown', pointer());
    assert.equal(t.dataset.dragging, 'true', '按下就应当标记为拖动中');
    t.root.fire('pointerup', pointer());
    assert.equal(t.dataset.dragging, undefined, '松手后应当清除标记');
    t.uninstall();
    t.restore();
  });

  it('lowers the flag when a drag is cancelled as well', () => {
    // A leaked flag would leave the card with the cheap shadow for ever.
    const t = harness();
    t.root.fire('pointerdown', pointer());
    t.root.fire('pointercancel', pointer());
    assert.equal(t.dataset.dragging, undefined, '取消也要清除标记');
    const other = harness();
    other.root.fire('pointerdown', pointer());
    other.root.fire('lostpointercapture', pointer());
    assert.equal(other.dataset.dragging, undefined, '丢失捕获也要清除标记');
    t.uninstall();
    other.uninstall();
    t.restore();
    other.restore();
  });

  it('removes every listener on uninstall', () => {
    const t = harness();
    t.uninstall();
    for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'lostpointercapture']) {
      assert.equal(t.root.count(type), 0, `${type} 监听器应当被移除`);
    }
  });
});
