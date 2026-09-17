#!/usr/bin/env node
// Draw candidate app/tray icons and lay them out at every size that matters.
//
//   node tools/icon-candidates.mjs [--out .scratch/icons-candidates]
//
// The owner asked for an icon, with "record / CD / mp3 / mp4" as the starting point and no fixed
// idea. This is how to answer that without guessing: draw several, at 256px *and* at the sizes the
// icon actually has to survive - a Windows tray icon is 16px, and nearly every mark that looks good
// at 256 turns to mud there.
//
// Each candidate is a list of SVG paths in a 24x24 box, so the chosen one can be shipped as an SVG
// and rasterised by the same code that made it (tools/svg-path.mjs).
//
// Winding matters and is deliberate: a ring is an outer circle wound one way and an inner circle
// wound the other, which under the nonzero rule leaves a hole. The same rule is why the card's mute
// cross rendered as four diamonds once - here the hole is the point.

import { mkdirSync, writeFileSync } from 'node:fs';

import { blankCanvas, blitIcon, encodePng, parsePath, rasterizeAlpha, styledSubpaths } from './svg-path.mjs';

const OUT = (() => {
  const argv = process.argv.slice(2);
  const at = argv.indexOf('--out');
  return at >= 0 ? argv[at + 1] : '.scratch/icons-candidates';
})();

/* ---------------------------------------------------------------- path helpers */

/** A circle as two arcs; `clockwise` decides the winding, which is what makes holes. */
function circle(cx, cy, r, clockwise = true) {
  const sweep = clockwise ? 1 : 0;
  return `M${cx - r} ${cy}A${r} ${r} 0 1 ${sweep} ${cx + r} ${cy}A${r} ${r} 0 1 ${sweep} ${cx - r} ${cy}z`;
}

/** A ring: outer clockwise, inner counter-clockwise, so the middle is a hole. */
function ring(cx, cy, outer, inner) {
  return circle(cx, cy, outer, true) + circle(cx, cy, inner, false);
}

function roundedSquare(x, y, size, radius) {
  const r = radius;
  const right = x + size;
  const bottom = y + size;
  return (
    `M${x + r} ${y}H${right - r}A${r} ${r} 0 0 1 ${right} ${y + r}V${bottom - r}` +
    `A${r} ${r} 0 0 1 ${right - r} ${bottom}H${x + r}A${r} ${r} 0 0 1 ${x} ${bottom - r}` +
    `V${y + r}A${r} ${r} 0 0 1 ${x + r} ${y}z`
  );
}

const triangle = (cx, cy, size) =>
  `M${cx - size * 0.36} ${cy - size * 0.5}L${cx + size * 0.55} ${cy}L${cx - size * 0.36} ${cy + size * 0.5}z`;

/* ------------------------------------------------------------------- palettes */

// From the second reference the owner sent, and their one change to it: a red disc, a dark navy
// circle on it, and a white play triangle *outlined* (not filled) beside two white pause bars - with
// a sliver of red showing at the triangle's tip. The outer shape is a circle rather than the
// reference's rounded square, which is what the owner asked for; it removes the square's corners from
// the silhouette and makes the mark read the same at every size.
const RED = [0xd1, 0x2a, 0x22];
const RED_DEEP = [0xb4, 0x20, 0x1a];
const NAVY = [0x0c, 0x20, 0x30];
const WHITE = [0xff, 0xff, 0xff];

/* ----------------------------------------------------------------- candidates */

/** A rounded rectangle with independent width and height - the pause bars are not square. */
function roundedRect(x, y, w, h, r) {
  const right = x + w;
  const bottom = y + h;
  return (
    `M${x + r} ${y}H${right - r}A${r} ${r} 0 0 1 ${right} ${y + r}V${bottom - r}` +
    `A${r} ${r} 0 0 1 ${right - r} ${bottom}H${x + r}A${r} ${r} 0 0 1 ${x} ${bottom - r}` +
    `V${y + r}A${r} ${r} 0 0 1 ${x + r} ${y}z`
  );
}

