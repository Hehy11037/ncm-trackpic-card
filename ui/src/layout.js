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
export const STAGE_WIDTH_UNITS = 100;

/**
 * Set `--u` from the stage's actual rendered size.
 *
 * The stage size itself is CSS (`min(94vw, 94vh * 9/16)`), so this only converts
 * "current width in px" into the unit the rest of the stylesheet is written in. It
 * runs on load and on resize, and it is measured from the element rather than from
 * the viewport so the two can never disagree.
 *
 * @param {HTMLElement} [stage] defaults to #stage
 * @returns {{ unit: number, width: number, height: number }}
 */
export function applyLayoutUnit(stage = document.getElementById('stage')) {
  const root = document.documentElement;

  // Fall back to the viewport if the element is missing, so a markup mistake
  // degrades to "wrong scale" rather than "everything is zero".
  const width = stage?.clientWidth || window.innerWidth * 0.94;
  const height = stage?.clientHeight || (width * 16) / 9;
  const unit = width / STAGE_WIDTH_UNITS || 3.6;

  root.style.setProperty('--u', `${unit.toFixed(5)}px`);
  root.style.setProperty('--stage-width', `${width}px`);
  root.style.setProperty('--stage-height', `${height}px`);

  return { unit, width, height };
}

/**
 * Choose the text scheme and scrim for a background colour.
 *
 * @param {{r:number,g:number,b:number}|null} background null means frosted glass
 * @returns {{ scheme: 'light'|'dark', scrim: string, contrast: number }}
 */
export function schemeFor(background) {
  if (!background) {
    return { scheme: 'light', scrim: 'transparent', contrast: 0 };
  }

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

/** Persisted background choice: 'glass' or a swatch index. */
const STORAGE_KEY = 'ncm-card:background';

export function loadBackgroundChoice() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw || raw === 'glass') return 'glass';
    const index = Number(raw);
    return Number.isInteger(index) && index >= 0 && index < 16 ? index : 'glass';
  } catch {
    return 'glass';
  }
}

export function saveBackgroundChoice(choice) {
  try {
    localStorage.setItem(STORAGE_KEY, String(choice));
  } catch {
    /* storage may be unavailable; the choice simply does not persist */
  }
}
