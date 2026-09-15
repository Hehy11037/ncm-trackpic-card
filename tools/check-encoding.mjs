// Verify that every source file is intact UTF-8.
//
//   node tools/check-encoding.mjs
//
// This exists because it happened: `Get-Content -Raw` piped into `Set-Content` round-trips a file
// through the console's ANSI code page, and it silently destroyed every Chinese string literal in
// `apps/overlay/main.mjs`. The damage does not announce itself - the file still parses far enough
// to look plausible in a diff - and half this project's user-facing text is Chinese.
//
// Three shapes of damage are checked for:
//   * U+FFFD, the replacement character, which decoders emit for bytes they could not decode;
//   * a UTF-8 byte order mark, which `Set-Content -Encoding UTF8` adds and which breaks byte-level
//     checks and makes a file differ from a hand-written one for no reason;
//   * the byte pattern of UTF-8 text that was read as a single-byte code page and written back as
//     UTF-8 - two Latin-1 characters where one CJK character used to be.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = process.cwd();
/** Build output, dependencies and scratch files are not source. */
const SKIP_DIRS = new Set(['node_modules', '.git', '.scratch', 'dist', 'out', 'build']);
const EXTENSIONS = /\.(mjs|cjs|js|jsx|ts|tsx|css|html|json|md|ps1|yml|yaml)$/;

/** Two Latin-1 code points in a row: what one mis-decoded multi-byte character leaves behind. */
const DOUBLE_LATIN1 = /[\u00c2-\u00ef][\u0080-\u00bf]/;
/*
 * Lead characters of the commonest Windows-code-page renderings of Chinese punctuation - written
 * as escapes rather than literally, so that this file does not trip its own check.
 */
const GBK_MOJIBAKE = new RegExp(
  [0x9225, 0x951b, 0x9428, 0x935c, 0x6d93, 0x93c4, 0x9286, 0x951f]
    .map((code) => `\\u${code.toString(16)}`)
    .join('|'),
);

function collect(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    const info = statSync(full);
    if (info.isDirectory()) collect(full, out);
    else if (EXTENSIONS.test(entry)) out.push(full);
  }
  return out;
}

let failures = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failures++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `  ${detail}` : ''}`);
};

const files = collect(ROOT).sort();
console.log(`检查 ${files.length} 个源文件的编码\n`);

const damaged = [];
const withBom = [];
for (const file of files) {
  const bytes = readFileSync(file);
  const text = bytes.toString('utf8');
  const relativePath = relative(ROOT, file);

  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) withBom.push(relativePath);

  const marks = [];
  if (text.includes('\uFFFD')) marks.push('U+FFFD');
  if (DOUBLE_LATIN1.test(text)) marks.push('latin1 乱码');
  if (GBK_MOJIBAKE.test(text)) marks.push('GBK 乱码');
  if (marks.length) damaged.push(`${relativePath} (${marks.join(', ')})`);
}

check('没有文件被乱码破坏', damaged.length === 0, damaged.slice(0, 8).join('; '));
check('没有文件带 UTF-8 BOM', withBom.length === 0, withBom.slice(0, 8).join('; '));

// Chinese text is genuinely present, so the checks above cannot pass by there being none.
const chineseFiles = files.filter((file) => /[\u4e00-\u9fff]/.test(readFileSync(file, 'utf8')));
check('确实存在包含中文的源文件', chineseFiles.length >= 10, `${chineseFiles.length} 个文件含中文`);

/*
 * Every PowerShell script must be ASCII-only.
 *
 * Windows PowerShell 5.1 reads a `.ps1` as ANSI unless it carries a UTF-8 BOM, so a non-ASCII
 * literal in one is silently corrupted at parse time - the script still runs, with the wrong text,
 * or fails somewhere unrelated. Both scripts in this repository say so in their own headers; this
 * makes it a check rather than a comment.
 *
 * The fix for any violation is to keep the script ASCII and put the localised text in the
 * TypeScript that calls it, which is what the two existing scripts do.
 */
const scripts = files.filter((file) => file.endsWith('.ps1'));
const nonAscii = scripts.filter((file) => {
  const bytes = readFileSync(file);
  return bytes.some((byte) => byte > 0x7f);
});
check(
  'PowerShell 脚本只含 ASCII',
  nonAscii.length === 0,
  nonAscii.map((file) => relative(ROOT, file)).join('; '),
);
console.log(`    （检查了 ${scripts.length} 个 .ps1）`);

console.log(`\n${failures ? `❌ ${failures} 项失败` : '✅ 编码检查通过'}`);
process.exit(failures ? 1 : 0);
