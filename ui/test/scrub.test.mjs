// Unit tests for the scrub gesture (the progress bar and the volume bar).
//
//   node ui/test/scrub.test.mjs
//
// Both bars are the same gesture in two directions, and the parts that are easy to get wrong are
// the ones that already went wrong elsewhere in this project:
//
//   - a drag that leaves the element must keep reporting (hence pointer capture);
//   - `pointercancel` / `lostpointercapture` are *not* releases: Chromium fires them when the
//     window moves under the pointer, and committing there would seek to wherever the pointer
//     happened to be when the browser gave up;
//   - the ratio is measured from the strip, never from the event's target, because the fill and the
//     thumb are children of the strip and a press on the fill arrives with the fill as target;
//   - the commit happens once, on release. One per move would send a command per frame.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { installScrub } from '../src/scrub.js';

/** A strip with a settable rect, whose listeners can be fired by hand. */
function fakeStrip(rect = { left: 100, right: 300, top: 0, bottom: 10 }) {
  const listeners = new Map();
  const element = {
    dataset: {},
    captured: null,
    released: null,
    addEventListener(type, handler) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(handler);
    },
    removeEventListener(type, handler) {
      const list = listeners.get(type) ?? [];
      const at = list.indexOf(handler);
      if (at >= 0) list.splice(at, 1);
    },
    setPointerCapture(id) {
      element.captured = id;
    },
    releasePointerCapture(id) {
      element.released = id;
    },
    getBoundingClientRect() {
      return {
        left: rect.left,
        right: rect.right,
        top: rect.top,
        bottom: rect.bottom,
        width: rect.right - rect.left,
        height: rect.bottom - rect.top,
      };
    },
    fire(type, event) {
      for (const handler of listeners.get(type) ?? []) handler(event);
    },
  };
  return element;
}

const pointer = (overrides = {}) => ({
  pointerId: 1,
  button: 0,
  clientX: 100,
  clientY: 0,
  preventDefault() {},
  ...overrides,
});

