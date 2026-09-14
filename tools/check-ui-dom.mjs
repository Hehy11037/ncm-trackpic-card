#!/usr/bin/env node
// Cross-check that every DOM id the UI scripts use exists in index.html.
//
//   node tools/check-ui-dom.mjs
//
// This catches the classic zero-build failure: a renamed or mistyped element id
// that only surfaces as a null dereference in the browser - which is expensive to
// find without a browser available.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const HTML = join(ROOT, 'ui', 'index.html');
const SCRIPTS = [
  'ui/src/main.js',
  'ui/src/card.js',
  'ui/src/drag.js',
  'ui/src/layout.js',
  'ui/src/lyrics.js',
  'ui/src/socket.js',
  'ui/src/clock.js',
  'ui/src/palette.js',
];

const html = readFileSync(HTML, 'utf8');

// ids declared in the markup
const declared = new Set();
for (const match of html.matchAll(/\sid="([^"]+)"/g)) declared.add(match[1]);

// ids referenced from JS, in both getElementById('x') and $('x') forms
const referenced = new Map();
for (const file of SCRIPTS) {
  const source = readFileSync(join(ROOT, file), 'utf8');
  const patterns = [/getElementById\(\s*['"]([^'"]+)['"]\s*\)/g, /\$\(\s*['"]([^'"]+)['"]\s*\)/g];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      if (!referenced.has(match[1])) referenced.set(match[1], new Set());
      referenced.get(match[1]).add(file);
    }
  }
}

// CSS classes referenced from JS via querySelector / classList
const classRefs = new Set();
for (const file of SCRIPTS) {
  const source = readFileSync(join(ROOT, file), 'utf8');
  for (const match of source.matchAll(/\.([a-z][a-z0-9-]{2,})\b/gi)) classRefs.add(match[1]);
}

let failures = 0;

console.log(`index.html 声明了 ${declared.size} 个 id: ${[...declared].sort().join(', ')}\n`);

console.log('--- JS 引用的 id ---');
for (const [id, files] of [...referenced].sort()) {
  const ok = declared.has(id);
  if (!ok) failures++;
  console.log(`  ${ok ? 'ok   ' : 'FAIL '} #${id.padEnd(16)} (${[...files].join(', ')})`);
}

console.log('\n--- 未被引用的 id（可能是多余标记）---');
for (const id of [...declared].sort()) {
  if (!referenced.has(id)) console.log(`  note  #${id}`);
}

// Assets referenced by the HTML must exist.
console.log('\n--- index.html 引用的资源 ---');
for (const match of html.matchAll(/(?:href|src)="\.\/([^"]+)"/g)) {
  const relative = match[1];
  try {
    readFileSync(join(ROOT, 'ui', relative));
    console.log(`  ok    ${relative}`);
  } catch {
    failures++;
    console.log(`  FAIL  ${relative} 缺失`);
  }
}

console.log(`\n${failures ? `❌ ${failures} 项问题` : '✅ DOM 引用检查通过'}`);

console.log(`
--- 在浏览器里自检（可选）---
打开 http://127.0.0.1:8788/ 后按 F12，在 Console 粘贴：

(() => {
  const r = (el) => { if (!el) return null; const b = el.getBoundingClientRect();
    return { w: Math.round(b.width), h: Math.round(b.height), top: Math.round(b.top), left: Math.round(b.left) }; };
  const cs = getComputedStyle(document.documentElement);
  const px = (name) => cs.getPropertyValue(name).trim();
  return {
    视口: { w: innerWidth, h: innerHeight },
    单位: px('--u'),
    舞台: r(document.getElementById('stage')),
    封面: r(document.querySelector('.cover-wrap')),
    标题字号: getComputedStyle(document.getElementById('title')).fontSize,
    艺术家字号: getComputedStyle(document.getElementById('artist')).fontSize,
    色板数量: document.getElementById('palette')?.children.length ?? null,
    色板位置: r(document.getElementById('palette')),
    色板色值: [...(document.getElementById('palette')?.children ?? [])].map((s) => s.style.background),
    当前背景: document.getElementById('card').dataset.bg,
    对比度: document.documentElement.dataset.bgContrast,
  };
})()
`);

process.exit(failures ? 1 : 0);

