/**
 * Move the window by dragging the card.
 *
 * Implemented here rather than with `-webkit-app-region: drag`, after three rounds of the two
 * requirements fighting each other:
 *
 *  - With the whole window declared draggable, the colour band could not be clicked, however
 *    its `no-drag` carve-out was sized (4px, then 26px).
 *  - With only the card's large surfaces declared draggable, the band worked but the window
 *    could not be moved.
 *  - With nothing draggable at all, the band worked and the window still could not be moved.
 *
 * The two pull in opposite directions, and the failure modes are not equal: a window that
 * cannot be moved is an annoyance, a control that cannot be pressed is a bug. So no element is
 * a drag region, and dragging is an ordinary pointer gesture instead - a press anywhere that is
 * not a control, then movement, moves the window by the same delta.
 *
 * Because the target is computed from the *total* delta since the press rather than
 * accumulated per event, a dropped or coalesced pointer event cannot make the window drift. A
 * press that never moves stays a click.
 */

/** Pixels of movement before a press counts as a drag rather than a click. */
export const DRAG_THRESHOLD_PX = 3;

/** True once the pointer has moved far enough to be a drag rather than a click. */
export function isDragGesture(dx, dy, threshold = DRAG_THRESHOLD_PX) {
  return Math.abs(dx) >= threshold || Math.abs(dy) >= threshold;
}

/**
 * Window position for a drag that started at `start` and has moved by `dx, dy`.
 *
 * Rounded, because `setBounds` with fractional coordinates produces a blurry window on a
 * scaled display.
 */
export function dragTarget(start, dx, dy) {
  return { x: Math.round(start.x + dx), y: Math.round(start.y + dy) };
}

/** A press inside any of these selects or activates; it must never start a drag. */
const CONTROL_SELECTOR = 'button, a, input, select, textarea, .band, .band-segment';

/**
 * Install the gesture.
 *
 * @param {{ shell?: () => any, root?: Document }} [options]
 * @returns {() => void} uninstall
 */
export function installDragToMove(options = {}) {
  const bridge = options.shell ?? (() => globalThis.overlayShell ?? null);
  const root = options.root ?? globalThis.document;
  if (!root) return () => {};

  /** @type {{pointerId:number, screenX:number, screenY:number, element:any, dragging:boolean}|null} */
  let active = null;

  const onPointerDown = (event) => {
    if (event.button !== 0) return;
    if (!bridge()?.dragStart) return;
    if (event.target instanceof Element && event.target.closest(CONTROL_SELECTOR)) return;

    active = {
      pointerId: event.pointerId,
      screenX: event.screenX,
      screenY: event.screenY,
      element: event.target,
      dragging: false,
    };
    /*
     * Pointer capture so the move and up events keep arriving once the pointer leaves the
     * element - and, at the start of a fast drag, the window itself. Without it a quick flick
     * can release the button outside the window and leave the drag running.
     */
    try {
      event.target.setPointerCapture?.(event.pointerId);
    } catch {
      /* capture is a nicety; the gesture still works without it */
    }
    // The shell records the window's bounds now, before anything moves, so the first move
    // cannot make the window jump by the threshold distance.
    bridge().dragStart();
  };

  const onPointerMove = (event) => {
    if (!active || event.pointerId !== active.pointerId) return;
    const dx = event.screenX - active.screenX;
    const dy = event.screenY - active.screenY;
    if (!active.dragging) {
      if (!isDragGesture(dx, dy)) return;
      active.dragging = true;
    }
    bridge().dragMove?.(dx, dy);
  };

  const onPointerUp = (event) => {
    if (!active || event.pointerId !== active.pointerId) return;
    finish();
  };

  function finish() {
    if (!active) return;
    const { element, pointerId } = active;
    active = null;
    try {
      element?.releasePointerCapture?.(pointerId);
    } catch {
      /* the element may be gone */
    }
    /*
     * Always end the gesture, even when nothing moved.
     *
     * `dragStart` was sent on the press, and the shell keeps a drag "open" until it hears the
     * end - so skipping it for a plain click would leave a drag open forever and, with it, the
     * auto-collapse suppressed. The shell decides what an empty drag is worth persisting.
     */
    bridge()?.dragEnd?.();
  }

  root.addEventListener('pointerdown', onPointerDown, true);
  root.addEventListener('pointermove', onPointerMove, true);
  root.addEventListener('pointerup', onPointerUp, true);
  root.addEventListener('pointercancel', onPointerUp, true);
  // Backstops: a drag cannot survive the window losing focus or being hidden.
  root.addEventListener('lostpointercapture', onPointerUp, true);
  globalThis.addEventListener?.('blur', finish);

  return () => {
    root.removeEventListener('pointerdown', onPointerDown, true);
    root.removeEventListener('pointermove', onPointerMove, true);
    root.removeEventListener('pointerup', onPointerUp, true);
    root.removeEventListener('pointercancel', onPointerUp, true);
    root.removeEventListener('lostpointercapture', onPointerUp, true);
    globalThis.removeEventListener?.('blur', finish);
    finish();
  };
}
