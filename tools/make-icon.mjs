#!/usr/bin/env node
// Build the app icon: the vector source, the multi-size .ico Windows wants, and a PNG for the README.
//
//   node tools/make-icon.mjs [--out assets]
//
// The design: a rounded card holding a record and a play triangle. Three reasons it was chosen over
// the seven other candidates in `tools/icon-candidates.mjs` (which draws them all at 16px on three
// backgrounds, and is worth looking at before changing this one):
//
//   * it survives every taskbar colour - a bare black disc disappears into a dark taskbar, and a
//     black note disappears completely. The card gives the mark its own background;
//   * the triangle is still legible at 16px (the tray's actual size), where the record's grooves are
//     already moiré;
//   * it depicts *this* app: a card, not a generic music glyph.
//
// The .ico is written with PNG payloads for each size (supported since Vista, and what every modern
// Windows app ships). Sizes cover 100/125/150/200/250% DPI plus the 256 the installer wants.
//
// It goes in `assets/`, not `build/`: `build/` is gitignored (it is where build *output* goes), and
// the icon has to be committed - the tray reads it at startup and an installer will read it at
// packaging time, on machines that never ran this script.

import { mkdirSync, writeFileSync } from 'node:fs';

import { encodePng, parsePath, rasterizeAlpha, styledSubpaths } from './svg-path.mjs';

const argv = process.argv.slice(2);
const at = argv.indexOf('--out');
const OUT = at >= 0 ? argv[at + 1] : 'assets';

/* ------------------------------------------------------------------- design */

/*
 * The owner sent a finished mark and said not to change the inner pattern or the colours. So these
 * numbers are not a design - they are `tools/measure-icon.mjs`'s output over that image, converted to
 * a 24-unit box with the red disc's diameter set to 24:
 *
 *   red disc        radius 12.00, colour #d02722 (208,39,34)
 *   navy circle     radius  7.06, colour #0d1927 (13,25,39)   (measured ratio 0.5881 of the disc)
 *   white outline   outer box x 7.34→12.43, y 8.49→15.49, stroke 1.29  ->  an inset path plus a
 *                   1.29 stroke with round joins reproduces that box exactly
 *   pause bars      x 13.03→14.31 and 15.37→16.63, y 8.66→15.31, rounded ends of half the width
 *   red at the tip  a flat rounded triangle from x 9.00 to its apex at 13.60, 2.00 tall at the left
 *
 * The one structural thing the measurements made clear, and that the eye does not: the red triangle
 * is painted **under** the white outline, not inside it. Its apex reaches 13.60 while the white
 * outline stops at 12.43, so what you see is red, then the outline crossing over it, then red again
 * past the apex - three pieces that look like two separate shapes until you see the order.
 *
 * Its corners are genuinely rounded in the reference, which a filled path cannot express; filling the
 * triangle *and* stroking it with the same colour at 0.45 with round joins does (the joins bulge the
 * corners by exactly that much).
 */
const RED = [0xd0, 0x27, 0x22];
const NAVY = [0x0d, 0x19, 0x27];
const WHITE = [0xff, 0xff, 0xff];

const hex = ([r, g, b]) => `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`;

/** A circle as two arcs; `clockwise` sets the winding, which is what makes a ring's hole. */
function circle(cx, cy, r, clockwise = true) {
  const sweep = clockwise ? 1 : 0;
  return `M${cx - r} ${cy}A${r} ${r} 0 1 ${sweep} ${cx + r} ${cy}A${r} ${r} 0 1 ${sweep} ${cx - r} ${cy}z`;
}

/** A rounded rectangle with independent width and height - the pause bars are not square. */
function roundedRect(x, y, width, height, radius) {
  const right = x + width;
  const bottom = y + height;
  return (
    `M${x + radius} ${y}H${right - radius}A${radius} ${radius} 0 0 1 ${right} ${y + radius}` +
    `V${bottom - radius}A${radius} ${radius} 0 0 1 ${right - radius} ${bottom}` +
    `H${x + radius}A${radius} ${radius} 0 0 1 ${x} ${bottom - radius}V${y + radius}` +
    `A${radius} ${radius} 0 0 1 ${x + radius} ${y}z`
  );
}

