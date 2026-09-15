/**
 * Layout: the card's proportions, and which of its two states is on screen.
 *
 * The card is a fixed-aspect composition whose content is multiplied by one unit (`--u`,
 * 1% of the card width) rather than a fluid layout, so it is identical at any size.
 *
 * Width comes from the stylesheet and height is derived from it. The *window* is the shell's
 * business: the shell sizes it as `card + 2 x shadow margin`, and the renderer works out
 * whether that makes the card or the rolled-up bar the right thing to draw.
 */

import { contrastRatio, luminance } from './palette.js';

/** The five reference palette colours; used until a cover provides its own. */
export const REFERENCE_PALETTE = [
  { r: 0x98, g: 0xb6, b: 0xbe },
  { r: 0xbd, g: 0xcb, b: 0xcc },
  { r: 0xeb, g: 0xf1, b: 0xf2 },
  { r: 0x4a, g: 0x63, b: 0x70 },
  { r: 0x73, g: 0xa0, b: 0xb1 },
];

const LIGHT_TEXT = { r: 0xed, g: 0xf1, b: 0xf3 };
const DARK_TEXT = { r: 0x2c, g: 0x32, b: 0x36 };

/**
 * Smallest stage width in CSS pixels.
 *
 * The reference's proportions assume a phone-sized canvas where 1u = 10.8px. Below a
 * certain width its literal sizes stop being legible, and clamping the *unit* to fix that
 * makes the content taller than the card (which clipped the title and artist). So the
 * stage itself is held at this minimum instead: 380px gives 1u = 3.8px, at which the
 * 4.63u title renders at ~17.6px. Keep in sync with `.stage` in tokens.css.
 */
const MIN_STAGE_WIDTH = 380;

/**
 * Stage aspect, measured from the reference's own pixels: its content area is
 * 1080 x 1958, so the ratio is 1 : 1.8136. This is *not* 9:16 (1 : 1.778); using 9:16
 * made the reference's literal type proportionally too tall and clipped the front face.
 *
 * Mirrored in ui/styles/tokens.css (`--card-aspect`) and apps/overlay/shell-utils.mjs
 * (`CARD_ASPECT`); tools/check-shell.mjs compares all three.
 */
export const STAGE_ASPECT = 1.8136;

/**
 * Height of the rolled-up bar, as a fraction of the card width.
 *
 * Mirrored in tokens.css (`--mini-ratio`) and shell-utils.mjs (`MINI_RATIO`).
 */
export const MINI_RATIO = 0.17;

/**
 * Set `--u` and the two stage heights from the stage's actual rendered size.
 *
 * Height is derived from the *width*, never from the element's own height: the height is
 * what the mode switch changes, so reading it back would be circular. The stylesheet owns
 * the width (`max(380px, 100vw - 2 x --shadow-pad)`, i.e. the window minus its shadow
 * margin), which is independent of the collapsed state.
 *
 * @param {HTMLElement} [stage] defaults to #stage
 * @returns {{ unit: number, width: number, height: number, miniHeight: number }}
 */
export function applyLayoutUnit(stage = document.getElementById('stage')) {
  const root = document.documentElement;

  const width = stage?.clientWidth || MIN_STAGE_WIDTH;
  /*
   * Both heights are rounded to whole pixels, matching the shell's `Math.round(card * aspect)`.
   *
   * A fractional stage height puts every absolutely-positioned face on a sub-pixel boundary,
   * which is exactly the kind of thing that shows up as a faint settle at the end of a flip.
   * It also cannot disagree with the window: `fitWindow` rounds the same expression, so the
   * card fills the window minus the shadow margin exactly.
   */
  const height = Math.round(width * STAGE_ASPECT);
  const miniHeight = Math.round(width * MINI_RATIO);
  const unit = width / 100;

  root.style.setProperty('--u', `${unit.toFixed(5)}px`);
  root.style.setProperty('--card-height', `${height}px`);
  root.style.setProperty('--mini-height', `${miniHeight}px`);

  return { unit, width, height, miniHeight };
}

