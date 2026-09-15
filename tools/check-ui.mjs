#!/usr/bin/env node
// Verify that the host serves the overlay UI correctly.
//
//   node tools/check-ui.mjs [--ui-port 8788] [--host-port 8787]
//
// Checks the pieces that can be checked headlessly: the config endpoint, every
// file the UI loads, their content types, and that path traversal is refused. The
// visual result still needs a browser, but a broken asset path shows up here.
//
// It starts its own host if one is not already answering. It used to depend on a host being
// started by hand, which made `npm run check` pass or fail according to what happened to be
// running on the machine - it was green for a while only because a leftover host from an earlier
// session was still alive, and then went red with seventeen "fetch failed" lines for no reason
// anybody could see in the code.

import { spawn } from 'node:child_process';
import { closeSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
let uiPort = 8788;
let hostPort = 8787;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--ui-port') uiPort = Number(args[++i]);
  else if (args[i] === '--host-port') hostPort = Number(args[++i]);
}

const base = `http://127.0.0.1:${uiPort}`;
const ROOT = process.cwd();
/** The host we started, if any. Never kills a host that was already running. */
let ownedHost = null;

/**
 * What the page loads, derived rather than listed.
 *
 * This used to be a hand-written array of paths, and it silently stopped covering the project the
 * moment a module was added: `ui/src/scrub.js` was served, imported, and needed to boot, and this
 * check had never heard of it. A list that has to be remembered is a list that will be out of date -
 * the same lesson as the bridge's hand-written version number.
 *
 * So the assets come from the page itself (its `link` and `script` tags, then each module's own
 * `import` specifiers, transitively), and the expected content type comes from the extension.
 */

/**
 * Resolve a relative specifier (`./src/main.js`) against the serving root.
 *
 * The page and the modules both use `./`-relative paths, which is what a build step would normally
 * rewrite; there is no build step here, so they are resolved the way the browser would and turned
 * into the absolute path the server is asked for.
 */
function resolveSpecifier(fromPath, specifier) {
  if (specifier.startsWith('/')) return specifier;
  if (specifier.startsWith('http') || specifier.startsWith('//') || specifier.startsWith('data:')) return null;
  // Strip the leading slash first: splitting `/src/main.js` leaves an empty first segment, which
  // then reappears in the joined path as `//src/...`.
  const parts = fromPath.replace(/^\/+/, '').split('/').slice(0, -1).filter(Boolean);
  for (const segment of specifier.split('/')) {
    if (segment === '.' || segment === '') continue;
    if (segment === '..') parts.pop();
    else parts.push(segment);
  }
  return `/${parts.join('/')}`;
}

/** Every path the page loads, starting from index.html and following the module graph. */
async function assetPaths() {
  const paths = new Set(['/', '/config.json']);
  const html = readFileSync(join(ROOT, 'ui', 'index.html'), 'utf8');
  const queue = [];

  for (const match of html.matchAll(/(?:href|src)="([^"]+)"/g)) {
    const resolved = resolveSpecifier('/', match[1]);
    if (!resolved) continue;
    paths.add(resolved);
    if (resolved.endsWith('.js')) queue.push(resolved);
  }

  const bare = [];
  const visited = new Set();
  while (queue.length) {
    const path = queue.shift();
    if (visited.has(path)) continue;
    visited.add(path);
    let body;
    try {
      const res = await fetch(base + path);
      if (!res.ok) continue;
      body = await res.text();
    } catch {
      continue;
    }
    for (const match of body.matchAll(/(?:from|import)\s*\(?\s*'([^']+)'/g)) {
      const target = resolveSpecifier(path, match[1]);
      if (!target) {
        bare.push(`${path} → ${match[1]}`);
        continue;
      }
      paths.add(target);
      if (target.endsWith('.js')) queue.push(target);
    }
  }
  return { paths: [...paths], bare };
}

/** The content type the extension implies. */
function expectedType(path) {
  if (path === '/' ) return 'text/html';
  if (path.endsWith('.css')) return 'text/css';
  if (path.endsWith('.js')) return 'text/javascript';
  if (path.endsWith('.json')) return 'application/json';
  return null;
}

let failures = 0;

async function uiAnswers() {
  try {
    const res = await fetch(`${base}/config.json`, { cache: 'no-store' });
    return res.ok;
  } catch {
    return false;
  }
}