describe('installScrub', () => {
  it('reports the ratio of the press, from the strip', () => {
    const strip = fakeStrip();
    const previews = [];
    installScrub(strip, { onPreview: (value) => previews.push(value) });
    strip.fire('pointerdown', pointer({ clientX: 150 }));
    assert.equal(previews.at(-1), 0.25);
  });

  it('measures from the strip even when the fill is the target', () => {
    const strip = fakeStrip();
    const previews = [];
    installScrub(strip, { onPreview: (value) => previews.push(value) });
    // The event's target is a child; the ratio must still come from the strip's own box.
    strip.fire('pointerdown', pointer({ clientX: 200, target: { className: 'progress-fill' } }));
    assert.equal(previews.at(-1), 0.5);
  });

  it('clamps outside the strip', () => {
    const strip = fakeStrip();
    const previews = [];
    installScrub(strip, { onPreview: (value) => previews.push(value) });
    strip.fire('pointerdown', pointer({ clientX: 20 }));
    strip.fire('pointermove', pointer({ clientX: 900 }));
    assert.deepEqual(previews, [0, 1]);
  });

  it('captures the pointer, so a drag that leaves the strip keeps reporting', () => {
    const strip = fakeStrip();
    const previews = [];
    installScrub(strip, { onPreview: (value) => previews.push(value) });
    strip.fire('pointerdown', pointer({ pointerId: 7, clientX: 100 }));
    assert.equal(strip.captured, 7);
    strip.fire('pointermove', pointer({ pointerId: 7, clientX: 250 }));
    assert.equal(previews.at(-1), 0.75);
  });

  it('ignores moves from another pointer', () => {
    const strip = fakeStrip();
    const previews = [];
    installScrub(strip, { onPreview: (value) => previews.push(value) });
    strip.fire('pointerdown', pointer({ pointerId: 1, clientX: 100 }));
    strip.fire('pointermove', pointer({ pointerId: 2, clientX: 300 }));
    assert.equal(previews.length, 1);
  });

  it('commits once, on release, at the released position', () => {
    const strip = fakeStrip();
    const commits = [];
    installScrub(strip, { onCommit: (value) => commits.push(value) });
    strip.fire('pointerdown', pointer({ clientX: 100 }));
    strip.fire('pointermove', pointer({ clientX: 150 }));
    strip.fire('pointermove', pointer({ clientX: 200 }));
    assert.deepEqual(commits, [], 'nothing is committed while the pointer is down');
    strip.fire('pointerup', pointer({ clientX: 250 }));
    assert.deepEqual(commits, [0.75]);
  });

  it('does not commit on pointercancel', () => {
    const strip = fakeStrip();
    const commits = [];
    const cancels = [];
    installScrub(strip, { onCommit: (value) => commits.push(value), onCancel: () => cancels.push('x') });
    strip.fire('pointerdown', pointer({ clientX: 100 }));
    strip.fire('pointermove', pointer({ clientX: 250 }));
    strip.fire('pointercancel', pointer());
    assert.deepEqual(commits, []);
    assert.equal(cancels.length, 1);
  });

  it('does not commit when the capture is lost', () => {
    const strip = fakeStrip();
    const commits = [];
    installScrub(strip, { onCommit: (value) => commits.push(value) });
    strip.fire('pointerdown', pointer());
    strip.fire('lostpointercapture', pointer());
    assert.deepEqual(commits, []);
  });

  it('marks the strip while the gesture is live, and clears it after', () => {
    const strip = fakeStrip();
    installScrub(strip, {});
    strip.fire('pointerdown', pointer());
    assert.equal(strip.dataset.scrubbing, 'true');
    strip.fire('pointerup', pointer());
    assert.equal(strip.dataset.scrubbing, undefined);
  });

  it('measures a vertical strip from the bottom up', () => {
    const strip = fakeStrip({ left: 0, right: 10, top: 100, bottom: 200 });
    const previews = [];
    installScrub(strip, { axis: 'y', onPreview: (value) => previews.push(value) });
    strip.fire('pointerdown', pointer({ clientX: 0, clientY: 200 }));
    strip.fire('pointermove', pointer({ clientX: 0, clientY: 150 }));
    strip.fire('pointermove', pointer({ clientX: 0, clientY: 100 }));
    assert.deepEqual(previews, [0, 0.5, 1]);
  });

  it('nudges and commits from the keyboard', () => {
    const strip = fakeStrip();
    const commits = [];
    installScrub(strip, { onCommit: (value) => commits.push(value), step: 0.1 });
    strip.fire('keydown', { key: 'ArrowRight', preventDefault() {}, stopPropagation() {} });
    assert.equal(commits.at(-1), 0.1);
    strip.fire('keydown', { key: 'End', preventDefault() {}, stopPropagation() {} });
    assert.equal(commits.at(-1), 1);
    strip.fire('keydown', { key: 'Home', preventDefault() {}, stopPropagation() {} });
    assert.equal(commits.at(-1), 0);
  });

  it('swallows the arrow keys, which are also the card\u2019s skip keys', () => {
    // One key must not seek *and* change track: the document-level handler would see the same press.
    const strip = fakeStrip();
    let stopped = 0;
    installScrub(strip, { onCommit: () => {} });
    strip.fire('keydown', { key: 'ArrowRight', preventDefault() {}, stopPropagation: () => (stopped += 1) });
    assert.equal(stopped, 1);
    // Anything else is left alone.
    strip.fire('keydown', { key: 'Tab', preventDefault() {}, stopPropagation: () => (stopped += 1) });
    assert.equal(stopped, 1);
  });

  it('survives a missing element', () => {
    assert.doesNotThrow(() => installScrub(null, { onCommit: () => {} }));
  });

  it('stops listening once destroyed', () => {
    const strip = fakeStrip();
    const commits = [];
    const scrub = installScrub(strip, { onCommit: (value) => commits.push(value) });
    scrub.destroy();
    strip.fire('pointerdown', pointer());
    strip.fire('pointerup', pointer({ clientX: 300 }));
    assert.deepEqual(commits, []);
  });
});
