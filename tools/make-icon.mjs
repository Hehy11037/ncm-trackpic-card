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
 * The owner sent a red play/pause mark and asked for it with a circular outside instead of the
 * rounded square. So: a red disc, a dark navy disc on it, and a white play triangle *outlined*
 * rather than filled - with a sliver of the red showing at its tip - beside two white pause bars.
 *
 * Two measurements decided the details, both from `tools/icon-candidates.mjs`:
 *
 *   * a 1.2-unit outline is beautiful at 256px and mush at 16px, where the tray lives. At 1.4 the
 *     outline survives the round trip through nine sizes without becoming a filled triangle, which
 *     would throw away the character of the reference;
 *   * the navy disc is 15.4 units across rather than the reference's proportion (13.9), because at
 *     16px every unit of glyph is worth more than any amount of red margin.
 */
const RED = [0xd1, 0x2a, 0x22];
const NAVY = [0x0c, 0x20, 0x30];
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
  { name: 'disc', d: circle(12, 12, 11.6), ink: RED },
  { name: 'screen', d: circle(12, 12, 7.7), ink: NAVY },
  // Painted before the triangle, so the outline covers all but a sliver of it - the red tip.
  { name: 'tip', d: circle(12.35, 12, 1.3), ink: RED },
  {
    name: 'play',
    d: 'M7.3 8.7L12.7 12L7.3 15.3z',
    ink: WHITE,
    fill: false,
    strokeWidth: 1.4,
  },
  { name: 'bar-1', d: roundedRect(13.8, 8.8, 1.4, 6.4, 0.7), ink: WHITE },
  { name: 'bar-2', d: roundedRect(16.0, 8.8, 1.4, 6.4, 0.7), ink: WHITE },
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
