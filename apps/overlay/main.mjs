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
//
// The window owns three things the renderer cannot do itself:
//   - its own size, which is how the card rolls up into a strip and back (see setCollapsed);
//   - where the pointer is, which decides when to roll up (see startHoverWatch);
//   - whether the app is running at all.
// The renderer is told the lock state and reports when it has drawn; everything else it works
// out from the window size it is given.

import { app, BrowserWindow, Menu, Tray, ipcMain, nativeImage, screen, shell } from 'electron';
import { spawn } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CARD_WIDTH_MAX,
  CARD_WIDTH_MIN,
  CARD_WIDTH_PRESETS,
  DEFAULT_WIDTH,
  MAX_WIDTH,
  MIN_WIDTH,
  cardWidthForWindow,
  clamp,
  createHoverState,
  fitWindow,
  loadWindowState,
  makeIconPng,
  saveWindowState,
  stateFilePath,
} from './shell-utils.mjs';

// Shared with the renderer so the two sides cannot disagree about where a drag puts the window.
import { dragTarget } from '../../ui/src/drag.js';

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
const PRELOAD = join(HERE, 'preload.cjs');

const HOST_PORT = Number(process.env.OVERLAY_HOST_PORT ?? 8787);
const UI_PORT = Number(process.env.OVERLAY_UI_PORT ?? 8788);
const UI_URL = `http://127.0.0.1:${UI_PORT}/`;
const CDP_PORT = Number(process.env.OVERLAY_CDP_PORT ?? 9223);

/** How often the pointer is sampled. Fast enough to feel immediate, cheap enough to ignore. */
const HOVER_POLL_MS = 120;
/**
 * Grace period after the shell itself moves or shows the window.
 *
 * The tray menu is the usual way in, and the pointer is then sitting on the tray icon - i.e.
 * outside the window - so without this the card would roll up again the moment it appeared.
 */
const SUPPRESS_MS = 2500;

/** Accent used for the tray icon; matches the app's default accent. */
const ICON_COLOR = { r: 0x98, g: 0xb6, b: 0xbe };

/**
 * The generated icon, as a `NativeImage`.
 *
 * `Tray` and `BrowserWindow.icon` want a NativeImage or a file path - handing them the raw PNG
 * buffer throws `Argument must be a file path or a NativeImage`. That throw happened inside
 * `createTray()`, which ran in the middle of startup and therefore silently skipped everything
 * after it, including `startHoverWatch()`. Hence "the card never rolls up".
 */
function iconImage(size) {
  const image = nativeImage.createFromBuffer(makeIconPng(ICON_COLOR, size));
  if (image.isEmpty()) console.warn(`[shell] ${size}px 图标解码失败（托盘与任务栏图标会缺失）`);
  return image;
}

let mainWindow = null;
let tray = null;
let trayMenu = null;
let hostProcess = null;
let quitting = false;

/** Card width in CSS pixels; the window is this plus the shadow margin on each side. */
let cardWidth = cardWidthForWindow(DEFAULT_WIDTH);
let collapsed = false;
/** "Do not auto-collapse". Owned here, persisted here, mirrored to the card button and the tray. */
let locked = true;
/**
 * The renderer has drawn once.
 *
 * Set from the webContents lifecycle, deliberately NOT from an IPC message: the roll-up
 * decision is entirely the shell's and must keep working if the preload bridge fails to load.
 * Gating it on a message from the renderer made "the bridge is broken" and "the card never
 * rolls up" the same symptom, which is how this shipped broken once already.
 */
let rendererReady = false;
let suppressUntil = 0;
let hoverTimer = null;
let hoverState = null;
let saveTimer = null;
/** Bounds captured at the start of a pointer drag, or null when no drag is in progress. */
let dragOrigin = null;
let dragMoved = false;
/** When the last drag event arrived, so a gesture that never ends can be dropped. */
let dragLastAt = 0;

/** A drag with no traffic for this long is treated as abandoned rather than left open. */
const DRAG_STALE_MS = 30_000;

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

/* ------------------------------------------------------------------- geometry */

/**
 * Say which UI files are being served, and when they were last written.
 *
 * There is no build step, so the running UI is whatever is on disk - which makes "did my fix
 * actually get loaded?" a real question, and one that a stale HTTP cache can answer wrongly.
 * Printing the mtime makes it checkable from the terminal instead of guessed at.
 */
function reportUiAssets() {
  const files = ['index.html', 'styles/tokens.css', 'styles/card.css', 'src/main.js', 'src/card.js', 'src/layout.js'];
  const stamps = files.map((file) => {
    try {
      return `${file} ${statSync(join(UI_ROOT, file)).mtime.toISOString().slice(11, 19)}`;
    } catch {
      return `${file} 缺失`;
    }
  });
  console.info(`[shell] 界面资源(${UI_ROOT}): ${stamps.join('  ')}`);
}

function workAreaForWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return screen.getPrimaryDisplay().workArea;
  return screen.getDisplayMatching(mainWindow.getBounds()).workArea;
}

/** Resize the window to match the current card width and collapsed state. */
function applyGeometry() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const bounds = mainWindow.getBounds();
  const workArea = workAreaForWindow();
  const fit = fitWindow(cardWidth, workArea);
  cardWidth = fit.cardWidth;

  const height = collapsed ? fit.collapsedHeight : fit.height;
  // Anchor the top edge, so rolling up eats the bottom of the window - which is what makes it
  // read as the panel sliding up rather than the window jumping.
  let y = bounds.y;
  if (y + height > workArea.y + workArea.height) y = workArea.y + workArea.height - height;
  if (y < workArea.y) y = workArea.y;

  mainWindow.setBounds({ x: bounds.x, y, width: fit.width, height }, false);
  persistWindowState();
}

function setCollapsed(next) {
  const value = next === true;
  if (collapsed === value) return;
  collapsed = value;
  console.info(`[shell] ${value ? '收起' : '展开'}窗口（锁定=${locked ? '开' : '关'}）`);
  applyGeometry();
}

function setCardWidth(next) {
  if (!mainWindow) return;
  cardWidth = clamp(Math.round(Number(next) || cardWidth), CARD_WIDTH_MIN, CARD_WIDTH_MAX);
  suppressUntil = Date.now() + SUPPRESS_MS;
  applyGeometry();
}

function persistWindowState() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const bounds = mainWindow.getBounds();
  saveWindowState(stateFilePath(app.getPath('userData')), {
    cardWidth,
    x: bounds.x,
    y: bounds.y,
    locked,
  });
}

/** Keep the card button and the tray checkbox showing the same thing. */
function setLocked(next) {
  locked = next === true;
  if (locked && collapsed) setCollapsed(false);
  mainWindow?.webContents.send('overlay:state', { locked });
  refreshTrayMenu();
  persistWindowState();
  console.info(`[shell] 锁定: ${locked ? '开（不再自动收起）' : '关（鼠标离开会收起）'}`);
}

/** `move` fires continuously while dragging, so the write is coalesced. */
function scheduleStateSave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    persistWindowState();
  }, 400);
}

/* --------------------------------------------------------- pointer -> collapse */

/**
 * Watch the pointer and roll the window up when it leaves.
 *
 * Polled from the main process rather than driven by `mouseleave` in the renderer, because the
 * main process is the only side that can ask the OS where the cursor actually is. That matters
 * once the window is transparent: "the pointer left the card" and "the pointer left the window"
 * are different questions, and only the second one can be answered reliably.
 */
function startHoverWatch() {
  if (hoverTimer) return;
  hoverState = createHoverState({ collapseDelayMs: 600, expandDelayMs: 90 });

  hoverTimer = setInterval(() => {
    try {
      if (quitting || !mainWindow || mainWindow.isDestroyed()) return;
      if (!mainWindow.isVisible() || mainWindow.isMinimized()) {
        hoverState.reset();
        return;
      }
      // A drag moves the window under the pointer; rolling up mid-drag would be absurd, and the
      // bounds sampled during one are meaningless. A drag that stops reporting is dropped, so
      // this can never become a permanent "never rolls up again".
      if (dragOrigin) {
        if (Date.now() - dragLastAt > DRAG_STALE_MS) {
          console.warn('[shell] 拖动超过 30 秒没有动静，已放弃该手势');
          endDrag();
        }
        hoverState.reset();
        return;
      }
      if (!rendererReady || Date.now() < suppressUntil) {
        // Re-adopt the pointer's position on every suppressed tick, so the delay starts from
        // when the window settled rather than from a stale sample.
        hoverState.reset();
        return;
      }

      const bounds = mainWindow.getBounds();
      const point = screen.getCursorScreenPoint();
      const inside =
        point.x >= bounds.x &&
        point.x < bounds.x + bounds.width &&
        point.y >= bounds.y &&
        point.y < bounds.y + bounds.height;

      if (hoverState.update(Date.now(), inside, locked)) setCollapsed(hoverState.collapsed);
    } catch (err) {
      // An exception here would otherwise surface as an uncaught error in the middle of the
      // main process, which looks nothing like "the pointer query failed".
      console.error('[shell] 指针监听出错，已停止自动收起', err);
      clearInterval(hoverTimer);
      hoverTimer = null;
    }
  }, HOVER_POLL_MS);
}

/* --------------------------------------------------------------------- window */