/** The glyph: an outlined play triangle whose tip carries a sliver of red, plus two pause bars. */
const glyph = (scale = 1, strokeWidth = 1.2, withBars = true) => {
  const cx = 12;
  const cy = 12;
  const s = scale;
  const paths = [
    { d: circle(cx + 0.3 * s, cy, 1.25 * s), ink: RED },
    {
      d: `M${cx - 4.5 * s} ${cy - 3.1 * s}L${cx + 0.7 * s} ${cy}L${cx - 4.5 * s} ${cy + 3.1 * s}z`,
      fill: false,
      strokeWidth: strokeWidth * s,
      ink: WHITE,
    },
  ];
  if (withBars) {
    paths.push(
      { d: roundedRect(13.7, 8.9, 1.35, 6.2, 0.68), ink: WHITE },
      { d: roundedRect(15.9, 8.9, 1.35, 6.2, 0.68), ink: WHITE },
    );
  }
  return paths;
};

const CANDIDATES = [
  {
    id: 'red-playpause',
    label: '红圆盘＋蓝圆＋白色描边三角＋暂停条（参考图，外围改圆）',
    note: '按你说的把外围也做成圆形',
    paths: () => [{ d: circle(12, 12, 11.6), ink: RED }, { d: circle(12, 12, 7.2), ink: NAVY }, ...glyph()],
  },
  {
    id: 'red-playpause-square',
    label: '同上但保留参考图的圆角方形',
    note: '与原图最接近的一版，用来对照',
    paths: () => [
      { d: roundedRect(0.9, 0.9, 22.2, 22.2, 4.4), ink: RED },
      { d: circle(12, 12, 7.2), ink: NAVY },
      ...glyph(),
    ],
  },
  {
    id: 'red-play-only',
    label: '红圆盘＋蓝圆＋描边三角（去掉暂停条）',
    note: '更简洁；16px 下只剩一个三角轮廓',
    paths: () => [
      { d: circle(12, 12, 11.6), ink: RED },
      { d: circle(12, 12, 7.4), ink: NAVY },
      ...glyph(1.15, 1.3, false),
    ],
  },
  {
    id: 'red-playpause-thick',
    label: '同上但白色更粗（描边 1.6）',
    note: '小尺寸下更清楚，代价是更"重"',
    paths: () => [
      { d: circle(12, 12, 11.6), ink: RED },
      { d: circle(12, 12, 7.4), ink: NAVY },
      ...glyph(1.05, 1.6),
    ],
  },
  {
    id: 'red-fill-play',
    label: '红圆盘＋蓝圆＋实心白三角＋暂停条',
    note: '填充三角（不是描边），最传统、最清楚',
    paths: () => [
      { d: circle(12, 12, 11.6), ink: RED },
      { d: circle(12, 12, 7.2), ink: NAVY },
      { d: circle(12.3, 12, 1.25), ink: RED },
      { d: 'M7.5 8.9L12.7 12L7.5 15.1z', ink: WHITE },
      { d: roundedRect(13.7, 8.9, 1.35, 6.2, 0.68), ink: WHITE },
      { d: roundedRect(15.9, 8.9, 1.35, 6.2, 0.68), ink: WHITE },
    ],
  },
  {
    id: 'red-deep',
    label: '深一点的红（更沉）',
    note: '红更暗，不刺眼；其余同第一版',
    paths: () => [
      { d: circle(12, 12, 11.6), ink: RED_DEEP },
      { d: circle(12, 12, 7.2), ink: NAVY },
      ...glyph(),
    ],
  },
  {
    id: 'red-playpause-big',
    label: '蓝圆与图形都更大',
    note: '小尺寸下白色更醒目（蓝圆 r=8.0，图形放大 1.1）',
    paths: () => [
      { d: circle(12, 12, 11.7), ink: RED },
      { d: circle(12, 12, 8.0), ink: NAVY },
      ...glyph(1.1, 1.3),
    ],
  },
];

/* --------------------------------------------------------------------- render */

mkdirSync(OUT, { recursive: true });

