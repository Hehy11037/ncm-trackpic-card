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
process.exit(failures ? 1 : 0);
