#!/usr/bin/env node
// Draw the card's own SVG icons into PNG files, so they can be looked at.
//
//   node tools/render-icons.mjs [--out .scratch/icons] [--size 96]
//
// This exists because there is no way to see the card from the tooling shell: `tools/shot.mjs`
// needs to launch Chromium, which the sandbox refuses, so every icon ever written for this project
// shipped on the strength of "the path looks plausible". It found two real defects the first time
// it ran: the sound waves rendered as *nothing* (they are strokes, and a fill-only rasteriser draws
// no stroke), and the mute cross rendered as a hollow parallelogram - the whole svg is
// `fill: none`, so a closed quad was being outlined instead of filled.
//
// Fill versus stroke is therefore read from the real stylesheet rather than assumed, and a stroke
// is rasterised by turning each segment into a quad and each vertex into a disc.

import { mkdirSync, writeFileSync } from 'node:fs';

import { makeCssReader, readStyle } from './css-values.mjs';
import {
  encodePng,
  extractIcons,
  iconStyle,
  parsePath,
  pathBounds,
  rasterizeAlpha,
  renderSheet,
  styledSubpaths,
  visibleAt,
} from './svg-path.mjs';

function parseArgs(argv) {
  const out = { out: '.scratch/icons', size: 96 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') out.out = argv[++i];
    else if (a === '--size') out.size = Number(argv[++i]);
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const html = readStyle('ui/index.html');
const tokensText = readStyle('ui/styles/tokens.css');
const cardText = readStyle('ui/styles/card.css');
const css = makeCssReader({ tokens: tokensText, rules: `${tokensText}\n${cardText}` });

const icons = extractIcons(html);

mkdirSync(args.out, { recursive: true });

let failures = 0;
const drawn = [];
console.log(`共 ${icons.length} 个 <svg>，输出到 ${args.out}\n`);

const slug = (text, fallback) => text.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '') || fallback;

icons.forEach((icon, index) => {
  const shape = icon.paths
    .map((path) => ({ path, style: iconStyle(css, icon.owner, path.cls) }))
    .map((entry) => ({ ...entry, subpaths: parsePath(entry.path.d) }));
  const name = slug(`${icon.owner}-${icon.cls || shape.map((s) => s.path.cls).join('-')}`, `icon-${index}`);

  // One file per icon, with every path painted the way the card paints it.
  const { rgba, width, height } = renderSheet(
    [{ paths: shape.map(({ subpaths, style }) => ({ subpaths, ...style })) }],
    { size: args.size, gap: 0, columns: 1 },
  );
  const file = `${args.out}/${name}.png`;
  writeFileSync(file, encodePng(rgba, width, height));
  drawn.push({ file, cls: icon.cls || icon.owner });

  /*
   * And each path on its own.
   *
   * The combined image is the union of every state a glyph has - the volume button's speaker, its
   * two sound waves and its mute cross are never all on screen at once, because the stylesheet
   * hides the ones that do not apply. Judging the shape of the cross therefore means looking at the
   * cross, not at a tangle of three shapes that never coexist.
   */
  shape.forEach(({ path, subpaths, style }, pathIndex) => {
    if (shape.length < 2) return;
    const single = renderSheet([{ paths: [{ subpaths, ...style }] }], { size: args.size, gap: 0, columns: 1 });
    const partFile = `${args.out}/${name}--${pathIndex}-${slug(path.cls, 'path')}.png`;
    writeFileSync(partFile, encodePng(single.rgba, single.width, single.height));
    drawn.push({ file: partFile, cls: path.cls });
  });

  /*
   * And the states a stateful icon actually has.
   *
   * The volume button is three different pictures - speaker with two waves, speaker with one, and
   * speaker with a mute cross - chosen by `data-level`. Drawing all its paths at once draws a
   * combination that is never on screen, so the states are rendered separately, with the paths the
   * stylesheet hides left out. The hiding rules are read from the stylesheet rather than restated.
   */
  if (/ctrl--volume/.test(icon.owner)) {
    for (const state of ['high', 'low', 'mute']) {
      const paths = shape
        .filter(({ path }) => visibleAt(css, path.cls, state))
        .map(({ subpaths, style }) => ({ subpaths, ...style }));
      const stateSheet = renderSheet([{ paths }], { size: args.size, gap: 0, columns: 1 });
      const stateFile = `${args.out}/${name}--state-${state}.png`;
      writeFileSync(stateFile, encodePng(stateSheet.rgba, stateSheet.width, stateSheet.height));
      drawn.push({ file: stateFile, cls: `data-level=${state}` });
      console.log(`    ${stateFile}  → ${paths.length} 条路径`);
    }
  }

  const problems = [];
  const parts = [];
  let union = null;
  for (const { path, subpaths, style } of shape) {
    const bounds = pathBounds(subpaths);
    const painted = rasterizeAlpha(styledSubpaths(subpaths, style), args.size);
    const coverage = [...painted].reduce((sum, value) => sum + value, 0) / (args.size * args.size);
    const label = path.cls || '(无类名)';
    parts.push(`${label} ${style.fill ? 'fill' : ''}${style.strokeWidth ? `stroke ${style.strokeWidth}` : ''} ${(coverage * 100).toFixed(1)}%`);

    if (!bounds) {
      problems.push(`${label} 没有点`);
      continue;
    }
    union = union
      ? {
          minX: Math.min(union.minX, bounds.minX),
          minY: Math.min(union.minY, bounds.minY),
          maxX: Math.max(union.maxX, bounds.maxX),
          maxY: Math.max(union.maxY, bounds.maxY),
        }
      : { ...bounds };

    // The viewBox is 24x24 and nothing scales it, so a glyph outside it is drawn cut off.
    if (bounds.minX < 0 || bounds.minY < 0 || bounds.maxX > 24 || bounds.maxY > 24) {
      problems.push(
        `${label} 超出 viewBox（${bounds.minX.toFixed(1)},${bounds.minY.toFixed(1)} → ${bounds.maxX.toFixed(1)},${bounds.maxY.toFixed(1)}）`,
      );
    }
    if (coverage < 0.002) problems.push(`${label} 画不出东西（覆盖 ${(coverage * 100).toFixed(2)}%）`);
    if (coverage > 0.7) problems.push(`${label} 几乎涂满（覆盖 ${(coverage * 100).toFixed(1)}%）`);
  }

  /*
   * The size rule is about the icon, not about each path in it.
   *
   * A numeral "1" is 4.9 units wide by design, and the mute cross is 6x6 - both are *parts* of a
   * larger glyph. Measuring them individually flags two icons that are perfectly fine, which is how
   * a check teaches people to ignore it.
   */
  if (union) {
    const width = union.maxX - union.minX;
    const height = union.maxY - union.minY;
    // An icon that occupies less than half its 24-unit box in both directions is drawn tiny.
    if (width < 12 && height < 12) problems.push(`整体太小（${width.toFixed(1)}x${height.toFixed(1)}）`);
    if (Math.max(width, height) < 8) problems.push(`整体过窄（${width.toFixed(1)}x${height.toFixed(1)}）`);
  }
  if (problems.length) failures++;

  console.log(`${problems.length ? '✗' : '✓'} ${file}`);
  console.log(`    ${parts.join(' | ')}`);
  if (union) {
    console.log(
      `    整体 ${(union.maxX - union.minX).toFixed(1)}x${(union.maxY - union.minY).toFixed(1)} @ ${union.minX.toFixed(1)},${union.minY.toFixed(1)}`,
    );
  }
  if (problems.length) console.log(`    ← ${problems.join('；')}`);
});

// The four mode glyphs must differ, or two modes look identical on the card.
const modeIcons = icons.filter((icon) => icon.cls.includes('mode-icon'));
if (modeIcons.length) {
  const distinct = new Set(modeIcons.map((icon) => icon.paths.map((path) => path.d).join('|')));
  console.log(`\n模式图标 ${modeIcons.length} 个，其中 ${distinct.size} 个互不相同`);
  if (distinct.size !== modeIcons.length) failures++;
}

console.log(`\n${failures ? `✗ ${failures} 个图标有问题` : '✓ 全部图标都能画出来'}`);
console.log('用 read_image 看这些文件：');
for (const item of drawn) console.log(`  ${item.file}`);
process.exit(failures ? 1 : 0);
