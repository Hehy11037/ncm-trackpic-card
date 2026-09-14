/**
 * Layout unit + background/contrast decisions.
 *
 * Two responsibilities that both belong to the "how does it look" layer:
 *
 *  1. `applyLayoutUnit()` keeps the composition proportional. The reference design
 *     draws on a fixed 9:16 canvas and multiplies every offset by a scale factor;
 *     we do the same thing with a CSS custom property, set from the window height.
 *
 *  2. `schemeFor()` decides whether text goes light or dark. This matters most when
 *     the user paints the card with one of the five palette colours, because a
 *     mid-tone swatch can be unreadable with either choice - so the scrim strength
 *     is raised for those, rather than flipping text to a colour that does not
 *     actually contrast.
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

/** How tall the reference card is, in layout units. Sets the density. */
const CARD_HEIGHT_UNITS = 111;

/** Compute `--u` from the window so the card keeps its proportions at any size. */
export function applyLayoutUnit() {
  const height = Math.max(240, window.innerHeight || 600);
  const unit = height / CARD_HEIGHT_UNITS;
  document.documentElement.style.setProperty('--u', `${unit.toFixed(3)}px`);
  return unit;
}

/**
 * Choose the text scheme and scrim for a background colour.
 *
 * @param {{r:number,g:number,b:number}|null} background null means frosted glass
 * @returns {{ scheme: 'light'|'dark', scrim: string, contrast: number }}
 */
export function schemeFor(background) {
  if (!background) {
    // Glass: the panel is light by default, so dark text. The scrim stays off.
    return { scheme: 'light', scrim: 'transparent', contrast: 0 };
  }

  const bgLuma = luminance(background);
  const lightRatio = contrastRatio(bgLuma, luminance(LIGHT_TEXT));
  const darkRatio = contrastRatio(bgLuma, luminance(DARK_TEXT));

  const scheme = lightRatio >= darkRatio ? 'dark' : 'light';
  const contrast = Math.max(lightRatio, darkRatio);

  // Below this the text would fail even with the better choice, so darken (or
  // lighten) the top and bottom edges with a scrim, which is where the text sits.
  let scrim = 'transparent';
  if (contrast < 4.5) {
    scrim = scheme === 'dark' ? 'rgba(10, 14, 18, 0.42)' : 'rgba(255, 255, 255, 0.5)';
  } else if (contrast < 7) {
    scrim = scheme === 'dark' ? 'rgba(10, 14, 18, 0.22)' : 'rgba(255, 255, 255, 0.28)';
  }

  return { scheme, scrim, contrast };
}

/** Persisted background choice: 'glass' or a swatch index. */
const STORAGE_KEY = 'ncm-card:background';

export function loadBackgroundChoice() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return 'glass';
    if (raw === 'glass') return 'glass';
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
    /* private mode or storage disabled; the choice just does not persist */
  }
}
