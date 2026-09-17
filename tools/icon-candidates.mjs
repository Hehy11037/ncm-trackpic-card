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

// From the reference the owner sent: a teal machined player with a round screen, a magenta play
// button and two pale pill keys either side of it. The colours are sampled from that photograph -
// teal body, deep-navy screen, magenta accent - and the slab's thickness is suggested by drawing a
// darker body a fraction lower and letting it peek out along the bottom edge. An isometric view would
// be truer to the photograph and unreadable at 16px, so the mark is the device seen face-on.
const TEAL = [0x6e, 0xc6, 0xcc];
const TEAL_LIGHT = [0x9a, 0xdd, 0xe0];
const TEAL_DARK = [0x46, 0x9c, 0xa6];
const SCREEN = [0x13, 0x21, 0x36];
const SCREEN_EDGE = [0x2c, 0x3d, 0x58];
const MAGENTA = [0xe0, 0x3a, 0x8e];
const PAPER = [0xf4, 0xf8, 0xfa];
const PILL = [0xc9, 0xe6, 0xe9];

/* ----------------------------------------------------------------- candidates */

const body = (y = 1.6, ink = TEAL) => ({ d: roundedSquare(1.6, y, 20.8, 4.8), ink });
const slab = { d: roundedSquare(1.6, 2.4, 20.8, 4.8), ink: TEAL_DARK };
const screen = (r = 7.6, ink = SCREEN) => ({ d: circle(12, 12, r), ink });
const pills = [
  { d: roundedSquare(5.2, 11.3, 3.4, 1.7), ink: PILL },
  { d: roundedSquare(15.4, 11.3, 3.4, 1.7), ink: PILL },
];
const playDisc = { d: circle(12, 12, 3.5), ink: MAGENTA };
const playGlyph = { d: 'M10.7 9.9L14.3 12L10.7 14.1z', ink: PAPER };

const CANDIDATES = [
  {
    id: 'dap-teal',
    label: '青绿机身＋圆屏＋品红播放键＋两颗胶囊键',
    note: '最接近参考图；胶囊键在 16px 会变成两个小点',
    paths: () => [slab, body(), screen(), ...pills, playDisc, playGlyph],
  },
  {
    id: 'dap-teal-clean',
    label: '同上但去掉胶囊键',
    note: '更干净，16px 更稳；代价是少了"机器"的细节',
    paths: () => [slab, body(), screen(), playDisc, playGlyph],
  },
  {
    id: 'dap-big-screen',
    label: '屏幕更大、播放键更大',
    note: '小尺寸下品红更醒目（屏幕 r=8.4，播放键 r=4.1）',
    paths: () => [
      slab,
      body(),
      { d: circle(12, 12, 8.4), ink: SCREEN },
      { d: circle(12, 12, 4.1), ink: MAGENTA },
      { d: 'M10.5 9.4L14.7 12L10.5 14.6z', ink: PAPER },
    ],
  },
  {
    id: 'dap-light-teal',
    label: '浅青机身（更亮）',
    note: '机身更浅、对比更柔；深色任务栏上更跳',
    paths: () => [
      { d: roundedSquare(1.6, 2.4, 20.8, 4.8), ink: [0x74, 0xc8, 0xce] },
      body(1.6, TEAL_LIGHT),
      screen(),
      playDisc,
      playGlyph,
    ],
  },
  {
    id: 'dap-navy',
    label: '深青机身（不用黑色，用深青）',
    note: '机身深、屏幕更深；品红仍是唯一亮点',
    paths: () => [
      { d: roundedSquare(1.6, 2.4, 20.8, 4.8), ink: [0x0f, 0x3a, 0x44] },
      body(1.6, [0x17, 0x5b, 0x66]),
      screen(7.6, [0x0b, 0x16, 0x26]),
      playDisc,
      playGlyph,
    ],
  },
  {
    id: 'dap-magenta-ring',
    label: '青绿机身＋品红圆环（像参考图顶上的环）',
    note: '参考图机身右上有个小环，这里放成屏幕外圈',
    paths: () => [
      slab,
      body(),
      screen(7.9, SCREEN_EDGE),
      screen(7.1, SCREEN),
      playDisc,
      playGlyph,
    ],
  },
  {
    id: 'dap-glyph-only',
    label: '青绿机身＋圆屏＋白色三角（不用品红）',
    note: '更素；16px 下最清楚的一版',
    paths: () => [slab, body(), screen(), { d: 'M9.9 8.4L15.6 12L9.9 15.6z', ink: PAPER }],
  },
  {
    id: 'dap-final',
    label: '浅青机身＋两颗胶囊键＋更大的品红键',
    note: '组合：参考图的胶囊键 + 更亮的机身 + 更醒目的品红键',
    paths: () => [
      { d: roundedSquare(1.6, 2.4, 20.8, 4.8), ink: [0x74, 0xc8, 0xce] },
      body(1.6, TEAL_LIGHT),
      { d: circle(12, 12, 7.9), ink: SCREEN },
      { d: roundedSquare(5.0, 11.2, 3.6, 1.8), ink: PILL },
      { d: roundedSquare(15.4, 11.2, 3.6, 1.8), ink: PILL },
      { d: circle(12, 12, 3.9), ink: MAGENTA },
      { d: 'M10.6 9.6L14.6 12L10.6 14.4z', ink: PAPER },
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