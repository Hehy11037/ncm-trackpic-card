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
  clampToWorkArea,
  createHoverState,
  dragTarget,
  easeOutCubic,
  fitWindow,
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
const PRELOAD = join(HERE, 'preload.cjs');

const HOST_PORT = Number(process.env.OVERLAY_HOST_PORT ?? 8787);
const UI_PORT = Number(process.env.OVERLAY_UI_PORT ?? 8788);
const UI_URL = `http://127.0.0.1:${UI_PORT}/`;
const CDP_PORT = Number(process.env.OVERLAY_CDP_PORT ?? 9223);

/**
 * How often the pointer is sampled.
 *
 * 40ms rather than the original 120ms: this is the resolution of "did the pointer leave?", and at
 * 120ms the roll-up felt sluggish on top of its own delay. The query is a cheap Win32 call.
 */
const HOVER_POLL_MS = 40;
/**
 * How long the pointer must stay away before the card rolls up.
 *
 * 120ms. This is the number felt as "reaction time", and a deliberate move away from the card is
 * unambiguous well before it elapses - the delay exists only to forgive a pointer that clips the
 * edge. An unwanted roll-up is cheap to undo, because the expand delay is shorter still.
 */
const COLLAPSE_DELAY_MS = 120;
/** How long the pointer must rest on the rolled-up strip before it expands again. */
const EXPAND_DELAY_MS = 40;
/**
 * How long the roll-up and the unroll take.
 *
 * Short enough to feel like a snap rather than a transition, long enough to be read as movement.
 * This is the *duration*; the reaction time is `COLLAPSE_DELAY_MS` plus one poll.
 */
const RESIZE_MS = 120;
/**
 * Grace period after the shell itself moves or shows the window.
 *
 * The tray menu is the usual way in, and the pointer is then sitting on the tray icon - i.e.
 * outside the window - so without this the card would roll up again the moment it appeared.
 */
const SUPPRESS_MS = 2500;

/**
 * What the window shows while the host is starting.
 *
 * A data URL rather than a file: it has to render before the host's HTTP server exists, which is
 * the whole point. The card's own palette is used so the flash between this and the real UI is
 * not jarring.
 */
const STARTUP_PAGE = `data:text/html;charset=utf-8,${encodeURIComponent(
  '<!doctype html><meta charset="utf-8"><style>' +
    'html,body{margin:0;height:100%;background:transparent;overflow:hidden;' +
    "font:13px/1.6 system-ui,'Microsoft YaHei',sans-serif;color:#8d9aa1}" +
    'body{display:grid;place-items:center}' +
    '</style><body>正在启动…</body>',
)}`;

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
/** Consecutive hover-watch errors, so a repeating failure is reported without flooding. */
let hoverErrors = 0;
/** When the pointer was first seen outside the window, for the stuck-collapse diagnostic. */
let outsideFor = 0;
/** Whether that diagnostic has already fired for the current absence. */
let reportedStuck = false;
/**
 * Offset of the press inside the window while the pointer is dragging it, or null.
 *
 * The window is moved so this offset stays constant under the cursor. Storing the *offset* rather
 * than the deltas the renderer reports means the cursor cannot outrun the window and escape it -
 * an escaped cursor meant no `pointerup`, a drag that never ended, and a card abandoned somewhere
 * the user could not recover by hand.
 */
let dragGrab = null;
/** Whether the drag moved the window at all, so a plain click does not rewrite the state file. */
let dragMoved = false;
/**
 * The window's size, captured when a drag begins and never read back while it runs.
 *
 * Feeding `getBounds().width` into the next `setBounds` compounds a DIP rounding drift on displays
 * whose scale factor is not whole, which showed up as the card slowly growing while it was moved.
 */
let dragSize = null;
/** The display the drag started on. Displays do not change mid-drag, and the query is synchronous. */
let dragWorkArea = null;
/** Set once per drag when the OS reports a size other than the one we asked for. */
let dragSizeMismatch = false;
/** When the drag last moved the window, so a gesture that never ends can be dropped. */
let dragLastAt = 0;
/** The short tween that animates the roll-up and the unroll. */
let resizeTimer = null;
/** The tween's captured endpoints, or null when none is running. */
let resizeAnim = null;
/** Bumped per tween, so a stale renderer tick or backstop cannot apply to a newer one. */
let resizeToken = 0;

