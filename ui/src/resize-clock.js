/**
 * Drive the shell's window-resize tween from this side's animation frames.
 *
 * The shell can resize the window, but it has no frame clock: `setInterval` there fires *near* a
 * frame rather than on it - sometimes twice within one frame, sometimes not at all - and a resize
 * that steps irregularly looks jittery however smooth the curve is. A renderer's
 * `requestAnimationFrame` is tied to the compositor, so the shell asks for a tick and this answers
 * once per frame for as long as the tween lasts.
 *
 * The *values* stay in the shell: it computes each step from its own clock, so a late or missing
 * tick can only delay the motion, never distort the curve.
 *
 * This is the same lesson as the drag (see ./drag.js), applied to the other thing that moves.
 */

/**
 * @param {{ shell?: () => any }} [options]
 * @returns {() => void} unsubscribe
 */
export function installResizeClock(options = {}) {
  const bridge = options.shell ?? (() => globalThis.overlayShell ?? null);
  const api = bridge();
  if (!api?.onAnimateResize) return () => {};

  let frame = 0;
  let running = 0;

  const stop = () => {
    running = 0;
    if (frame) {
      cancelAnimationFrame(frame);
      frame = 0;
    }
  };

  const unsubscribe = api.onAnimateResize((request) => {
    stop();
    // Token 0 is the shell telling us to stop rather than starting anything.
    if (!request || !request.token) return;
    running = request.token;

    const tick = () => {
      if (running !== request.token) return;
      api.resizeTick(request.token);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
  });

  return () => {
    stop();
    unsubscribe?.();
  };
}
