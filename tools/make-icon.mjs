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
/*
 * Calibration knobs. `tools/measure-icon.mjs` says the reference's white apex is *blunt* - its right
 * edge already reaches x=12.3 at y=11.0 - while a plain stroked triangle gives a sharp point whose
 * edge only gets there at y=12, leaving extra navy and red showing around it. Rounding the path's
 * corners is the fix, but the radius and the apex position interact (rounding pulls the outer apex
 * left, so the path apex has to move right to compensate). These two flags let a search find the pair
 * that matches, instead of me guessing it.
 */
const apexAt = argv.indexOf('--apex');
const ROUND = argv.indexOf('--round') >= 0 ? Number(argv[argv.indexOf('--round') + 1]) : null;
const APEX = apexAt >= 0 ? Number(argv[apexAt + 1]) : 11.79;
const FLAT = argv.indexOf('--flat') >= 0 ? Number(argv[argv.indexOf('--flat') + 1]) : 0.7;
/*
 * **The play triangle's apex is truncated, not pointed.**
 *
 * This is what the owner spotted as "an extra patch of black and an extra patch of red" at the
 * triangle's upper right, and it took a colour-run scan to find: with a pointed apex the white band's
 * right edge at y=11.0 sits at 11.44, while the reference's sits at 12.28 - because the reference's
 * apex ends in a short, almost vertical edge, so at that height it is still solid white. Everything
 * outside the point - navy where the reference has white, and the tip disc's red showing where the
 * reference's white still covers - is the "extra" the eye was picking up.
 *
 * 0.7 and 11.90 came out of a search over both knobs judged by `--compare`: 4.09% of pixels for the
 * pointed apex, **3.17%** for this one. `--flat`/`--apex`/`--round` on this script still drive the
 * same search.
 */
const APEX_HALF = FLAT;
const APEX_X = 11.9;

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
 *   red inside      a small rounded triangle, x 9.06 → apex 10.80, 2.09 tall
 *   red at the tip  a disc of radius 1.05 centred at (12.50, 12.00)
 *
 * **Two red pieces, not one** - which is what a scan along the centre line showed, after the eye had
 * been happy with a single shape for two rounds. The tip piece is a *disc*, and the navy halo around
 * it is what cuts into the first pause bar: at y=12 the reference reads
 * `red 12.49–13.57 | navy 13.63–13.94 | white 13.97–14.34`, and 12.50+1.05 and 12.50+1.40 land on
 * those two boundaries exactly. So the paint order is: bars, then the tip disc with its halo, then the
 * white outline (which covers the disc's left part), then the inner red triangle.
 *
 * The rounded corners the reference has, and a filled path cannot express, are made by filling each
 * red shape *and* stroking it with the same colour: the round joins bulge the corners by exactly that
 * much.
 *
 * **Known remaining difference** (measured, not glossed over): across the centre line my white
 * outline's apex band reads 10.97→12.19 where the reference's is 11.46→12.43, so the apex sits about
 * half a unit thicker. Everything else lands within roughly a pixel: the tip disc and its halo on
 * 12.38→13.59 and 13.59→13.88 against the reference's 12.49→13.57 and 13.63→13.94, bar 1's remnant on
 * 13.97→14.25 against 13.97→14.34, and the inner red triangle's left edge on 9.06 exactly.
 * `tools/measure-icon.mjs --compare` puts the whole icon at 4.09% of pixels, spread along the edges as
 * antialiasing.
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

/**
 * A triangle whose corners are rounded by `radius` along each edge.
 *
 * Unused, and kept because it was tried and *measured*: rounding the play triangle's corners by 0.3 or
 * 0.75 units moved the white apex to 12.19 or 11.72 (the reference's is at 12.43) and pushed the
 * overall disagreement up from 4.09% to 4.59%. The reference's apex is a sharp path after all. If
 * someone tries this again, measure it rather than trusting that rounder looks closer.
 */
function roundedTriangle(points, radius) {
  const [a, b, c] = points;
  const corner = (from, vertex, to) => {
    const length = (p, q) => Math.hypot(q[0] - p[0], q[1] - p[1]) || 1;
    const start = [
      vertex[0] + ((from[0] - vertex[0]) / length(vertex, from)) * radius,
      vertex[1] + ((from[1] - vertex[1]) / length(vertex, from)) * radius,
    ];
    const end = [
      vertex[0] + ((to[0] - vertex[0]) / length(vertex, to)) * radius,
      vertex[1] + ((to[1] - vertex[1]) / length(vertex, to)) * radius,
    ];
    return { start, end };
  };
  const first = corner(c, a, b);
  const second = corner(a, b, c);
  const third = corner(b, c, a);
  return (
    `M${first.start[0].toFixed(3)} ${first.start[1].toFixed(3)}` +
    `L${first.end[0].toFixed(3)} ${first.end[1].toFixed(3)}` +
    `Q${second.start[0].toFixed(3)} ${second.start[1].toFixed(3)} ${second.end[0].toFixed(3)} ${second.end[1].toFixed(3)}` +
    `L${third.end[0].toFixed(3)} ${third.end[1].toFixed(3)}` +
    `Q${third.start[0].toFixed(3)} ${third.start[1].toFixed(3)} ${first.start[0].toFixed(3)} ${first.start[1].toFixed(3)}` +
    `z`
  );
}

const DESIGN = [
  { name: 'disc', d: circle(12, 12, 12), ink: RED },
  { name: 'screen', d: circle(12, 12, 7.06), ink: NAVY },
  { name: 'bar-1', d: roundedRect(13.03, 8.66, 1.29, 6.66, 0.645), ink: WHITE },
  { name: 'bar-2', d: roundedRect(15.37, 8.66, 1.26, 6.66, 0.63), ink: WHITE },
  // The tip disc and its halo go *over* the bars - that navy ring is what notches the first bar.
  { name: 'tip-halo', d: circle(12.5, 12, 1.4), ink: NAVY },
  { name: 'tip', d: circle(12.5, 12, 1.05), ink: RED },
  // The white outline covers the tip disc's left part, so only its right side shows.
  {
    name: 'play',
    d:
      ROUND === null
        ? `M7.99 9.14L${APEX_X} ${12 - APEX_HALF}L${APEX_X} ${12 + APEX_HALF}L7.99 14.85z`
        : roundedTriangle([[7.99, 9.14], [APEX, 12], [7.99, 14.85]], ROUND),
    ink: WHITE,
    fill: false,
    strokeWidth: 1.29,
  },
  { name: 'inner', d: 'M9.06 10.96L10.8 12L9.06 13.04z', ink: RED, strokeWidth: 0.25 },
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