/**
 * A drag with no movement for this long is treated as abandoned rather than left open.
 *
 * Short on purpose. While a drag is open the pointer watcher skips every tick, so a leaked drag -
 * the renderer never seeing the `pointerup`, say - leaves the card unable to roll up at all until
 * this fires. Dropping a *live* drag costs nothing, because the renderer re-arms on the next move
 * with the button held.
 */
const DRAG_STALE_MS = 4000;
/**
 * Grace period after a drag ends, before the roll-up may trigger.
 *
 * Short: the pointer is inside the window at the end of a drag, so the ordinary rule applies
 * almost immediately. `SUPPRESS_MS` is for the tray, where the pointer really is outside.
 */
const DRAG_SETTLE_MS = 350;

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

/**
 * Where the window belongs for the current card width and collapsed state.
 *
 * Separated from the applying of it because the roll-up tweens towards this and the card-width
 * presets jump straight to it.
 */
function geometryTarget() {
  const bounds = mainWindow.getBounds();
  const workArea = workAreaForWindow();
  const fit = fitWindow(cardWidth, workArea);
  cardWidth = fit.cardWidth;

  const height = collapsed ? fit.collapsedHeight : fit.height;
  /*
   * Anchor the top edge, so rolling up eats the bottom of the window - which is what makes it read
   * as the panel sliding up rather than the window jumping - and keep the result fully on screen.
   *
   * The clamp is what makes a rolled-up card recoverable: the strip sits along the window's top
   * edge, so a window left hanging above the top of the display would put the strip where no
   * pointer can reach it, and the card could never be expanded again.
   */
  const position = clampToWorkArea({ x: bounds.x, y: bounds.y }, { width: fit.width, height }, workArea);

  return { x: position.x, y: position.y, width: fit.width, height };
}

/** Jump straight to the target, with no tween. Used for width changes and at startup. */
function applyGeometry() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  stopResizeTween();
  mainWindow.setBounds(geometryTarget(), false);
  persistWindowState();
}

/**
 * Resize with a short tween.
 *
 * The roll-up used to be a single jump. Even once the delay was cut, it read as slow - because
 * nothing moved, so there was nothing to judge the speed by except the pause. A short tween makes
 * it read as a deliberate movement and hides the sampling delay inside the motion.
 *
 * **The tween is stepped by the renderer's animation frames, not by a timer here.** A
 * `setInterval` fires *near* every frame rather than on it: sometimes twice within one frame,
 * sometimes not at all. Every step is the same size, but the irregularity is what the eye reads as
 * 一顿一顿的 - and it is the same lesson the drag learned. The renderer's `requestAnimationFrame`
 * is the only frame clock either side has, so it sends a tick and this applies one step per tick;
 * the *values* are still computed here from this process's own clock, so a tick cannot distort the
 * curve.
 *
 * `setBounds`'s own `animate` flag is macOS-only, and the steps come from values captured once
 * rather than from `getBounds()` mid-flight - reading the size back and writing it again can
 * compound a rounding drift, which is what made the window grow while it was dragged.
 */
function animateGeometryTo(target, ms = RESIZE_MS) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  stopResizeTween();

  const current = mainWindow.getBounds();
  const from = { x: current.x, y: current.y, height: current.height };
  if (from.height === target.height && from.y === target.y && from.x === target.x) {
    mainWindow.setBounds(target, false);
    persistWindowState();
    return;
  }

  resizeAnim = { from, target, startedAt: Date.now(), ms };
  resizeToken += 1;
  // Ask the renderer to drive us, one tick per frame.
  mainWindow.webContents.send('overlay:animate-resize', { token: resizeToken, ms });
  /*
   * And a timer as a backstop, in case the renderer is gone or its frames are not running. It
   * only ever *finishes* the animation early; it does not step it, so it cannot reintroduce the
   * jitter.
   */
  resizeTimer = setTimeout(() => finishResizeTween(resizeToken), ms + 120);
  applyResizeStep();
}

/** Apply the current step of the tween, if one is running. Called once per rendered frame. */
function applyResizeStep() {
  if (!resizeAnim || !mainWindow || mainWindow.isDestroyed()) return;
  const { from, target, startedAt, ms } = resizeAnim;
  const t = Math.min(1, (Date.now() - startedAt) / ms);
  const eased = easeOutCubic(t);
  mainWindow.setBounds(
    {
      x: Math.round(from.x + (target.x - from.x) * eased),
      y: Math.round(from.y + (target.y - from.y) * eased),
      width: target.width,
      height: Math.round(from.height + (target.height - from.height) * eased),
    },
    false,
  );
  if (t >= 1) {
    stopResizeTween();
    persistWindowState();
  }
}

