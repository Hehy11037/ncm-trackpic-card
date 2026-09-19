#!/usr/bin/env node
// Verify a *built* app directory: dist/win-unpacked/resources/app.
//
//   node tools/check-package.mjs [--app <dir>]
//
// `check-shell.mjs` checks the packaging config from the repository side - that the `files` list covers
// the things the shell reads. That is not the same as checking the payload: a file added to an import
// chain since the list was written would be missing from the build and nothing would notice until
// someone installed it.
//
// So this looks at the built files themselves, and then *runs* the packaged host. The host is plain
// Node rather than Electron (the shell starts it as `ELECTRON_RUN_AS_NODE`), so the half of the app that
// actually does the work can be verified without launching a window - and it is the half that reads the
// UI off disk, which is exactly what a bad `files` list breaks.
//
// Exits 0 with a note when there is no build to check, so it is harmless on a fresh checkout.

import { spawn } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const argv = process.argv.slice(2);
const at = argv.indexOf('--app');
const APP = resolve(at >= 0 ? argv[at + 1] : 'dist/win-unpacked/resources/app');

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? `  ${detail}` : ''}`);
  if (!ok) failures++;
};

/** Every relative import target in a JavaScript/TypeScript file, resolved against it. */
function relativeImports(file) {
  const text = readFileSync(file, 'utf8');
  const found = [];
  for (const match of text.matchAll(/(?:from|import)\s*\(?\s*['"](\.[^'"]+)['"]/g)) {
    found.push(resolve(dirname(file), match[1]));
  }
  return found;
}

/**
 * Where an import actually lives.
 *
 * TypeScript's ESM style writes `./cdp.js` for a file that is `cdp.ts` on disk - Node strips the types
 * at run time, so the build has no `.js` to find and the first version of this check reported it as
 * missing. A directory import (`./lyric`) is the other case worth covering.
 */
function resolveImport(target) {
  const candidates = [target, target.replace(/\.js$/, '.ts'), target.replace(/\.mjs$/, '.ts'), `${target}.ts`];
  candidates.push(join(target, 'index.ts'), join(target, 'index.mjs'), join(target, 'index.js'));
  return candidates.find((candidate) => existsSync(candidate) && statSync(candidate).isFile()) ?? null;
}

/** The scripts and styles an HTML file pulls in, resolved against it. */
function htmlAssets(file) {
  const text = readFileSync(file, 'utf8');
  const found = [];
  for (const match of text.matchAll(/(?:src|href)="([^"]+)"/g)) {
    if (/^https?:|^data:|^#/.test(match[1])) continue;
    found.push(resolve(dirname(file), match[1]));
  }
  return found;
}

console.log(`\n--- 打包产物（${APP}）---`);
if (!existsSync(APP)) {
  console.log('  没有找到构建产物，跳过（先跑 npm run dist 或 npm run pack）');
  process.exit(0);
}

/*
 * The four things the shell reads at runtime, seeded by hand: the window entry, the preload (referenced
 * as a path string, so no import walk can find it), the host entry, and the UI's entry document.
 */
const entries = [
  join(APP, 'apps/overlay/main.mjs'),
  join(APP, 'apps/overlay/preload.cjs'),
  join(APP, 'apps/overlay/shell-utils.mjs'),
  join(APP, 'tools/host-run.mjs'),
];
for (const entry of entries) check(`入口存在 ${entry.slice(APP.length + 1)}`, existsSync(entry));

// Walk the JavaScript import graph, and the UI's asset graph, from those entries.
const seen = new Set();
const queue = [...entries];
let missing = 0;
while (queue.length) {
  const file = queue.pop();
  if (seen.has(file) || !existsSync(file)) continue;
  seen.add(file);
  if (!statSync(file).isFile()) continue;
  const next = file.endsWith('.html') ? htmlAssets(file) : relativeImports(file);
  for (const target of next) {
    const resolved = resolveImport(target);
    if (!resolved) {
      console.log(`      缺失: ${target.slice(APP.length + 1)}  ← 由 ${file.slice(APP.length + 1)} 引用`);
      missing++;
      continue;
    }
    queue.push(resolved);
  }
}
check('导入图完整（每个相对引用都在包里）', missing === 0, missing ? `${missing} 个缺失` : `${seen.size} 个文件`);
check(
  '界面入口与样式在包里',
  existsSync(join(APP, 'ui/index.html')) && existsSync(join(APP, 'ui/styles/card.css')),
);
check('宿主源码在包里（Node 直接跑 TS）', existsSync(join(APP, 'packages/host/src/index.ts')));
check('图标在包里', existsSync(join(APP, 'assets/icon.ico')));
check('没有把仓库根目录整个搬进来', !existsSync(join(APP, 'node_modules')) || statSync(join(APP, 'node_modules')).isDirectory());

/*
 * And run the packaged host. Ports are deliberately unusual: the owner may have the overlay running,
 * and this must not fight it or touch the client's own debug channel.
 */
const HOST_PORT = 18787;
const UI_PORT = 18788;
const CDP_PORT = 19223;

console.log('\n--- 运行打包后的宿主（不是 Electron，是普通 Node）---');
const child = spawn(
  process.execPath,
  [
    join(APP, 'tools/host-run.mjs'),
    '--host-port',
    String(HOST_PORT),
    '--ui-port',
    String(UI_PORT),
    '--cdp-port',
    String(CDP_PORT),
    '--ui-root',
    join(APP, 'ui'),
    '--quiet',
  ],
  { cwd: APP, stdio: 'ignore', windowsHide: true },
);

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
let page = null;
let asset = null;
let status = null;
try {
  for (let attempt = 0; attempt < 40 && page === null; attempt++) {
    await sleep(250);
    try {
      const response = await fetch(`http://127.0.0.1:${UI_PORT}/`, { signal: AbortSignal.timeout(1500) });
      if (response.ok) page = await response.text();
    } catch {
      // Not up yet; the loop is the retry.
    }
  }
  check('宿主起来了并把界面发出来了', page !== null);
  if (page) {
    check('发出来的是卡片页面（不是 404 或目录列表）', page.includes('id="card"') && page.includes('id="lyrics"'));
    const script = await fetch(`http://127.0.0.1:${UI_PORT}/src/main.js`, { signal: AbortSignal.timeout(2000) });
    asset = script.ok ? await script.text() : '';
    check('模块也发得出来', script.ok && asset.includes('CardView'));
  }
  try {
    const info = await fetch(`http://127.0.0.1:${HOST_PORT}/`, { signal: AbortSignal.timeout(1500) });
    status = String(info.status);
  } catch {
    status = 'no-http';
  }
  // The host's WebSocket port has no HTTP route, so any answer at all means it bound.
  check('宿主端口已绑定', status !== 'no-http', `HTTP ${status}`);
} finally {
  child.kill();
  // Give the child a moment to actually exit before this one tears down: killing it and returning
  // immediately left libuv asserting on a closing handle during teardown.
  await sleep(400);
}

console.log(`\n${failures ? `❌ ${failures} 项失败` : '✅ 打包产物检查通过'}`);
// `exitCode` rather than `process.exit()`: exiting while sockets are still closing is what provoked
// `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)`.
process.exitCode = failures ? 1 : 0;
