/**
 * Move the window by dragging the card.
 *
 * Why not `-webkit-app-region: drag`: three rounds produced three arrangements and each traded one
 * broken feature for another. With the whole window declared draggable the colour band could not
 * be clicked, however its `no-drag` carve-out was sized (4px, then 26px); with only the card's
 * large surfaces declared draggable the band worked but the window could not be moved; with
 * nothing draggable the band worked and the window still could not be moved. The two pull against
 * each other, and the failure modes are not equal - a window that will not move is an annoyance, a
 * control that will not press is a bug.
 *
 * So nothing is a drag region, and dragging is an ordinary pointer gesture: press anywhere that is
 * not a control, then move.
 *
 * The shell does the moving (see `dragTarget` in shell-utils.mjs): it keeps the pressed point at
 * the same offset inside the window, which is what stops the cursor from outrunning the window and
 * escaping it. An escaped cursor used to mean no `pointerup`, a drag that never ended, and a card
 * left somewhere the user could not recover from by hand.
 *
 * **Where the cursor position comes from is the smoothness story.** It is sent from here, on
 * `pointermove`, and not polled on a timer in the shell:
 *
 *   - a `setInterval` in the main process fires *near* every 16ms, not on every frame, so the
 *     window is sometimes moved twice within one frame and sometimes not at all. The eye reads
 *     that irregularity as stutter even though every step is the same size.
 *   - `pointermove` is delivered in step with the compositor and carries the cursor position as of
 *     the frame being drawn, so moving the window once per event keeps it exactly under the cursor
 *     at every frame. That is what "smooth" means here.
 *
 * Coordinates are absolute screen positions, never deltas: a dropped event costs nothing, because
 * the next one carries the whole correction.
 */

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

  /** @type {{pointerId:number, element:any}|null} */
  let active = null;
  /** The newest cursor position not yet sent, and whether a frame is already queued for it. */
  let pending = null;
  let frame = 0;

  const startAt = (event) => {
    active = { pointerId: event.pointerId, element: event.target };
    try {
      event.target.setPointerCapture?.(event.pointerId);
    } catch {
      /* capture is a nicety; the gesture still works without it */
    }
    /*
     * Start on the press, with no movement threshold.
     *
     * There used to be a 3px threshold, to keep a plain click from nudging the window. It is not
     * needed - the shell only moves the window when the cursor actually moves - and it cost the
     * first few pixels of every drag, which reads as lag at exactly the moment the user is judging
     * the responsiveness.
     */
    bridge().dragStart(event.screenX, event.screenY);
  };

  /**
   * Whether a press landed on something that selects or activates.
   *
   * Duck-typed on `closest` rather than `instanceof Element`. The check is the only thing needed
   * from the target, and `instanceof` would make the gesture impossible to test outside a browser -
   * which is the only place the tests can run.
   */
  const isControl = (target) =>
    typeof target?.closest === 'function' && target.closest(CONTROL_SELECTOR) !== null;

  const onPointerDown = (event) => {
    if (event.button !== 0) return;
    if (!bridge()?.dragStart) return;
    if (isControl(event.target)) return;
    startAt(event);
  };

  const onPointerMove = (event) => {
    /*
     * Re-arm a gesture the browser cancelled but the user never finished.
     *
     * Chromium may fire `pointercancel` or drop the capture mid-drag - when the window is moved
     * under the cursor, for instance. The button is then still down, so the next move with the
     * button held starts the drag again rather than leaving the user to release and press again.
     */
    if (!active && (event.buttons & 1) === 1 && !isControl(event.target)) startAt(event);
    if (!active || event.pointerId !== active.pointerId) return;

    pending = { x: event.screenX, y: event.screenY };
    if (frame) return;
    // One send per frame. A 500Hz mouse would otherwise cross the bridge ten times per frame, and
    // nine of those would be thrown away by the compositor anyway.
    frame = requestAnimationFrame(() => {
      frame = 0;
      if (!active || !pending) return;
      bridge().dragMove?.(pending.x, pending.y);
    });
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
    const { element, pointerId } = active;
    active = null;
    pending = null;
    if (frame) {
      cancelAnimationFrame(frame);
      frame = 0;
    }
    try {
      element?.releasePointerCapture?.(pointerId);
    } catch {
      /* the element may be gone */
    }
    /*
     * Always end the gesture, even for a press that never moved.
     *
     * The shell holds a drag open until it hears the end, and it skips the auto-collapse check for
     * as long as one is open - so a leaked drag would stop the card rolling up at all, which is
     * exactly the symptom an earlier round was spent fixing. The shell decides what an empty drag
     * is worth persisting.
     */
    bridge()?.dragEnd?.();
    if (reason !== 'pointerup') console.info(`[overlay] 拖动被 ${reason} 结束`);
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