function stopResizeTween() {
  if (resizeTimer) {
    clearTimeout(resizeTimer);
    resizeTimer = null;
  }
  resizeAnim = null;
  // Tell the renderer to stop ticking; a token mismatch makes any in-flight tick a no-op anyway.
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('overlay:animate-resize', { token: 0, ms: 0 });
  }
}

/** A tween that ran out of time (the renderer stopped ticking) still has to land on the target. */
function finishResizeTween(token) {
  if (!resizeAnim || token !== resizeToken) return;
  const { target } = resizeAnim;
  stopResizeTween();
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.setBounds(target, false);
  persistWindowState();
}

function setCollapsed(next) {
  const value = next === true;
  if (collapsed === value) return;
  collapsed = value;
  console.info(`[shell] ${value ? '收起' : '展开'}窗口（锁定=${locked ? '开' : '关'}）`);
  // A drag owns the window's bounds while it runs; let it finish first.
  if (dragGrab) {
    applyGeometry();
    return;
  }
  animateGeometryTo(geometryTarget());
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

/**
 * "Do not auto-collapse". Owned and persisted here; the card's lock button and `L` are its only
 * controls, and they are views of this value rather than copies of it.
 */
function setLocked(next) {
  locked = next === true;
  if (locked && collapsed) setCollapsed(false);
  mainWindow?.webContents.send('overlay:state', { locked });
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
  hoverState = createHoverState({
    collapseDelayMs: COLLAPSE_DELAY_MS,
    expandDelayMs: EXPAND_DELAY_MS,
  });

  hoverTimer = setInterval(() => {
    try {
      if (quitting || !mainWindow || mainWindow.isDestroyed()) return;
      if (!mainWindow.isVisible() || mainWindow.isMinimized()) {
        hoverState.reset();
        return;
      }
      // A drag moves the window under the pointer; rolling up mid-drag would be absurd, and the
      // bounds sampled during one are meaningless. A drag that stops moving is dropped quickly,
      // because the renderer re-arms on the next move with the button held - so ending a live
      // gesture by mistake costs nothing, while leaving a dead one open stops the card rolling up
      // for as long as the guard lasts.
      if (dragGrab) {
        if (Date.now() - dragLastAt > DRAG_STALE_MS) {
          console.warn(`[shell] 拖动 ${DRAG_STALE_MS} ms 没有动静，已放弃该手势（期间不会收起）`);
          endDrag('stale');
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

      const now = Date.now();
      const bounds = mainWindow.getBounds();
      const point = screen.getCursorScreenPoint();
      const inside =
        point.x >= bounds.x &&
        point.x < bounds.x + bounds.width &&
        point.y >= bounds.y &&
        point.y < bounds.y + bounds.height;

      if (hoverState.update(now, inside, locked)) setCollapsed(hoverState.collapsed);
      hoverErrors = 0;

      /*
       * Say so when the pointer has clearly gone and the card has not rolled up.
       *
       * Reaching this line means every guard above has already been passed, so a failure here is
       * the state machine itself - and "it sometimes just does not collapse" is otherwise
       * impossible to attribute from the outside. Reported once per occurrence.
       */
      outsideFor = inside ? 0 : outsideFor || now;
      if (!inside && !collapsed && !locked && now - outsideFor > COLLAPSE_DELAY_MS + 800) {
        if (!reportedStuck) {
          reportedStuck = true;
          console.warn(
            `[shell] 指针离开 ${now - outsideFor}ms 仍未收起：状态机 inside=${hoverState.inside}，` +
              `locked=${locked}，ready=${rendererReady}`,
          );
        }
      } else if (collapsed || inside) {
        reportedStuck = false;
      }
    } catch (err) {
      /*
       * Keep the interval, and keep the hover state.
       *
       * Clearing the interval turned one transient error into "the card never rolls up or expands
       * again", which is the worst outcome this feature has. Resetting the state on every error was
       * a subtler version of the same problem: it restarts the "pointer has been away" timer, so an
       * error every other tick could stop the collapse from ever reaching its delay. A bad tick is
       * now simply skipped - the next good one continues the streak.
       */
      hoverErrors++;
      if (hoverErrors <= 3 || hoverErrors % 100 === 0) {
        console.error(`[shell] 指针监听出错（第 ${hoverErrors} 次，已跳过该次采样）`, err);
      }
    }
  }, HOVER_POLL_MS);
}

/* --------------------------------------------------------------------- window */

/**
 * Load the real UI, once its server is answering.
 *
 * `dom-ready` rather than an IPC handshake from the preload: the roll-up must not depend on the
 * bridge. Attached here, and not in `createWindow`, because the window first shows the startup
 * page - and that page must not be what marks the renderer ready, or the card could roll up before
 * the real interface had ever been drawn.
 */
async function loadUi() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.once('dom-ready', () => {
    rendererReady = true;
    suppressUntil = Date.now() + SUPPRESS_MS;
    // The renderer may have asked for the state before we could answer; a duplicate is harmless.
    mainWindow?.webContents.send('overlay:state', { locked });
    console.info('[shell] 界面已加载，自动收起开始工作');
  });
  try {
    await mainWindow.loadURL(UI_URL);
  } catch (err) {
    console.error(`[shell] 加载界面失败 (${UI_URL})`, err);
  }
}

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

  /*
   * Show something immediately, and load the real UI once the host answers.
   *
   * Waiting for the host before creating the window left the shell with no window at all for
   * however long the host took - and Windows shows its "starting" cursor (the arrow-with-hourglass
   * the user saw) for a process that has not opened a window yet. The window now exists at once
   * and says what it is waiting for.
   */
  mainWindow.loadURL(STARTUP_PAGE);

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
  }  if (mainWindow.isMinimized()) mainWindow.restore();
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

/**
 * The tray menu: three sizes and quit, and nothing else.
 *
 * It was a control panel - show/hide, expand, centre, a lock checkbox, a collapse item - and the
 * owner of the app asked for it to be cut back to the two things worth reaching for from the
 * notification area. The sizes are not behind a disabled "尺寸" header either: the labels say what
 * they are, and the point of the change was fewer rows.
 *
 * Nothing is lost by removing the rest:
 *
 *  - **show / hide, and recovery from a rolled-up card**, are the tray icon's own left-click, which
 *    toggles the window and always brings it back expanded (`showWindow` un-collapses);
 *  - **the lock** lives on the card and on `L`. It is still owned and persisted by the shell, so
 *    removing the checkbox did not move the state anywhere;
 *  - **centre** was only ever a convenience for a window someone had dragged off somewhere.
 */
function trayTemplate() {
  return [
    ...CARD_WIDTH_PRESETS.map((preset) => ({
      label: `${preset.label}（${preset.width}）`,
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

function createTray() {
  tray = new Tray(iconImage(16));
  tray.setToolTip('Now Playing — 网易云同步卡片（单击显示/隐藏）');
  /*
   * Built once and held in a module-level binding. The menu no longer changes, and a menu that is
   * only referenced by the tray can be collected while it is open.
   */
  trayMenu = Menu.buildFromTemplate(trayTemplate());
  tray.setContextMenu(trayMenu);
  // Left-click is the whole show/hide and un-collapse story now, so it is not incidental.
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

  /* ---------------------------------------------------------- resize tween */

  /*
   * The renderer's animation frame, used as the tween's clock. It sends one tick per rendered
   * frame while a tween is running; a tick from an older tween is ignored, so a straggler cannot
   * move the window after a newer one has started.
   */
  ipcMain.on('overlay:resize-tick', (event, token) => {
    if (!mainWindow || event.sender !== mainWindow.webContents) return;
    if (!resizeAnim || token !== resizeToken) return;
    applyResizeStep();
  });

  /* --------------------------------------------------------------- dragging */

  ipcMain.on('overlay:drag-start', (event, x, y) => {
    if (!mainWindow || event.sender !== mainWindow.webContents) return;
    const bounds = mainWindow.getBounds();
    /*
     * The cursor position comes from the renderer's `pointermove`, not from polling.
     *
     * A `setInterval` fires *near* every frame rather than on it, so the window is sometimes moved
     * twice within one frame and sometimes not at all - which reads as stutter. `pointermove` is
     * delivered in step with the compositor and carries the position as of the frame being drawn.
     */
    dragGrab = { x: Number(x) - bounds.x, y: Number(y) - bounds.y };
    // Captured once, so the size can never be fed back to itself while the drag runs.
    dragSize = { width: bounds.width, height: bounds.height };
    dragSizeMismatch = false;
    dragMoved = false;
    dragLastAt = Date.now();
    // Displays do not change mid-drag, and `getDisplayMatching` is a synchronous query on the
    // cursor path - the one place where an extra millisecond is visible.
    dragWorkArea = workAreaForWindow();
    stopResizeTween();
  });

  ipcMain.on('overlay:drag-move', (event, x, y) => {
    if (!mainWindow || !dragGrab || !dragSize || event.sender !== mainWindow.webContents) return;
    const bounds = mainWindow.getBounds();
    /*
     * Report a size the OS gave back that is not the one we are asking for.
     *
     * The size argument is captured at the press and re-asserted every move, so `bounds` should
     * match it exactly. When it does not, something outside this process is resizing the window -
     * a display change mid-drag being the obvious candidate - and the card would visibly change
     * size under the user. Logged once per drag: the point is to name the cause, not to flood.
     */
    if (!dragSizeMismatch && (bounds.width !== dragSize.width || bounds.height !== dragSize.height)) {
      dragSizeMismatch = true;
      console.warn(
        `[shell] 拖动中窗口尺寸被系统改动: 请求 ${dragSize.width}x${dragSize.height}，实际 ${bounds.width}x${bounds.height}`,
      );
    }
    const target = dragTarget(
      { x: Number(x), y: Number(y) },
      dragGrab,
      dragSize,
      dragWorkArea ?? workAreaForWindow(),
    );
    if (target.x === bounds.x && target.y === bounds.y) return;
    dragMoved = true;
    dragLastAt = Date.now();
    mainWindow.setBounds({ x: target.x, y: target.y, ...dragSize }, false);
  });

  ipcMain.on('overlay:drag-end', (event) => {
    if (!mainWindow || event.sender !== mainWindow.webContents) return;
    endDrag('renderer');
  });

  // A renderer that goes away mid-drag must not leave the gesture (and with it the suppression
  // of auto-collapse) open.
  mainWindow?.webContents.on('render-process-gone', () => endDrag('render-process-gone'));
}

/**
 * Forget an in-flight drag.
 *
 * A drag that never ends leaves `dragGrab` set, and the pointer watcher skips every tick while a
 * drag is open - so the card would silently stop rolling up altogether. That failure mode has
 * already cost this project a round, so a stale drag is dropped rather than trusted.
 *
 * The window's size was captured at the press and is never read back, so it should be identical
 * here. If it is not, something else resized the window mid-drag, which is worth saying out loud:
 * "the card grows while I drag it" is otherwise impossible to attribute from the outside.
 */
function endDrag(reason) {
  if (!dragGrab) return;
  dragGrab = null;
  dragWorkArea = null;
  // The pointer is inside the window at the end of a drag, so only a brief grace period is needed;
  // the roll-up then follows the ordinary rule.
  suppressUntil = Date.now() + DRAG_SETTLE_MS;

  if (mainWindow && !mainWindow.isDestroyed() && dragSize) {
    const bounds = mainWindow.getBounds();
    if (bounds.width !== dragSize.width || bounds.height !== dragSize.height) {
      console.warn(
        `[shell] 拖动期间窗口尺寸被改动: ${dragSize.width}x${dragSize.height} -> ${bounds.width}x${bounds.height}`,
      );
    }
  }
  dragSize = null;

  if (dragMoved) {
    persistWindowState();
    console.info(`[shell] 拖动结束（${reason}）`);
  }
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

    bindIpc();
    reportUiAssets();
    /*
     * The window comes up straight away, showing the startup page, and the tray and the pointer
     * watcher with it. Everything that can be slow - waiting for the host - happens after, so the
     * app is visibly alive instead of showing Windows' "starting" cursor over nothing.
     *
     * The watcher is started before the window and the tray on purpose: it only stores a timer,
     * so nothing that follows can prevent it from existing.
     */
    startHoverWatch();
    createWindow();

    try {
      createTray();
    } catch (err) {
      console.error('[shell] 托盘创建失败（收起/展开不受影响）', err);
    }

    const ready = hostError ? false : await waitForUi();
    if (!ready) {
      // Still load the UI: it shows a clear "not connected" state, which is more useful than
      // leaving the startup page up forever. A host already on the port is a normal cause - a
      // leftover one from an earlier run - and the window simply talks to that instead.
      console.error(`[shell] 界面服务未就绪 (${UI_URL})，仍加载界面以显示状态`);
    }
    await loadUi();

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
  stopResizeTween();
  stopHost();
});
