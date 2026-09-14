// Electron desktop shell.
//
// A frameless, transparent, always-on-top window showing the host's overlay UI. The shell does
// not reimplement anything: it launches the same `tools/host-run.mjs` the development workflow
// uses, waits for its HTTP server to answer, and then loads that URL. So the desktop app and the
// browser preview are the same renderer, and neither can drift from the other.
//
// Why a child process rather than importing the host directly: the host is TypeScript executed
// straight from source by Node's type stripping, while Electron's main process is plain
// JavaScript. Spawning `node` keeps that working and isolates a host crash from the window.

import { app, BrowserWindow, Menu, Tray, screen, shell } from 'electron';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CARD_ASPECT,
  DEFAULT_WIDTH,
  MAX_WIDTH,
  MIN_WIDTH,
  clamp,
  heightForWidth,
  loadWindowState,
  makeIconPng,
  saveWindowState,
  stateFilePath,
} from './shell-utils.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Repository root.
 *
 * When packaged, the app directory sits inside resources, so the host entry point is one level
 * up. In development this resolves to the checkout that contains apps/overlay.
 */
const ROOT = resolve(HERE, '..', '..');
const HOST_ENTRY = join(ROOT, 'tools', 'host-run.mjs');
const UI_ROOT = join(ROOT, 'ui');

const HOST_PORT = Number(process.env.OVERLAY_HOST_PORT ?? 8787);
const UI_PORT = Number(process.env.OVERLAY_UI_PORT ?? 8788);
const UI_URL = `http://127.0.0.1:${UI_PORT}/`;
const CDP_PORT = Number(process.env.OVERLAY_CDP_PORT ?? 9223);

/** Accent used for the tray icon; matches the app's default accent. */
const ICON_COLOR = { r: 0x98, g: 0xb6, b: 0xbe };

let mainWindow = null;
let tray = null;
let hostProcess = null;
let quitting = false;

/* -------------------------------------------------------------- single instance */

// A second launch should surface the existing window rather than start a second host, which
// would fail to bind the port anyway.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    showWindow();
  });
}

/* ----------------------------------------------------------------------- host */

