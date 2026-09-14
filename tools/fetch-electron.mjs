// Download the Electron binary straight from GitHub releases into
// node_modules/electron/dist, bypassing @electron/get's hardcoded cache path.
//
//   node tools/fetch-electron.mjs
//
// Why this exists: @electron/get resolves its cache through env-paths, which on
// Windows means %LOCALAPPDATA%\electron - a path this project's tooling shell
// cannot create (see NOTES.md). ELECTRON_CACHE is not honoured by that code path.
// Downloading the official zip ourselves keeps everything inside the workspace.

import { spawnSync } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { join } from 'node:path';

const ROOT = process.cwd();
const ELECTRON_DIR = join(ROOT, 'node_modules', 'electron');
const DIST_DIR = join(ELECTRON_DIR, 'dist');
const CACHE_DIR = join(ROOT, '.scratch', 'electron-cache');
const ZIP_PATH = join(CACHE_DIR, 'electron.zip');

function log(message) {
  console.log(`[fetch-electron] ${message}`);
}

function electronVersion() {
  const pkg = JSON.parse(readFileSync(join(ELECTRON_DIR, 'package.json'), 'utf8'));
  return pkg.version;
}

async function download(url, dest) {
  log(`downloading ${url}`);
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok || !res.body) {
    throw new Error(`download failed: HTTP ${res.status}`);
  }
  const total = Number(res.headers.get('content-length') ?? 0);
  let seen = 0;
  let lastLogged = 0;

  const body = Readable.fromWeb(res.body);
  body.on('data', (chunk) => {
    seen += chunk.length;
    const pct = total ? Math.floor((seen / total) * 100) : 0;
    if (pct >= lastLogged + 10) {
      lastLogged = pct;
      log(`  ${pct}%  (${(seen / 1024 / 1024).toFixed(1)} MB${total ? ` / ${(total / 1024 / 1024).toFixed(1)} MB` : ''})`);
    }
  });

  mkdirSync(join(dest, '..'), { recursive: true });
  await pipeline(body, createWriteStream(dest));
  log(`  saved ${(seen / 1024 / 1024).toFixed(1)} MB -> ${dest}`);
  return seen;
}

function unzip(zip, target) {
  // tar.exe ships with Windows 10+ and reads zip archives.
  const res = spawnSync('tar', ['-xf', zip, '-C', target], {
    stdio: 'ignore',
    windowsHide: true,
  });
  if (res.error) throw new Error(`tar failed to start: ${res.error.message}`);
  if (res.status !== 0) throw new Error(`tar exited with ${res.status}`);
}

const version = electronVersion();
log(`electron package version: ${version}`);

if (existsSync(join(DIST_DIR, 'electron.exe'))) {
  log('binary already present, nothing to do');
  process.exit(0);
}

const url = `https://github.com/electron/electron/releases/download/v${version}/electron-v${version}-win32-x64.zip`;
log(`target: ${DIST_DIR}`);

mkdirSync(CACHE_DIR, { recursive: true });

try {
  if (!existsSync(ZIP_PATH)) {
    await download(url, ZIP_PATH);
  } else {
    log(`using cached zip at ${ZIP_PATH}`);
  }

  rmSync(DIST_DIR, { recursive: true, force: true });
  mkdirSync(DIST_DIR, { recursive: true });
  log('extracting…');
  unzip(ZIP_PATH, DIST_DIR);

  if (!existsSync(join(DIST_DIR, 'electron.exe'))) {
    throw new Error('extraction finished but electron.exe is missing');
  }

  // electron's index.js reads path.txt to locate the executable.
  writeFileSync(join(ELECTRON_DIR, 'path.txt'), 'electron.exe', 'utf8');

  const size = existsSync(DIST_DIR) ? 'ok' : 'missing';
  log(`done: ${size}`);
  log('verify with: npx electron --version');
} catch (err) {
  log(`FAILED: ${err instanceof Error ? err.message : String(err)}`);
  log('The overlay UI can still be opened in a browser against the host; only the');
  log('desktop shell needs this binary.');
  process.exitCode = 1;
}