/** A candidate compiled into blittable paths. */
const compiled = CANDIDATES.map((candidate) => ({
  ...candidate,
  paths: candidate.paths().map((entry) => ({
    subpaths: parsePath(entry.d),
    fill: entry.fill ?? true,
    strokeWidth: entry.strokeWidth ?? 0,
    ink: entry.ink ?? INK,
  })),
}));

/*
 * Sheet 1: what each mark is, at a size where it can be judged as a design.
 *
 * 128px, then the three sizes that decide whether it survives - 48 (taskbar), 32 (Alt-Tab, small
 * tray), 16 (tray at 100% DPI).
 */
const CELL = 150;
const sheet = blankCanvas(24 + CELL * compiled.length, 210, 255);
compiled.forEach((candidate, column) => {
  const x = 12 + column * CELL;
  blitIcon(sheet, candidate.paths, { size: 128, x, y: 12 });
  blitIcon(sheet, candidate.paths, { size: 48, x, y: 148 });
  blitIcon(sheet, candidate.paths, { size: 32, x: x + 56, y: 156 });
  blitIcon(sheet, candidate.paths, { size: 16, x: x + 96, y: 164 });
});
writeFileSync(`${OUT}/candidates-detail.png`, encodePng(sheet.rgba, sheet.width, sheet.height));

/*
 * Sheet 2: the honest view - the mark *as 16 pixels*, blown up by copying whole pixels.
 *
 * The sheet above is a lie about small sizes: a 16px rendering placed in a big canvas is still a
 * 16px rendering, but it is surrounded by white space that flatters it. Nearest-neighbour zoom shows
 * what the tray will actually paint, on a light taskbar, a dark one, and a mid-grey one - an icon
 * that only works on one of them disappears for half the users.
 */
const ZOOM = 8;
const zoomCell = 16 * ZOOM + 12;
const zoomSheet = blankCanvas(12 + compiled.length * zoomCell, 12 + 3 * (16 * ZOOM + 12), 250);
const BACKDROPS = [250, 30, 130];
compiled.forEach((candidate, column) => {
  const layers = candidate.paths.map((entry) => ({
    ink: entry.ink,
    alpha: rasterizeAlpha(styledSubpaths(entry.subpaths, entry), 16),
  }));
  BACKDROPS.forEach((backdrop, row) => {
    const baseX = 6 + column * zoomCell;
    const baseY = 6 + row * (16 * ZOOM + 12);
    for (let py = 0; py < 16; py++) {
      for (let px = 0; px < 16; px++) {
        let color = [backdrop, backdrop, backdrop + 2];
        for (const layer of layers) {
          const a = layer.alpha[py * 16 + px];
          if (a <= 0) continue;
          color = color.map((channel, index) => Math.round(channel * (1 - a) + layer.ink[index] * a));
        }
        for (let dy = 0; dy < ZOOM; dy++) {
          for (let dx = 0; dx < ZOOM; dx++) {
            const at = ((baseY + py * ZOOM + dy) * zoomSheet.width + baseX + px * ZOOM + dx) * 4;
            zoomSheet.rgba[at] = color[0];
            zoomSheet.rgba[at + 1] = color[1];
            zoomSheet.rgba[at + 2] = color[2];
            zoomSheet.rgba[at + 3] = 255;
          }
        }
      }
    }
  });
});
writeFileSync(`${OUT}/candidates-16px-zoom.png`, encodePng(zoomSheet.rgba, zoomSheet.width, zoomSheet.height));

console.log(`候选图标 → ${OUT}\n`);
compiled.forEach((candidate, index) => {
  console.log(`  ${index + 1}. ${candidate.id.padEnd(20)} ${candidate.label}`);
  console.log(`     ${candidate.note}`);
});
console.log(`\n  细节图（128px + 48/32/16px）: ${OUT}/candidates-detail.png`);
console.log(`  16px 像素放大 8 倍（浅/深/中底）: ${OUT}/candidates-16px-zoom.png`);
console.log('  两图里候选的顺序都与上表一致，从左到右。');