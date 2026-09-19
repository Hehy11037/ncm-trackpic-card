#!/usr/bin/env node
// What icon is inside a built executable?
//
//   node tools/exe-icon.mjs <file.exe> [--dump <out.png>]
//
// A thin CLI over `tools/lib/exe-icon.mjs`, which `check-package.mjs` also imports to assert that the
// shipped exe carries our icon. Useful on its own for "did the installer get the right icon?" without
// installing anything.

import { readFileSync, writeFileSync } from 'node:fs';

import { readExeIcon } from './lib/exe-icon.mjs';

const argv = process.argv.slice(2);
const file = argv[0];
const dumpAt = argv.indexOf('--dump');
const dump = dumpAt >= 0 ? argv[dumpAt + 1] : null;
if (!file) {
  console.error('usage: node tools/exe-icon.mjs <file.exe> [--dump <out.png>]');
  process.exit(1);
}

const icon = readExeIcon(readFileSync(file));
console.log(file);
console.log(`  PE: ${icon.is64 ? 'PE32+' : 'PE32'}`);
console.log(`  图标组 id=${icon.groupId}，${icon.sizes.length} 个尺寸: ${icon.sizes.join(' ')}`);
console.log(
  `  最大一帧 ${icon.largest.width}x${icon.largest.height} (${icon.largest.payload?.length ?? 0} 字节, ${icon.largest.png ? 'PNG' : 'DIB'})`,
);
if (icon.dominant.length) {
  console.log(`  不透明像素里最常见: ${icon.dominant.map((entry) => `${entry.colour}(${entry.count})`).join(' ')}`);
  console.log('  本项目的红是 #fd364e，图标里应当是它');
} else {
  console.log('  （非 PNG 帧：颜色需要解 DIB 才能判读，这里只报尺寸）');
}
if (dump && icon.largest.payload) {
  writeFileSync(dump, icon.largest.payload);
  console.log(`  已导出: ${dump}`);
}
