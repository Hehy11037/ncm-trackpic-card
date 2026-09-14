// Render the overlay UI offscreen and save PNG screenshots.
//
//   npx electron tools/shot.mjs [--out .scratch/shots] [--face both] [--scale 2]
//
// Why this exists: the UI is the deliverable, and "it compiled" says nothing about
// whether it looks right. This loads the same page the desktop shell will load,
// waits for real data from the host, and writes a picture that can be reviewed.
//
// It also doubles as the earliest smoke test for the Electron shell, since it uses
// the same window options (transparent, frameless).

import { app, BrowserWindow } from 'electron';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const getArg = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const outDir = join(process.cwd(), getArg('out', '.scratch/shots'));
const face = getArg('face', 'both');
const scale = Number(getArg('scale', '2'));
const uiUrl = getArg('url', 'http://127.0.0.1:8788/');
// 9:16 portrait, matching the reference composition. The CSS scales off height, so
// this window size is also what makes the preview representative.
const width = Number(getArg('width', '360'));
const height = Number(getArg('height', '640'));

mkdirSync(outDir, { recursive: true });

// Electron would normally keep its profile under %APPDATA%, which this shell
// cannot write. Point every cache/profile location at the workspace instead.
const profileDir = join(process.cwd(), '.scratch', 'electron-profile');
mkdirSync(profileDir, { recursive: true });
app.setPath('userData', profileDir);
app.setPath('sessionData', profileDir);
app.setPath('cache', join(profileDir, 'Cache'));
app.setPath('crashDumps', join(profileDir, 'Crashpad'));
app.commandLine.appendSwitch('disk-cache-dir', join(profileDir, 'Cache'));

app.commandLine.appendSwitch('force-color-profile', 'srgb');
// The window is transparent, so the page must render with an alpha channel.
app.disableHardwareAcceleration();

// Chromium's Mojo platform channel uses a named pipe, which a confined shell
// cannot create (measured: FATAL:platform_channel.cc(85) Access is denied - the
// same failure that kills the NetEase client when started from such a shell).
// Single-process mode removes the cross-process channel entirely, which lets this
// diagnostic still run where a normal launch is impossible.
app.commandLine.appendSwitch('single-process');
app.commandLine.appendSwitch('disable-features', 'MojoIpcz,NetworkService');
app.commandLine.appendSwitch('no-zygote');

async function settle(window, ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
  return window;
}

app.whenReady().then(async () => {
  const window = new BrowserWindow({
    width,
    height,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      offscreen: false,
    },
  });

  window.webContents.setZoomFactor(scale);

  try {
    await window.loadURL(uiUrl);
  } catch (err) {
    console.error(`loadURL failed: ${err.message}`);
    app.exit(1);
    return;
  }

  // Give the host link time to connect, receive a snapshot + lyrics, and let the
  // cover image and its palette extraction complete.
  await settle(window, 3500);

  const report = await window.webContents.executeJavaScript(`(() => {
    const o = globalThis.__overlay;
    const card = document.getElementById('card');
    const cover = document.getElementById('cover');
    return {
      hasOverlay: !!o,
      connected: card ? card.dataset.connected : null,
      status: card ? card.dataset.status : null,
      statusText: document.getElementById('status-text')?.textContent ?? null,
      title: document.getElementById('title')?.textContent ?? null,
      artist: document.getElementById('artist')?.textContent ?? null,
      timeTotal: document.getElementById('time-total')?.textContent ?? null,
      coverLoaded: cover ? cover.classList.contains('is-loaded') : null,
      coverSrc: cover && cover.src ? cover.src.slice(0, 80) : null,
      scheme: document.documentElement.dataset.scheme ?? null,
      swatchCount: document.getElementById('palette')?.children.length ?? 0,
      accentDominant: getComputedStyle(document.documentElement).getPropertyValue('--accent-dominant').trim(),
      lyricLines: document.querySelectorAll('.lyric-line').length,
      activeLyric: document.querySelector('.lyric-line.is-active .text')?.textContent ?? null,
      sweep: document.querySelector('.lyric-line.is-active .text')?.parentElement?.style.getPropertyValue('--p') ?? null,
      positionMs: o ? Math.round(o.clock.positionMs) : null,
      durationMs: o ? Math.round(o.clock.durationMs) : null,
      fraction: o ? Number(o.clock.fraction.toFixed(4)) : null,
    };
  })()`);

  console.log('--- 页面状态 ---');
  console.log(JSON.stringify(report, null, 2));

  const faces = face === 'both' ? ['front', 'back'] : [face];
  for (const target of faces) {
    await window.webContents.executeJavaScript(
      `document.getElementById('card').dataset.face = ${JSON.stringify(target)};`,
    );
    await settle(window, 900);
    const image = await window.webContents.capturePage();
    const file = join(outDir, `card-${target}@${scale}x.png`);
    writeFileSync(file, image.toPNG());
    console.log(`saved ${file}`);
  }

  app.exit(0);
});
