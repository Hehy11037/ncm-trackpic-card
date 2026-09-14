/**
 * Layout: a fixed 9:16 stage, scaled to fit the viewport.
 *
 * This is the part that was wrong before. Scaling only from the window height meant
 * that a tall browser viewport blew every type size up - the reference design is a
 * *fixed* 9:16 canvas whose content is multiplied by one scale factor, not a fluid
 * layout. So the stage has a fixed design size, and `--u` is derived from the scale
 * needed to fit it into the viewport. The composition is then identical at any size,
 * in a browser or in the desktop shell, and never grows past a sane maximum.
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
 * Design size of the stage, in layout units. The stage is 100 units wide and 9:16
 * tall, and `--u` is **1% of the stage's rendered width**, so every measurement
 * scales with the card and the proportions never change.
 */
/**
 * Smallest stage width in CSS pixels.
 *
 * The reference's proportions assume a phone-sized canvas where 1u = 10.8px. Below a
 * certain width its literal sizes stop being legible, and clamping the *unit* to fix that
 * makes the content taller than the card (which clipped the title and artist). So the
 * stage itself is held at this minimum instead: 380px gives 1u = 3.8px, at which the
 * 4.63u title renders at ~17.6px. Keep in sync with the `.stage` rule in tokens.css.
 */
const MIN_STAGE_WIDTH = 380;

/** Stage aspect: 100u wide and 9:16 tall. */
export const STAGE_HEIGHT_UNITS = (100 * 16) / 9;

/**
 * Set `--u` from the stage's actual rendered size.
 *
 * The stage size is CSS (`max(380px, min(94vw, 94vh * 9/16))`), so this converts
 * "current width in px" into the unit the stylesheet is written in. Measured from the
 * element rather than the viewport so the two cannot disagree.
 *
 * @param {HTMLElement} [stage] defaults to #stage
 * @returns {{ unit: number, width: number, height: number }}
 */
export function applyLayoutUnit(stage = document.getElementById('stage')) {
  const root = document.documentElement;

  const width = stage?.clientWidth || MIN_STAGE_WIDTH;
  const height = stage?.clientHeight || width * (16 / 9);
  const unit = width / 100;

  root.style.setProperty('--u', `${unit.toFixed(5)}px`);
  root.style.setProperty('--card-height', `${height.toFixed(2)}px`);
  root.style.setProperty('--stage-width', `${width}px`);
  root.style.setProperty('--stage-height', `${height}px`);

  return { unit, width, height };
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
