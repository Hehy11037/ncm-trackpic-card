// Verify the Electron shell's pure helpers without launching Electron.
//
//   node tools/check-shell.mjs
//
// Two things are easy to get silently wrong and invisible in a screenshot:
//   - the PNG encoder for the tray icon (a bad CRC or header yields an empty tray icon)
//   - the window geometry maths (wrong aspect leaves transparent bars around the card)
//
// So this writes the generated icon to disk for visual inspection and checks the geometry
// against the card's real aspect ratio, taken from the stylesheet rather than duplicated here.

import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  CARD_ASPECT,
  DEFAULT_WIDTH,
  MAX_WIDTH,
  MIN_WIDTH,
  heightForWidth,
  loadWindowState,
  makeIconPng,
  saveWindowState,
  stateFilePath,
} from '../apps/overlay/shell-utils.mjs';

let failures = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failures++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `  ${detail}` : ''}`);
};

/* ------------------------------------------------------------------ geometry */

console.log('--- 窗口几何 ---');
{
  // The aspect ratio must match the stage in the stylesheet, or the window shows transparent
  // bands and the card does not fill it.
  const tokens = readFileSync('ui/styles/tokens.css', 'utf8');
  const stageRule = /\.stage\s*\{([^}]*)\}/.exec(tokens);
  const widthExpr = /width:\s*([^;]+)/.exec(stageRule?.[1] ?? '')?.[1] ?? '';
  // `max(380px, min(94vw, calc(94vh * 100 / 181.36)))` -> read the 181.36.
  const ratioMatch = /(\d+(?:\.\d+)?)\s*\)\s*\)/.exec(widthExpr) ?? /\/\s*(\d+(?:\.\d+)?)/.exec(widthExpr);
  const stylesheetAspect = ratioMatch ? Number(ratioMatch[1]) / 100 : null;
  console.log(`    样式表里的舞台比例: 1 : ${stylesheetAspect ?? '?'}`);
  console.log(`    壳里的 CARD_ASPECT  : 1 : ${CARD_ASPECT}`);
  check(
    '窗口比例与样式表一致',
    stylesheetAspect !== null && Math.abs(stylesheetAspect - CARD_ASPECT) < 0.001,
    `${stylesheetAspect} vs ${CARD_ASPECT}`,
  );

  const workArea = { x: 0, y: 0, width: 1920, height: 1040 };
  for (const width of [MIN_WIDTH, DEFAULT_WIDTH, 400, MAX_WIDTH]) {
    const height = heightForWidth(width, workArea);
    const ratio = height / width;
    check(
      `宽 ${width} -> 高 ${height}`,
      Math.abs(ratio - CARD_ASPECT) < 0.01 || height >= workArea.height * 0.95,
      `比例 1 : ${ratio.toFixed(3)}`,
    );
  }

  // A very short screen must clamp rather than overflow.
  const short = heightForWidth(MAX_WIDTH, { x: 0, y: 0, width: 1920, height: 500 });
  check('矮屏幕下高度被限制', short <= 500 * 0.96 + 1, `高 ${short}`);
}

/* ------------------------------------------------------------------ state file */

console.log('\n--- 窗口位置持久化 ---');
{
  const dir = join(process.cwd(), '.scratch', 'shell-state');
  mkdirSync(dir, { recursive: true });
  const file = stateFilePath(dir);
  const bounds = [{ x: 0, y: 0, width: 1920, height: 1080 }];

  saveWindowState(file, { width: 400, x: 120, y: 240 });
  const restored = loadWindowState(file, bounds);
  check('保存后可读回', restored.width === 400 && restored.x === 120 && restored.y === 240, JSON.stringify(restored));

  // A position from an unplugged monitor must be dropped, not restored off screen.
  saveWindowState(file, { width: 400, x: 9000, y: 9000 });
  const offscreen = loadWindowState(file, bounds);
  check('屏幕外的位置被丢弃', offscreen.x === undefined && offscreen.y === undefined, JSON.stringify(offscreen));

  // Width must be clamped into the allowed range.
  saveWindowState(file, { width: 5000, x: 10, y: 10 });
  check('过大的宽度被限制', loadWindowState(file, bounds).width === MAX_WIDTH);

  // A missing or corrupt file must fall back to a default rather than throwing.
  const missing = loadWindowState(join(dir, 'nope.json'), bounds);
  check('文件缺失时用默认值', missing.width === DEFAULT_WIDTH, JSON.stringify(missing));
  writeFileSync(file, '{ not json', 'utf8');
  check('文件损坏时不抛异常', loadWindowState(file, bounds).width === DEFAULT_WIDTH);
}

/* -------------------------------------------------------------------- icon PNG */

console.log('\n--- 托盘图标 PNG ---');
{
  const png = makeIconPng({ r: 0x98, g: 0xb6, b: 0xbe }, 32);
  check('产出非空字节', png.length > 100, `${png.length} 字节`);
  check('PNG 签名正确', png.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])));

  const ihdr = png.indexOf('IHDR');
  check('IHDR 存在且在签名之后', ihdr === 12, `offset ${ihdr}`);
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  check('尺寸写入为 32x32', width === 32 && height === 32, `${width}x${height}`);
  check('颜色类型为 RGBA', png[25] === 6, `type ${png[25]}`);
  check('包含 IDAT 与 IEND', png.includes('IDAT') && png.includes('IEND'));

  // Every chunk's CRC must verify, or decoders reject the image.
  let offset = 8;
  let chunks = 0;
  let crcOk = true;
  while (offset + 12 <= png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.subarray(offset + 4, offset + 8).toString('ascii');
    const stored = png.readUInt32BE(offset + 8 + length);
    const body = png.subarray(offset + 4, offset + 8 + length);
    let c = 0xffffffff;
    for (const byte of body) {
      c ^= byte;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    if ((c ^ 0xffffffff) >>> 0 !== stored >>> 0) crcOk = false;
    chunks++;
    offset += 12 + length;
    if (type === 'IEND') break;
  }
  check('所有 chunk 的 CRC 正确', crcOk, `共 ${chunks} 个 chunk`);

  const out = join(process.cwd(), '.scratch', 'tray-icon.png');
  writeFileSync(out, png);
  console.log(`    已写出用于人工查看: ${out}`);
}

console.log(`\n${failures ? `❌ ${failures} 项失败` : '✅ 桌面壳辅助逻辑通过'}`);
process.exit(failures ? 1 : 0);