/**
 * Expanded or rolled up, from the window's height alone.
 *
 * The threshold sits at the *collapsed* height rather than halfway between the two, and that is
 * deliberate. During the resize tween the window passes through every height in between, and the
 * card should stay the card until the window is essentially the strip:
 *
 *  - collapsing, the full card is clipped from below by the window's shrinking bottom edge, which
 *    is what a roll-up is supposed to look like. Switching to the mini bar halfway would make the
 *    card vanish while the window was still tall.
 *  - expanding, the card is drawn at full height with only its top visible and the growing window
 *    reveals it downwards. Switching late would leave the mini bar stretched over a tall window.
 *
 * `tolerance` absorbs the rounding between the shell's `Math.round(card * aspect)` and this
 * expression.
 *
 * @param {number} windowHeight current `window.innerHeight`
 * @param {number} collapsedWindowHeight window height while the strip is showing
 */
export function stageModeFor(windowHeight, collapsedWindowHeight, tolerance = 12) {
  return windowHeight <= collapsedWindowHeight + tolerance ? 'mini' : 'expanded';
}

/**
 * Decide whether the stage is showing the full card or the rolled-up bar.
 *
 * The *window's* height is the signal, not a message from the shell: the shell resizes the window
 * and the renderer follows, so the visible mode can never disagree with the window it is drawn in,
 * and no IPC round trip can leave the two out of step.
 *
 * @param {HTMLElement} [stage] defaults to #stage
 * @returns {'expanded' | 'mini'}
 */
export function syncStageMode(stage = document.getElementById('stage')) {
  if (!stage) return 'expanded';
  const width = stage.clientWidth || MIN_STAGE_WIDTH;
  const pad = Math.max(0, (window.innerWidth - width) / 2);
  // The strip's own window height: the threshold is measured against it, not against the card's.
  const collapsedWindowHeight = Math.round(width * MINI_RATIO) + pad * 2;
  const mode = stageModeFor(window.innerHeight, collapsedWindowHeight);
  if (stage.dataset.mode !== mode) stage.dataset.mode = mode;
  return mode;
}

/** Recompute the unit and the mode. Called on boot, on resize and by the ResizeObserver. */
export function relayout(stage = document.getElementById('stage')) {
  const metrics = applyLayoutUnit(stage);
  const mode = syncStageMode(stage);
  return { ...metrics, mode };
}

/**
 * Choose the text scheme and scrim for a background colour.
 *
 * @param {{r:number,g:number,b:number}} background
 * @returns {{ scheme: 'light'|'dark', scrim: string, contrast: number }}
 */
export function schemeFor(background) {
  if (!background) return { scheme: 'light', scrim: 'transparent', contrast: 0 };

  const bgLuma = luminance(background);
  const lightRatio = contrastRatio(bgLuma, luminance(LIGHT_TEXT));
  const darkRatio = contrastRatio(bgLuma, luminance(DARK_TEXT));

  const scheme = lightRatio >= darkRatio ? 'dark' : 'light';
  const contrast = Math.max(lightRatio, darkRatio);

  // Even the better text colour can fail on a mid-tone swatch. Those are exactly the
  // colours the user can pick, so strengthen the edge scrim instead of pretending.
  let scrim = 'transparent';
  if (contrast < 4.5) {
    scrim = scheme === 'dark' ? 'rgba(10, 14, 18, 0.42)' : 'rgba(255, 255, 255, 0.52)';
  } else if (contrast < 7) {
    scrim = scheme === 'dark' ? 'rgba(10, 14, 18, 0.24)' : 'rgba(255, 255, 255, 0.3)';
  }

  return { scheme, scrim, contrast };
}

/**
 * Persisted background choice: an index into the five-colour palette.
 *
 * The old "glass" value is treated as 0, so a choice saved by an earlier version does
 * not leave the card unbound.
 */
const STORAGE_KEY = 'ncm-card:background';

export function loadBackgroundChoice() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw || raw === 'glass') return 0;
    const index = Number(raw);
    return Number.isInteger(index) && index >= 0 && index < 5 ? index : 0;
  } catch {
    return 0;
  }
}

export function saveBackgroundChoice(choice) {
  try {
    localStorage.setItem(STORAGE_KEY, String(choice));
  } catch {
    /* storage may be unavailable; the choice simply does not persist */
  }
}