const DESIGN = [
  { name: 'disc', d: circle(12, 12, 12), ink: RED },
  { name: 'screen', d: circle(12, 12, 7.06), ink: NAVY },
  // Under the outline, and reaching past its apex: the red is one shape, seen in two pieces.
  { name: 'tip', d: 'M9.0 11.0L13.6 12L9.0 13.0z', ink: RED, strokeWidth: 0.45 },
  { name: 'play', d: 'M7.99 9.14L11.79 12L7.99 14.85z', ink: WHITE, fill: false, strokeWidth: 1.29 },
  { name: 'bar-1', d: roundedRect(13.03, 8.66, 1.29, 6.66, 0.645), ink: WHITE },
  { name: 'bar-2', d: roundedRect(15.37, 8.66, 1.26, 6.66, 0.63), ink: WHITE },
];

/* --------------------------------------------------------------------- files */

/** RGBA pixels with real transparency - an icon is not a white square. */
function renderRgba(design, size) {
  const layers = design.map((entry) => ({
    ink: entry.ink,
    // `fill: false` + a stroke width is how the outlined play triangle is drawn; everything else is
    // a filled shape.
    alpha: rasterizeAlpha(
      styledSubpaths(parsePath(entry.d), {
        fill: entry.fill ?? true,
        strokeWidth: entry.strokeWidth ?? 0,
      }),
      size,
    ),
  }));
  const out = Buffer.alloc(size * size * 4, 0);
  for (let i = 0; i < size * size; i++) {
    let [r, g, b, a] = [0, 0, 0, 0];
    for (const layer of layers) {
      const cover = layer.alpha[i];
      if (cover <= 0) continue;
      // Source-over: the layer's colour at `cover`, stacked onto what is already there.
      const outA = cover + a * (1 - cover);
      if (outA <= 0) continue;
      r = (layer.ink[0] * cover + r * a * (1 - cover)) / outA;
      g = (layer.ink[1] * cover + g * a * (1 - cover)) / outA;
      b = (layer.ink[2] * cover + b * a * (1 - cover)) / outA;
      a = outA;
    }
    out[i * 4] = Math.round(r);
    out[i * 4 + 1] = Math.round(g);
    out[i * 4 + 2] = Math.round(b);
    out[i * 4 + 3] = Math.round(a * 255);
  }
  return out;
}

/** An ICO holding a PNG for each size. `0` in a directory entry means 256. */
function encodeIco(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);

  const directory = Buffer.alloc(16 * images.length);
  let offset = header.length + directory.length;
  images.forEach((image, index) => {
    const entry = index * 16;
    directory[entry] = image.size >= 256 ? 0 : image.size;
    directory[entry + 1] = image.size >= 256 ? 0 : image.size;
    directory[entry + 2] = 0;
    directory[entry + 3] = 0;
    directory.writeUInt16LE(1, entry + 4);
    directory.writeUInt16LE(32, entry + 6);
    directory.writeUInt32LE(image.png.length, entry + 8);
    directory.writeUInt32LE(offset, entry + 12);
    offset += image.png.length;
  });

  return Buffer.concat([header, directory, ...images.map((image) => image.png)]);
}

mkdirSync(OUT, { recursive: true });

const svg = [
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="256" height="256">',
  '  <title>NCM Trackpic Card</title>',
  ...DESIGN.map((entry) => `  <path fill="${hex(entry.ink)}" d="${entry.d}" />`),
  '</svg>',
  '',
].join('\n');
writeFileSync(`${OUT}/icon.svg`, svg);

const SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256];
const images = SIZES.map((size) => ({ size, png: encodePng(renderRgba(DESIGN, size), size, size) }));
writeFileSync(`${OUT}/icon.ico`, encodeIco(images));
writeFileSync(`${OUT}/icon-256.png`, images[images.length - 1].png);

console.log(`图标 → ${OUT}/`);
console.log(`  icon.svg       矢量源（viewBox 24x24，三块路径）`);
console.log(`  icon.ico       ${SIZES.length} 个尺寸: ${SIZES.join(' ')}（共 ${(encodeIco(images).length / 1024).toFixed(1)}KB）`);
console.log(`  icon-256.png   给 README 用`);
