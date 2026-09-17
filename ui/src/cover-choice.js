/**
 * Which cover to draw, when the user has chosen one of their own.
 *
 * The custom cover is a *presentation* override: the client still reports the song's real cover, and
 * the host still mirrors it. This is the one place that decides which of the two the card shows, kept
 * pure so the rule can be tested without a DOM or a shell.
 */

/**
 * @param {{trackUrl?: string|null, custom?: {url?: string|null, enabled?: boolean}|null}} input
 * @returns {string|null} the URL to draw, or null for the placeholder
 */
export function chooseCover({ trackUrl = null, custom = null } = {}) {
  if (custom && custom.enabled === true && typeof custom.url === 'string' && custom.url) return custom.url;
  return trackUrl ?? null;
}

/**
 * The cover button's state, which is also what the card renders.
 *
 * `empty` and `off` look the same but do different things on a click, so they are not merged: with
 * nothing chosen yet, a click opens the file picker; with something chosen but switched off, it
 * switches back on. Only `on` is "pressed".
 */
export function coverButtonState({ has = false, enabled = false } = {}) {
  if (!has) return 'empty';
  return enabled ? 'on' : 'off';
}

/**
 * The button's tooltip. Short on purpose: it names the control and the two gestures, and nothing else.
 *
 * `on` and `off` read the same because a left click switches either way; only before anything is chosen
 * does it have to say "选图", since there is nothing to switch yet.
 */
export function coverButtonTitle(state) {
  if (state === 'empty') return '自选封面（左键选图，右键清除）';
  return '自选封面（左键切换，右键清除）';
}

/**
 * Whether the image itself has to be fetched again, given the last state this side saw.
 *
 * `has` and `enabled` decide whether the picture is *drawn*; this decides whether the bytes changed.
 * Picking a second picture leaves both flags exactly as they were - still chosen, still on - so without
 * a revision number the card would keep drawing the first one, which is precisely the bug this exists
 * to prevent. The shell bumps `rev` whenever the image is replaced or cleared.
 */
export function shouldRefetchCover(previous, incoming) {
  if (incoming?.has !== true) return false;
  if (previous?.has !== true) return true;
  return previous.rev !== incoming.rev;
}