function startHost() {
  if (!existsSync(HOST_ENTRY)) {
    throw new Error(`未找到宿主入口: ${HOST_ENTRY}`);
  }

  hostProcess = spawn(
    process.execPath,
    [
      HOST_ENTRY,
      '--host-port',
      String(HOST_PORT),
      '--ui-port',
      String(UI_PORT),
      '--cdp-port',
      String(CDP_PORT),
      '--ui-root',
      UI_ROOT,
    ],
    {
      cwd: ROOT,
      // Electron's own userData path is passed on so the host can cache module discovery there:
      // under a normal desktop launch it has write access, which it does not in the sandboxed
      // development shell, and without it every start repeats the full module scan.
      env: { ...process.env, OVERLAY_CACHE_DIR: app.getPath('userData'), ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    },
  );

  hostProcess.stdout?.on('data', (chunk) => process.stdout.write(`[host] ${chunk}`));
  hostProcess.stderr?.on('data', (chunk) => process.stderr.write(`[host] ${chunk}`));
  hostProcess.on('exit', (code) => {
    hostProcess = null;
    if (quitting) return;
    console.error(`[shell] 宿主退出，代码 ${code}`);
    // The window would sit there showing "未连接宿主"; make the reason visible instead.
    mainWindow?.webContents.send?.('host-exited');
  });
}

/** Poll the host's HTTP endpoint until it answers, so the window never loads a dead URL. */
async function waitForUi(timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${UI_URL}config.json`, { cache: 'no-store' });
      if (res.ok) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

function stopHost() {
  if (!hostProcess) return;
  const child = hostProcess;
  hostProcess = null;
  try {
    child.kill();
  } catch {
    /* already gone */
  }
}

/* --------------------------------------------------------------------- window */

function createWindow() {
  const workArea = screen.getPrimaryDisplay().workArea;
  const state = loadWindowState(stateFilePath(app.getPath('userData')), screen.getAllDisplays().map((d) => d.bounds));
  const width = clamp(state.width ?? DEFAULT_WIDTH, MIN_WIDTH, MAX_WIDTH);
  const height = heightForWidth(width, workArea);

  mainWindow = new BrowserWindow({
    width,
    height,
    x: state.x,
    y: state.y,
    minWidth: MIN_WIDTH,
    minHeight: heightForWidth(MIN_WIDTH, workArea),
    maxWidth: MAX_WIDTH,
    // Fixed proportions: the card is a fixed-aspect design, so let the user scale it but not
    // distort it.
    resizable: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    skipTaskbar: false,
    fullscreenable: false,
    maximizable: false,
    title: 'Now Playing',
    icon: makeIconPng(ICON_COLOR, 64),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });

  // Always on top, above normal windows but not above full-screen apps or the taskbar.
  mainWindow.setAlwaysOnTop(true, 'floating');

  mainWindow.loadURL(UI_URL);

  mainWindow.on('moved', () => {
    if (!mainWindow) return;
    const bounds = mainWindow.getBounds();
    saveWindowState(stateFilePath(app.getPath('userData')), bounds);
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // External links open in the user's browser rather than inside the card.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  return mainWindow;
}

function showWindow() {
  if (!mainWindow) {
    createWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function toggleWindow() {
  if (!mainWindow) {
    createWindow();
    return;
  }
  if (mainWindow.isVisible()) mainWindow.hide();
  else showWindow();
}

/** Resize while keeping the card's proportions. */
function setWidth(width) {
  if (!mainWindow) return;
  const workArea = screen.getPrimaryDisplay().workArea;
  const next = clamp(Math.round(width), MIN_WIDTH, MAX_WIDTH);
  const bounds = mainWindow.getBounds();
  mainWindow.setBounds({
    x: bounds.x,
    y: bounds.y,
    width: next,
    height: heightForWidth(next, workArea),
  });
  saveWindowState(stateFilePath(app.getPath('userData')), mainWindow.getBounds());
}

/* ---------------------------------------------------------------------- tray */

function createTray() {
  const icon = makeIconPng(ICON_COLOR, 16);
  tray = new Tray(icon);
  tray.setToolTip('Now Playing — 网易云同步卡片');

  const menu = Menu.buildFromTemplate([
    { label: '显示 / 隐藏', click: () => toggleWindow() },
    { label: '居中显示', click: () => { mainWindow?.center(); showWindow(); } },
    { type: 'separator' },
    { label: '尺寸', enabled: false },
    { label: '  小 (260)', click: () => setWidth(260) },
    { label: '  中 (400)', click: () => setWidth(400) },
    { label: '  大 (520)', click: () => setWidth(520) },
    { type: 'separator' },
    { label: '退出', click: () => { quitting = true; app.quit(); } },
  ]);
  tray.setContextMenu(menu);
  tray.on('click', () => toggleWindow());
}

/* --------------------------------------------------------------------- start */

app.whenReady().then(async () => {
  let hostError = null;
  try {
    startHost();
  } catch (err) {
    hostError = err instanceof Error ? err.message : String(err);
    console.error('[shell] 启动宿主失败', hostError);
  }

  const ready = hostError ? false : await waitForUi();
  if (!ready) {
    // Still open the window: the UI shows a clear "not connected" state, which is more useful
    // than silently exiting.
    console.error(`[shell] 界面服务未就绪 (${UI_URL})，仍打开窗口以便显示状态`);
  }

  createWindow();
  createTray();

  app.on('activate', () => showWindow());
});

// Closing the window hides it instead of quitting, so the overlay stays available from the tray.
app.on('window-all-closed', () => {
  if (quitting) app.quit();
});

app.on('before-quit', () => {
  quitting = true;
});

app.on('will-quit', () => {
  stopHost();
});
