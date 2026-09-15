/**
 * Where the transport row's five controls end up, computed from the stylesheet.
 *
 * The row is `[mode] [prev] [play] [next] [volume]` laid out by flexbox with `space-between`, two
 * equal-width side slots, and a centre group whose three buttons are held together by a `gap`. That
 * is enough to say exactly where each control lands - and the claim the whole arrangement rests on
 * is that the play button is on the *card's centre line*, which used to be arranged with absolute
 * positioning (and a transform repeated in every hover/active rule) and is now a consequence of the
 * two sides being the same width.
 *
 * Computed rather than eyeballed because there is no browser in the tooling shell: this is the only
 * way the layout can be measured before the owner looks at it. `check-interaction.mjs` asserts the
 * properties; `tools/render-icons.mjs --row` draws the result so it can be seen.
 *
 * All lengths are in `u` (1u = 1% of the card width), which is what `css.value()` returns.
 */

import { shorthandSides } from './css-values.mjs';

/** The five controls, in the order the row lays them out. */
export const ROW_ORDER = ['mode', 'previous', 'playPause', 'next', 'volume'];

/** The card width the pixel-valued declarations are relative to (the `中` preset). */
const CARD_PX = 440;
/** 1px expressed in u at that width. */
export const U_PER_PX = 100 / CARD_PX;

/**
 * The horizontal inset of the row: the padding of every ancestor between it and the card's edge.
 *
 * Not just `.card`'s - the row sits inside `section.face`, and `.face` is where the inset actually
 * lives (`padding: 17.69u 7.04u 8u` - three values, so left and right are the *second* one). Reading
 * only `.card` made the row look flush with the card's edges and put the mode and volume buttons 7u
 * further out than they are; reading the shorthand by index instead of by its own rules then made
 * left and right differ by a unit, which moved the play button off centre. Both mistakes were
 * possible because the play button lands at 50u either way when the inset is symmetric - so the
 * inset is computed the way CSS does, and a check asserts the symmetry it depends on.
 */
export function cardPadding(css) {
  const total = [0, 0, 0, 0];
  for (const selector of ['.card', '.face']) {
    const raw = css.declaration(selector, 'padding');
    if (!raw) continue;
    shorthandSides(raw).forEach((value, index) => {
      total[index] += css.evaluate(value);
    });
  }
  return { top: total[0], right: total[1], bottom: total[2], left: total[3] };
}

/**
 * Each control's centre and size, plus the intermediate numbers.
 *
 * The play button is a flex child of the centre group rather than an absolutely positioned box, so
 * its centre is the centre group's centre - which is the container's centre exactly when the two
 * side slots have equal width. That equality is the load-bearing fact, and it is returned as
 * `sidesEqual` so a check can say so instead of inferring it from two numbers that happen to match.
 */
export function transportRowLayout(css) {
  const padding = cardPadding(css);
  const side = css.value('.controls__side', 'width');
  const ctrl = css.value('.ctrl', 'width');
  const play = css.value('.ctrl--primary', 'width');
  const gap = css.value('.controls__center', 'gap');
  const centre = ctrl + gap + play + gap + ctrl;
  const rowWidth = 100 - padding.left - padding.right;
  const free = rowWidth - 2 * side - centre;
  const between = free / 2;
  const centreOf = (offset, size) => padding.left + offset + size / 2;

  const prevLeft = side + between;
  const playLeft = prevLeft + ctrl + gap;
  const nextLeft = playLeft + play + gap;
  const volumeLeft = rowWidth - side;

  const controls = {
    mode: { centre: centreOf(0, side), size: side },
    previous: { centre: centreOf(prevLeft, ctrl), size: ctrl },
    playPause: { centre: centreOf(playLeft, play), size: play },
    next: { centre: centreOf(nextLeft, ctrl), size: ctrl },
    volume: { centre: centreOf(volumeLeft, side), size: side },
  };

  // The volume panel: bar, the gap, the readout, its padding, and the two 1px borders.
  const popoverWidth =
    css.value('.volume-bar', 'width') +
    css.value('.volume-pop', 'gap') +
    css.value('.volume-pop__value', 'min-width') +
    css.shorthand('.volume-pop', 'padding', 1) * 2 +
    css.shorthand('.volume-pop', 'padding', 3) * 2 +
    2 * U_PER_PX;

  /*
   * Whether the two side slots really are the same width.
   *
   * The whole centring argument rests on this, and it is not self-evident from the stylesheet: the
   * volume side carries an extra class (`.controls__volume`) which could declare its own width and
   * silently shift the play button off centre. The right slot's width is therefore resolved the way
   * the cascade would - its own declaration if it has one, the shared one otherwise.
   */
  const rightSlotDeclared = css.declaration('.controls__volume', 'width');
  const rightSide = rightSlotDeclared === null ? side : css.value('.controls__volume', 'width');

  return {
    padding,
    rowWidth,
    side,
    rightSide,
    ctrl,
    play,
    gap,
    centre,
    between,
    /** True when the two side slots are the same width - what keeps the middle centred. */
    sidesEqual: Math.abs(side - rightSide) < 0.01,
    controls,
    popover: {
      width: popoverWidth,
      // Right-aligned to the volume slot, which is the card's right content edge.
      right: 100 - padding.right,
      left: 100 - padding.right - popoverWidth,
    },
  };
}