function createWindow() {
  const workArea = screen.getPrimaryDisplay().workArea;
  const state = loadWindowState(
    stateFilePath(app.getPath('userData')),
    screen.getAllDisplays().map((d) => d.bounds),
  );
  const fit = fitWindow(state.cardWidth, workArea);
  cardWidth = fit.cardWidth;
  locked = state.locked;
  collapsed = false;
  // A fresh window has not drawn yet, and the pointer is wherever the user launched from - so
  // neither the roll-up nor the first sample can be trusted until the page is up.
  rendererReady = false;
  suppressUntil = Date.now() + SUPPRESS_MS;
  hoverState?.reset();

  mainWindow = new BrowserWindow({
    width: fit.width,
    height: fit.height,
    x: state.x,
    y: state.y,
    minWidth: MIN_WIDTH,
    maxWidth: MAX_WIDTH,
    // Fixed proportions: the card is a fixed-aspect design, so let the user scale it but not
    // distort it. `resizable: false` only disables the user's drag handles - the shell still
    // resizes the window itself with setBounds, which is how rolling up works. Note there is
    // deliberately no minHeight: one would be enforced by the OS during setBounds and would
    // stop the window from ever becoming shorter than the full card.
    resizable: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    // The card draws its own floating shadow in the transparent margin. A native shadow would
    // be a rectangle around the whole window, shadow margin included.
    hasShadow: false,
    skipTaskbar: false,
    fullscreenable: false,
    maximizable: false,
    title: 'Now Playing',
    icon: iconImage(64),
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });

  // Always on top, above normal windows but not above full-screen apps or the taskbar.
  mainWindow.setAlwaysOnTop(true, 'floating');

  // The renderer's console is otherwise invisible without DevTools, which makes a failed
  // preload or a thrown module impossible to diagnose from the terminal.
  mainWindow.webContents.on('console-message', (...args) => {
    const details =
      args[0] && typeof args[0] === 'object' && 'message' in args[0] ? args[0] : { message: args[2] };
    console.log(`[ui] ${details.message}`);
  });

  mainWindow.loadURL(UI_URL);

  /*
   * `dom-ready` rather than an IPC handshake from the preload: the roll-up must not depend on
   * the bridge. By this point the page has a document and a size, so shrinking the window
   * cannot catch it mid-load.
   */
  mainWindow.webContents.once('dom-ready', () => {
    rendererReady = true;
    // The renderer may have missed the state if it subscribed before we were ready; it asks for
    // it too, and a duplicate is harmless.
    mainWindow?.webContents.send('overlay:state', { locked });
  });

  mainWindow.on('show', () => {
    suppressUntil = Date.now() + SUPPRESS_MS;
    hoverState?.reset();
  });

  mainWindow.on('move', scheduleStateSave);
  mainWindow.on('resize', scheduleStateSave);

  // Closing hides instead of destroying, so the overlay stays available from the tray. 退出 in
  // the tray menu is what actually stops the app.
  mainWindow.on('close', (event) => {
    if (quitting) return;
    event.preventDefault();
    mainWindow?.hide();
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
  // Bring it back as the full card: "显示" that produced a rolled-up strip would look like the
  // tray item had failed.
  setCollapsed(false);
  mainWindow.show();
  mainWindow.focus();
  // The pointer is on the tray icon, so hold off on rolling straight back up.
  suppressUntil = Date.now() + SUPPRESS_MS;
  hoverState?.reset();
}

function hideWindow() {
  mainWindow?.hide();
}

function toggleWindow() {
  if (!mainWindow) {
    createWindow();
    return;
  }
  if (mainWindow.isVisible()) hideWindow();
  else showWindow();
}

/* ---------------------------------------------------------------------- tray */

function trayTemplate() {
  return [
    { label: '显示 / 隐藏', click: () => toggleWindow() },
    {
      label: '居中显示',
      click: () => {
        setCollapsed(false);
        mainWindow?.center();
        showWindow();
      },
    },
    { type: 'separator' },
    {
      /*
       * The lock also lives here, and not only on the card, because it is the one control that
       * decides whether the window disappears when the pointer leaves. If the card's own
       * button is unreachable - rolled up, or the preload bridge failed to load - this still
       * works, so the overlay can never get stuck in a state its user cannot change.
       */
      label: '锁定（鼠标离开不收起）',
      type: 'checkbox',
      checked: locked,
      click: (item) => setLocked(item.checked),
    },
    {
      label: '立即收起',
      enabled: !locked,
      click: () => setCollapsed(true),
    },
    { type: 'separator' },
    { label: '尺寸', enabled: false },
    ...CARD_WIDTH_PRESETS.map((preset) => ({
      label: `  ${preset.label}（${preset.width}）`,
      click: () => {
        setCardWidth(preset.width);
        showWindow();
      },
    })),
    { type: 'separator' },
    {
      label: '退出',
      click: () => {
        quitting = true;
        app.quit();
      },
    },
  ];
}

/** Rebuilt rather than mutated: the checkbox and the enabled state both depend on `locked`. */
function refreshTrayMenu() {
  if (!tray) return;
  // Held in a module-level binding as well: the menu is replaced from inside its own click
  // handler, and a menu that is only referenced by the tray can be collected while it is open.
  trayMenu = Menu.buildFromTemplate(trayTemplate());
  tray.setContextMenu(trayMenu);
}

function createTray() {
  tray = new Tray(iconImage(16));
  tray.setToolTip('Now Playing — 网易云同步卡片');
  refreshTrayMenu();
  tray.on('click', () => toggleWindow());
}

/* ------------------------------------------------------------------------- ipc */

function bindIpc() {
  ipcMain.on('overlay:toggle-lock', () => setLocked(!locked));

  ipcMain.on('overlay:request-state', (event) => {
    // Answer only the window that asked, so a stale sender cannot be trusted with it.
    if (mainWindow && event.sender === mainWindow.webContents) {
      event.sender.send('overlay:state', { locked });
    }
  });

  ipcMain.on('overlay:set-collapsed', (_event, value) => {
    if (value === true && locked) return;
    suppressUntil = 0;
    setCollapsed(value === true);
  });

  ipcMain.on('overlay:close', () => hideWindow());

  /* --------------------------------------------------------------- dragging */

  ipcMain.on('overlay:drag-start', (event) => {
    if (!mainWindow || event.sender !== mainWindow.webContents) return;
    // The bounds are captured once, at the press. Every move is then measured from here, so the
    // window's position is a pure function of the total pointer delta - no accumulation, and no
    // drift if an event is dropped.
    dragOrigin = mainWindow.getBounds();
    dragMoved = false;
    dragLastAt = Date.now();
  });

  ipcMain.on('overlay:drag-move', (event, delta) => {
    if (!mainWindow || !dragOrigin || event.sender !== mainWindow.webContents) return;
    const target = dragTarget(dragOrigin, Number(delta?.dx) || 0, Number(delta?.dy) || 0);
    const bounds = mainWindow.getBounds();
    if (bounds.x === target.x && bounds.y === target.y) return;
    dragMoved = true;
    dragLastAt = Date.now();
    // Never let the cursor leave the window mid-drag: the gesture would stop receiving events.
    suppressUntil = Date.now() + SUPPRESS_MS;
    mainWindow.setBounds({ ...bounds, x: target.x, y: target.y }, false);
  });

  ipcMain.on('overlay:drag-end', (event) => {
    if (!mainWindow || event.sender !== mainWindow.webContents) return;
    endDrag();
  });

  // A renderer that goes away mid-drag must not leave the gesture (and with it the suppression
  // of auto-collapse) open.
  mainWindow?.webContents.on('render-process-gone', () => endDrag());
}

/**
 * Forget an in-flight drag.
 *
 * A drag that never ends would leave `dragOrigin` set, and the pointer watcher skips every tick
 * while a drag is open - so the card would silently stop rolling up. That failure mode has
 * already cost this project a round, so a stale drag is dropped rather than trusted.
 */
function endDrag() {
  if (!dragOrigin) return;
  dragOrigin = null;
  if (dragMoved) persistWindowState();
  dragMoved = false;
}

/* --------------------------------------------------------------------- start */

/*
 * Each startup step is independent, and the roll-up starts before the tray.
 *
 * A throw in `createTray()` used to take down everything after it in this block - including
 * `startHoverWatch()` - so a broken tray icon presented as "the card never rolls up". Optional
 * extras must never be able to disable a core feature, and a failure here must say so rather
 * than becoming an unhandled rejection.
 */
app
  .whenReady()
  .then(async () => {
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
      // than silently exiting. A host already on the port is a normal cause - e.g. a leftover
      // one from an earlier run - and the window simply talks to that instead.
      console.error(`[shell] 界面服务未就绪 (${UI_URL})，仍打开窗口以便显示状态`);
    }

    bindIpc();
    reportUiAssets();
    // The pointer watcher is started first, and touches nothing that can fail: it only stores a
    // timer. Everything after this point is allowed to break without disabling the roll-up.
    startHoverWatch();
    createWindow();

    try {
      createTray();
    } catch (err) {
      console.error('[shell] 托盘创建失败（收起/展开不受影响）', err);
    }

    app.on('activate', () => showWindow());
  })
  .catch((err) => {
    console.error('[shell] 启动失败', err);
  });

// Closing the window hides it instead of quitting, so the overlay stays available from the tray.
app.on('window-all-closed', () => {
  if (quitting) app.quit();
});

app.on('before-quit', () => {
  quitting = true;
});

app.on('will-quit', () => {
  if (hoverTimer) clearInterval(hoverTimer);
  hoverTimer = null;
  stopHost();
});