/** Use the running host, or start one. Returns false when neither worked. */
async function ensureHost() {
  if (await uiAnswers()) {
    console.log(`检查界面服务 ${base}（沿用已在运行的宿主）\n`);
    return true;
  }

  const logDir = join(ROOT, '.scratch');
  mkdirSync(logDir, { recursive: true });
  const logPath = join(logDir, 'check-ui-host.log');
  const fd = openSync(logPath, 'w');
  console.log(`检查界面服务 ${base}（本地没有宿主，自动启动一个）`);

  ownedHost = spawn(process.execPath, [join(ROOT, 'tools', 'host-run.mjs'), '--quiet'], {
    cwd: ROOT,
    // A file descriptor rather than a pipe: the sandbox refuses piped stdio, and the log makes a
    // failed start diagnosable instead of silent.
    stdio: ['ignore', fd, fd],
    windowsHide: true,
    env: {
      ...process.env,
      // Keep the caches inside the workspace; the default location is not writable here, and a
      // cold discovery scan would eat the whole timeout.
      OVERLAY_CACHE_DIR: logDir,
    },
  });
  closeSync(fd);

  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (await uiAnswers()) {
      console.log(`  宿主已就绪（日志 ${logPath}）\n`);
      return true;
    }
    if (ownedHost.exitCode !== null) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  console.log(`  宿主没能在 30 秒内就绪，日志见 ${logPath}\n`);
  return false;
}

const started = await ensureHost();

const { paths: assets, bare } = started ? await assetPaths() : { paths: [], bare: [] };
console.log(`\n--- 页面与模块图（${assets.length} 个资源，从 index.html 顺着 import 走出来的） ---`);
// A walk that finds nothing would pass every check below while covering nothing at all.
if (started && assets.length < 8) {
  failures++;
  console.log(`  FAIL  只找到 ${assets.length} 个资源，模块图没有被走出来`);
}
for (const path of assets.sort()) {
  const wanted = expectedType(path);
  try {
    const res = await fetch(base + path);
    const contentType = (res.headers.get('content-type') ?? '').split(';')[0];
    const body = await res.text();
    const ok = res.ok && body.length > 0 && (wanted === null || contentType === wanted);
    if (!ok) failures++;
    console.log(
      `  ${ok ? 'ok  ' : 'FAIL'} ${path.padEnd(26)} ${res.status}  ${contentType}  ${body.length}B` +
        (wanted !== null && contentType !== wanted ? `  ← 期望 ${wanted}` : ''),
    );
  } catch (err) {
    failures++;
    console.log(`  FAIL  ${path.padEnd(26)} ${err.message}`);
  }
}
// The UI is served with no bundler and no import map, so a bare specifier cannot resolve.
if (bare.length) {
  failures++;
  console.log(`  FAIL  有 bare import（无构建步骤，浏览器解析不了）: ${bare.join(', ')}`);
} else {
  console.log('  ok   没有 bare import');
}

console.log('\n--- config.json content ---');
try {
  const res = await fetch(`${base}/config.json`);
  const config = await res.json();
  console.log(JSON.stringify(config, null, 2));
  if (config.hostPort !== hostPort) {
    console.log(`  note: config hostPort=${config.hostPort}, expected ${hostPort} (pass --host-port to match)`);
  }
} catch (err) {
  failures++;
  console.log(`  FAIL: ${err.message}`);
}

console.log('\n--- path traversal must be refused ---');
for (const probe of ['/../package.json', '/..%2fpackage.json', '/src/../../package.json']) {
  try {
    const res = await fetch(base + probe);
    const refused = res.status === 403 || res.status === 404;
    console.log(`  ${refused ? 'ok   ' : 'FAIL '} ${probe.padEnd(28)} -> ${res.status}`);
    if (!refused) failures++;
  } catch (err) {
    console.log(`  FAIL  ${probe.padEnd(28)} ${err.message}`);
    failures++;
  }
}

console.log('\n--- WebSocket reachable? ---');
try {
  const ws = new WebSocket(`ws://127.0.0.1:${hostPort}`);
  const outcome = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve('timeout'), 4000);
    ws.addEventListener('open', () => {
      clearTimeout(timer);
      resolve('open');
    });
    ws.addEventListener('error', () => {
      clearTimeout(timer);
      resolve('error');
    });
  });
  console.log(`  ${outcome === 'open' ? 'ok   ' : 'FAIL '} ws://127.0.0.1:${hostPort} -> ${outcome}`);
  if (outcome !== 'open') failures++;

  /*
   * Close and let the socket finish its closing handshake before exiting.
   *
   * Exiting while the handle is still closing trips a libuv assertion on Windows
   * (`!(handle->flags & UV_HANDLE_CLOSING)` in win/async.c), which turns this script's exit code
   * into 1 even when every check passed - so `npm run check`'s && chain broke at the first step.
   */
  await new Promise((resolve) => {
    const done = () => resolve();
    ws.addEventListener('close', done);
    ws.addEventListener('error', done);
    ws.close();
    setTimeout(done, 1000);
  });
} catch (err) {
  console.log(`  FAIL  ${err.message}`);
  failures++;
}

if (!started) {
  console.log('  FAIL  没有可用的界面服务，后面的检查无法进行');
  failures++;
}

/** Stop the host we started; leave an already-running one alone. */
if (ownedHost) {
  ownedHost.kill();
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, 2000);
    ownedHost.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

console.log(`\n${failures ? `❌ ${failures} 项失败` : '✅ 界面服务检查通过'}`);
process.exitCode = failures ? 1 : 0;
