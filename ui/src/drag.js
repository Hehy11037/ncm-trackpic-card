/**
 * Move the window by dragging the card.
 *
 * Why not `-webkit-app-region: drag`: three rounds produced three arrangements and each traded
 * one broken feature for another. With the whole window declared draggable the colour band could
 * not be clicked, however its `no-drag` carve-out was sized (4px, then 26px); with only the
 * card's large surfaces declared draggable the band worked but the window could not be moved;
 * with nothing draggable the band worked and the window still could not be moved. The two pull
 * against each other, and the failure modes are not equal - a window that will not move is an
 * annoyance, a control that will not press is a bug.
 *
 * So nothing is a drag region, and dragging is an ordinary pointer gesture: press anywhere that
 * is not a control, then move.
 *
 * The shell does the moving (see `dragTarget` in shell-utils.mjs): it watches the OS cursor and
 * keeps the pressed point at the same offset inside the window. The renderer only reports the
 * start and the end. That split matters, because it means the cursor can never outrun the window
 * and escape it - an escaped cursor used to mean no `pointerup`, a drag that never ended, and a
 * card left somewhere the user could not recover from by hand.
 */

/** Pixels of movement before a press counts as a drag rather than a click. */
export const DRAG_THRESHOLD_PX = 3;

/** True once the pointer has moved far enough to be a drag rather than a click. */
export function isDragGesture(dx, dy, threshold = DRAG_THRESHOLD_PX) {
  return Math.abs(dx) >= threshold || Math.abs(dy) >= threshold;
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

  /** @type {{pointerId:number, screenX:number, screenY:number, element:any, started:boolean}|null} */
  let active = null;

  const started = () => active?.started === true;

  const onPointerDown = (event) => {
    if (event.button !== 0) return;
    if (!bridge()?.dragStart) return;
    if (event.target instanceof Element && event.target.closest(CONTROL_SELECTOR)) return;

    active = {
      pointerId: event.pointerId,
      screenX: event.screenX,
      screenY: event.screenY,
      element: event.target,
      started: false,
    };
    try {
      event.target.setPointerCapture?.(event.pointerId);
    } catch {
      /* capture is a nicety; the gesture still works without it */
    }
  };

  const onPointerMove = (event) => {
    /*
     * Re-arm a gesture the browser cancelled but the user never finished.
     *
     * Chromium may fire `pointercancel` or drop the capture mid-drag - when the window is moved
     * under the cursor, for instance. The button is then still down, so the next move with the
     * button held starts the drag again rather than leaving the user to release and press again.
     */
    if (!active && (event.buttons & 1) === 1) {
      if (!bridge()?.dragStart) return;
      if (event.target instanceof Element && event.target.closest(CONTROL_SELECTOR)) return;
      active = {
        pointerId: event.pointerId,
        screenX: event.screenX,
        screenY: event.screenY,
        element: event.target,
        started: false,
      };
    }
    if (!active || event.pointerId !== active.pointerId) return;
    if (active.started) return;
    if (!isDragGesture(event.screenX - active.screenX, event.screenY - active.screenY)) return;

    active.started = true;
    // The shell reads the cursor itself, so no coordinates cross the bridge.
    bridge().dragStart();
  };

  const onPointerUp = (event) => {
    if (!active || event.pointerId !== active.pointerId) return;
    finish('pointerup');
  };

  /** A cancel or a lost capture is recoverable: `onPointerMove` re-arms while the button is held. */
  const onPointerCancel = () => finish('pointercancel');
  const onLostCapture = () => finish('lostpointercapture');
  const onBlur = () => finish('blur');

  /** @param {string} reason recorded so a drag that ends on its own can be explained later */
  function finish(reason) {
    if (!active) return;
    const { element, pointerId, started: didStart } = active;
    active = null;
    try {
      element?.releasePointerCapture?.(pointerId);
    } catch {
      /* the element may be gone */
    }
    /*
     * Always end the gesture, even for a press that never moved.
     *
     * The shell holds a drag open until it hears the end, and it skips the auto-collapse check
     * for as long as one is open - so a leaked drag would stop the card rolling up at all, which
     * is exactly the symptom an earlier round was spent fixing. The shell decides what an empty
     * drag is worth persisting.
     */
    if (didStart) bridge()?.dragEnd?.();
    if (didStart && reason !== 'pointerup') console.info(`[overlay] 拖动被 ${reason} 结束`);
  }

  root.addEventListener('pointerdown', onPointerDown, true);
  root.addEventListener('pointermove', onPointerMove, true);
  root.addEventListener('pointerup', onPointerUp, true);
  root.addEventListener('pointercancel', onPointerCancel, true);
  // Backstops: a drag cannot survive the window losing focus or being hidden.
  root.addEventListener('lostpointercapture', onLostCapture, true);
  globalThis.addEventListener?.('blur', onBlur);

  return () => {
    root.removeEventListener('pointerdown', onPointerDown, true);
    root.removeEventListener('pointermove', onPointerMove, true);
    root.removeEventListener('pointerup', onPointerUp, true);
    root.removeEventListener('pointercancel', onPointerCancel, true);
    root.removeEventListener('lostpointercapture', onLostCapture, true);
    globalThis.removeEventListener?.('blur', onBlur);
    finish('uninstall');
  };
}
