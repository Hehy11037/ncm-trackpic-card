/**
 * Turn an element into a drag target that reports a 0..1 position.
 *
 * Used by both the progress bar and the volume bar, which are the same gesture in two directions:
 * press anywhere on the strip, the value follows the pointer, release commits. Written once because
 * the fiddly parts are identical and each one has already been a bug somewhere in this project:
 *
 *  - **Pointer capture.** Without it, a drag that leaves the element stops reporting, and the
 *    window this card lives in can be moved under the cursor mid-gesture. Capture keeps the events
 *    coming and makes the gesture end with a `pointerup` even outside the element.
 *  - **A `pointercancel` is not a commit.** Chromium cancels pointers when the window moves under
 *    them. Treating that as a release would seek to wherever the pointer happened to be when the
 *    browser gave up.
 *  - **`pointer-events: none` does not stop the container receiving the events.** The fill and the
 *    thumb are children of the strip, so a press on the fill arrives with the fill as `target`;
 *    the ratio is measured from the *strip's* rect, never the target's.
 *  - **The commit is a single call on release**, not one per move: every move would be a command
 *    to the client, and a drag across the bar would send dozens of seeks.
 *
 * @param {HTMLElement|null} element the strip
 * @param {{
 *   axis?: 'x'|'y',
 *   onPreview?: (value: number, phase: 'start'|'move') => void,
 *   onCommit?: (value: number) => void,
 *   onCancel?: () => void,
 *   step?: number,
 * }} [options] `axis: 'y'` measures from the bottom up, which is how a volume bar reads.
 * @returns {{ destroy: () => void }}
 */
export function installScrub(element, options = {}) {
  if (!element || typeof element.addEventListener !== 'function') {
    return { destroy() {} };
  }

  const axis = options.axis === 'y' ? 'y' : 'x';
  const onPreview = options.onPreview ?? (() => {});
  const onCommit = options.onCommit ?? (() => {});
  const onCancel = options.onCancel ?? (() => {});
  const step = options.step ?? 0.05;

  let active = false;
  let pointerId = null;
  let value = 0;

  /** Where along the strip a pointer event is, clamped to 0..1. */
  const ratioAt = (event) => {
    const rect = element.getBoundingClientRect();
    const span = axis === 'x' ? rect.width : rect.height;
    if (!(span > 0)) return 0;
    const raw =
      axis === 'x' ? (event.clientX - rect.left) / span : (rect.bottom - event.clientY) / span;
    return clamp(raw);
  };

  const clamp = (input) => (Number.isFinite(input) ? Math.max(0, Math.min(1, input)) : 0);

  const onPointerDown = (event) => {
    if (event.button !== undefined && event.button !== 0) return;
    active = true;
    pointerId = event.pointerId;
    try {
      element.setPointerCapture?.(event.pointerId);
    } catch {
      /* capture is a nicety; the gesture still works while the pointer stays over the strip */
    }
    element.dataset.scrubbing = 'true';
    value = ratioAt(event);
    onPreview(value, 'start');
    // Keep the press from selecting card text or reaching the window-drag gesture.
    event.preventDefault();
  };

  const onPointerMove = (event) => {
    if (!active) return;
    if (pointerId !== null && event.pointerId !== pointerId) return;
    value = ratioAt(event);
    onPreview(value, 'move');
  };

  const finish = (commit) => {
    if (!active) return;
    active = false;
    try {
      element.releasePointerCapture?.(pointerId);
    } catch {
      /* the element may be gone */
    }
    pointerId = null;
    delete element.dataset.scrubbing;
    if (commit) onCommit(value);
    else onCancel();
  };

  const onPointerUp = (event) => {
    if (!active) return;
    if (pointerId !== null && event.pointerId !== pointerId) return;
    value = ratioAt(event);
    finish(true);
  };

  const onKeyDown = (event) => {
    const back = axis === 'x' ? 'ArrowLeft' : 'ArrowDown';
    const forward = axis === 'x' ? 'ArrowRight' : 'ArrowUp';
    let next = null;
    if (event.key === back) next = clamp(value - step);
    else if (event.key === forward) next = clamp(value + step);
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = 1;
    if (next === null) return;
    event.preventDefault();
    /*
     * And stop there. The arrows are also the card's track-skip keys, so an arrow pressed while the
     * bar has focus would otherwise seek *and* change track - two actions from one key, which is the
     * same double-action shape as a media key with a fallback behind it.
     */
    event.stopPropagation();
    // Keyboard has no release to wait for, so it previews and commits at once.
    value = next;
    onPreview(value, 'move');
    onCommit(value);
  };

  const onPointerCancel = () => finish(false);

  element.addEventListener('pointerdown', onPointerDown);
  element.addEventListener('pointermove', onPointerMove);
  element.addEventListener('pointerup', onPointerUp);
  element.addEventListener('pointercancel', onPointerCancel);
  element.addEventListener('lostpointercapture', onPointerCancel);
  element.addEventListener('keydown', onKeyDown);

  return {
    /** The last value the gesture reported, for keyboard and for tests. */
    get value() {
      return value;
    },
    set value(next) {
      value = clamp(next);
    },
    destroy() {
      finish(false);
      element.removeEventListener('pointerdown', onPointerDown);
      element.removeEventListener('pointermove', onPointerMove);
      element.removeEventListener('pointerup', onPointerUp);
      element.removeEventListener('pointercancel', onPointerCancel);
      element.removeEventListener('lostpointercapture', onPointerCancel);
      element.removeEventListener('keydown', onKeyDown);
    },
  };
}
