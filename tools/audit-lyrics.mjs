// Static audit of the lyrics rendering path.
//
//   node tools/audit-lyrics.mjs
//
// The lyrics page rendered nothing, and the centring formula checks out, so the cause is
// elsewhere: either a class that hides every line, or a computed value that resolves to
// nothing. This inspects the stylesheet and the view's own logic for those cases.

import { readFileSync } from 'node:fs';

const css = readFileSync('ui/styles/card.css', 'utf8');
const tokens = readFileSync('ui/styles/tokens.css', 'utf8');
const lyrics = readFileSync('ui/src/lyrics.js', 'utf8');

let failures = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failures++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `  ${detail}` : ''}`);
};

console.log('--- 会让歌词不可见的规则 ---');

check('.lyric-line 没有 display:none', !/\.lyric-line\s*\{[^}]*display:\s*none/.test(css));
check('.lyrics 没有 display:none', !/\.lyrics\s*\{[^}]*display:\s*none/.test(css));
check('.lyrics-stack 没有 visibility:hidden', !/\.lyrics-stack\s*\{[^}]*visibility:\s*hidden/.test(css));

// is-offscreen must exist and hide, and #setActive must clear it inside the window.
const offscreenRule = /\.lyric-line\.is-offscreen\s*\{([^}]*)\}/.exec(css);
check('.lyric-line.is-offscreen 规则存在', !!offscreenRule, offscreenRule ? offscreenRule[1].trim() : 'missing');
check('  它确实是隐藏', !!offscreenRule && /visibility:\s*hidden/.test(offscreenRule[1]));

console.log('\n--- JS 是否会把所有行都标成 offscreen ---');
check('#setActive 里会移除 is-offscreen', /classList\.toggle\(\s*'is-offscreen'/.test(lyrics));
check('#setActive 在初始 rAF 里被调用', /requestAnimationFrame[\s\S]{0,200}#setActive/.test(lyrics));

// The visibility test must be based on magnitude, not on the signed distance.
const toggle = /classList\.toggle\(\s*'is-offscreen',\s*([^)]+)\)/.exec(lyrics);
check(
  'is-offscreen 用的是绝对值',
  !!toggle && /Math\.abs/.test(toggle[1]),
  toggle ? toggle[1].trim() : 'not found',
);

console.log('\n--- --d 的计算 ---');
const setD = /setProperty\(\s*'--d',\s*([\s\S]{0,80}?)\);/.exec(lyrics);
check('设置了 --d', !!setD, setD ? setD[1].replace(/\s+/g, ' ').trim() : 'not found');
if (setD) {
  // A unitless number is required: `calc(1 - 0.5px)` is invalid and would discard the
  // whole declaration, leaving lines unstyled.
  check('  --d 格式化为无单位数字', /toFixed\(2\)/.test(setD[1]), setD[1].trim());
  check('  --d 不会为负', /Math\.max\(0/.test(setD[1]), setD[1].trim());
}
check('当前行深度为 0', /i === index\)\s*depth = 0/.test(lyrics.replace(/\s+/g, ' ')) || /depth = 0;/.test(lyrics));

// The CSS consumers of --d must be valid expressions.
console.log('\n--- CSS 里 --d 的用法 ---');
for (const [, prop, value] of css.matchAll(/(opacity|filter|transform):\s*([^;]*var\(--d\)[^;]*)/g)) {
  const looksValid = /calc\(/.test(value);
  check(`${prop} 使用了 calc`, looksValid, value.trim().slice(0, 70));
}

console.log('\n--- 关键尺寸变量 ---');
for (const name of ['--u', '--card-height', '--fs-lyric', '--fs-lyric-sub']) {
  const m = new RegExp(`${name}\\s*:\\s*([^;}]+)`).exec(tokens);
  console.log(`  ${name.padEnd(16)} = ${m ? m[1].trim() : '(缺失)'}`);
}
check('--u 有非零回退值', /--u:\s*[0-9.]+px/.test(tokens));
check('--card-height 有回退值', /--card-height:\s*[0-9.]+px/.test(tokens));

console.log(`\n${failures ? `❌ ${failures} 项可疑` : '✅ 歌词渲染路径未发现明显问题'}`);
process.exit(failures ? 1 : 0);
