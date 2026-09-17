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

const INK = [26, 26, 30];
const PAPER = [245, 245, 247];
const ACCENT = [222, 74, 62]; // a warm red, deliberately not NetEase's own tone
const SLATE = [58, 62, 78];

/* ----------------------------------------------------------------- candidates */

/**
 * Each candidate returns paths in the 24x24 box. `onDark` says whether the mark is meant for a
 * light background (most are: they are drawn with the ink colour on the viewer's background).
 */
const CANDIDATES = [
  {
    id: 'vinyl',
    label: '黑胶（凹槽）',
    note: '最"唱片"，但凹槽在 16px 会糊成一片',
    paths: () => [
      { d: circle(12, 12, 10.4), ink: INK },
      { d: ring(12, 12, 10.4, 9.3), ink: PAPER },
      { d: ring(12, 12, 8.6, 7.7), ink: PAPER },
      { d: ring(12, 12, 7.0, 6.3), ink: PAPER },
      { d: ring(12, 12, 5.6, 5.1), ink: PAPER },
      { d: circle(12, 12, 3.1), ink: PAPER },
      { d: circle(12, 12, 1.15), ink: INK },
    ],
  },
  {
    id: 'disc-play',
    label: '唱片＋播放三角',
    note: '一条实心圆＋白色三角，16px 仍然清楚',
    paths: () => [
      { d: circle(12, 12, 10.4), ink: INK },
      { d: circle(12, 12, 7.4), ink: PAPER },
      { d: triangle(12.7, 12, 7.2), ink: INK },
    ],
  },
  {
    id: 'disc-play-ring',
    label: '圆环＋播放三角',
    note: '细圆环更有"唱片"味，小尺寸靠三角撑住',
    paths: () => [
      { d: ring(12, 12, 10.6, 8.4), ink: INK },
      { d: ring(12, 12, 7.2, 6.6), ink: INK },
      { d: triangle(12.6, 12, 6.4), ink: INK },
    ],
  },
  {
    id: 'cd',
    label: 'CD／光盘',
    note: '中心大孔＋一道高光，一眼是光盘',
    paths: () => [
      { d: circle(12, 12, 10.4), ink: INK },
      { d: circle(12, 12, 3.6), ink: PAPER },
      { d: ring(12, 12, 4.6, 3.6), ink: INK },
      { d: `M4.6 8.1A10.4 10.4 0 0 1 15.6 1.9L15.1 3.5A8.8 8.8 0 0 0 6 9.2z`, ink: PAPER },
    ],
  },
  {
    id: 'card-disc',
    label: '卡片＋唱片（跟这个 app 对应）',
    note: '一张卡片上嵌着唱片 —— 图标本身说明了"卡片"这件事',
    paths: () => [
      { d: roundedSquare(2.2, 2.2, 19.6, 4.2), ink: SLATE },
      { d: circle(12, 12, 6.6), ink: PAPER },
      { d: triangle(12.8, 12, 6.2), ink: SLATE },
    ],
  },
  {
    id: 'note',
    label: '音符',
    note: '最通用的"音乐"，但和别的播放器没有区别',
    paths: () => [
      { d: `M15.4 2.6c0-.6.4-1 1-1.1l3.4-.6c.7-.1 1.2.4 1.2 1v13.4a3.6 3.6 0 1 1-2-3.2V6.3l-5.6 1v9.9a3.6 3.6 0 1 1-2-3.2V2.6z`, ink: INK },
    ],
  },
  {
    id: 'groove-play',
    label: '唱片＋三角（低对比高光版）',
    note: '同"唱片＋播放三角"，但用浅色圆做高光，观感更轻',
    paths: () => [
      { d: circle(12, 12, 10.4), ink: INK },
      { d: ring(12, 12, 9.6, 9.1), ink: [90, 90, 98] },
      { d: ring(12, 12, 8.2, 7.7), ink: [90, 90, 98] },
      { d: circle(12, 12, 6.2), ink: PAPER },
      { d: triangle(12.5, 12, 5.6), ink: INK },
    ],
  },
  {
    id: 'accent-disc-play',
    label: '唱片＋三角（强调色）',
    note: '同上一版但用暖红强调色，桌面上更醒目；托盘里会换单色版',
    paths: () => [
      { d: circle(12, 12, 10.4), ink: ACCENT },
      { d: circle(12, 12, 7.4), ink: PAPER },
      { d: triangle(12.7, 12, 7.2), ink: INK },
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