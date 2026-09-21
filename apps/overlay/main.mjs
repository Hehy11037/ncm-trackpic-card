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

import { app, BrowserWindow, Menu, Tray, dialog, ipcMain, nativeImage, screen, shell } from 'electron';
import { execFile, spawn } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CARD_WIDTH_MAX,
  CARD_WIDTH_MIN,
  CARD_WIDTH_PRESETS,
  DEFAULT_WIDTH,
  MAX_WIDTH,
  MIN_WIDTH,
  CLIENT_IMAGE_NAMES,
  cardRect,
  cardWidthForWindow,
  clamp,
  clientDebugArgs,
  findClientExe,
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

/* ----------------------------------------------------------------------- log */

/*
 * A packaged Windows app has no console, so `console.error` about a failed start goes nowhere - which
 * is why the first install showed "正在启动…" for ever and nothing else. Everything the shell prints is
 * therefore *also* appended to a log beside the state file, including the renderer's own console
 * messages and any failed page load.
 *
 * Overridden rather than routed through a `log()` helper on purpose: there are dozens of `console.*`
 * calls already, and a helper would only capture the ones someone remembered to convert.
 */
function logFilePath() {
  return join(app.getPath('userData'), 'overlay.log');
}

/**
 * When this build was written, for the log header.
 *
 * The version number alone could not tell two builds apart: 0.1.1 was bumped once and then several
 * rounds of fixes were committed under it, so the owner installed an "0.1.1" that predated every fix
 * they had just been told about. The exe's own timestamp is the one fingerprint that survives being
 * copied into an installer, and it costs one `statSync`.
 */
function buildStamp() {
  try {
    return statSync(process.execPath).mtime.toISOString().slice(0, 16).replace('T', ' ');
  } catch {
    return '未知';
  }
}

function startLogging() {
  const file = logFilePath();
  try {
    // One file per run, with the previous run kept - two runs are usually enough to compare.
    if (existsSync(file)) renameSync(file, `${file}.1`);
    appendFileSync(
      file,
      `\n=== ${new Date().toISOString()}  version ${app.getVersion()}  packaged ${app.isPackaged}` +
      `  built ${buildStamp()} ===\n`,
      'utf8',
    );
  } catch (err) {
    console.warn('[shell] 无法写日志文件（继续运行）', err);
  }
  for (const level of ['log', 'info', 'warn', 'error']) {
    const original = console[level].bind(console);
    console[level] = (...args) => {
      original(...args);
      try {
        const line = args
          .map((value) => (value instanceof Error ? (value.stack ?? value.message) : String(value)))
          .join(' ');
        appendFileSync(file, `${new Date().toISOString()} ${level.toUpperCase()} ${line}\n`, 'utf8');
      } catch {
        // A failed log write must never take the app down with it.
      }
    };
  }
}

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

/** Fallback icon colour: the shipped icon's red, so a missing file still looks like the app. */
const ICON_COLOR = { r: 0xd1, g: 0x2a, b: 0x22 };

/**
 * The app icon, as a `NativeImage`.
 *
 * `Tray` and `BrowserWindow.icon` want a NativeImage or a file path - handing them the raw PNG
 * buffer throws `Argument must be a file path or a NativeImage`. That throw happened inside
 * `createTray()`, which ran in the middle of startup and therefore silently skipped everything
 * after it, including `startHoverWatch()`. Hence "the card never rolls up".
 *
 * It now loads the *shipped* icon - `assets/icon.ico`, written by `tools/make-icon.mjs` - so the tray,
 * the taskbar and a future installer all show the same mark. The in-memory drawing stays as the
 * fallback: a missing file must not cost the tray again.
 *
 * The .ico is handed over *unresized*: it carries 16/20/24/32/40/48/64/128/256 pixel art, and letting
 * Windows pick the frame it wants is sharper than resampling the 256 one down. `size` is therefore
 * only used by the fallback path.
 */
function iconImage(size) {
  const icoPath = join(ROOT, 'assets', 'icon.ico');
  if (existsSync(icoPath)) {
    const image = nativeImage.createFromPath(icoPath);
    if (!image.isEmpty()) return image;
    console.warn(`[shell] 读不出 ${icoPath}，改用内存绘制的图标`);
  }
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

/*
 * Start logging before anything else can fail: every `console.*` from here on lands in the file as well
 * as the console, which is the only way a packaged app's start-up can be diagnosed after the fact.
 */
startLogging();

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

  /*
   * The child's output goes through `console`, not `process.stdout.write`.
   *
   * That distinction cost a whole round: a packaged Windows GUI app has no stdout, so the host's
   * `ERR_MODULE_NOT_FOUND` - the entire reason the app could not start - was written into nowhere while
   * the log filled up with "宿主退出，代码 1" and nothing else. `console` is patched to the log file.
   */
  hostProcess.stdout?.on('data', (chunk) => {
    for (const line of String(chunk).split('\n')) if (line.trim()) console.log(`[host] ${line}`);
  });
  hostProcess.stderr?.on('data', (chunk) => {
    for (const line of String(chunk).split('\n')) if (line.trim()) console.error(`[host] ${line}`);
  });
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
   * as the panel sliding up rather than the window jumping.
   *
   * The clamp keeps `KEEP_VISIBLE` pixels of the *card* reachable rather than pinning the whole window
   * inside the screen: a floating card is expected to be draggable most of the way off an edge, and
   * clamping the window (which carries the shadow margin) was what stopped it getting near the edge at
   * all. The minimum is what keeps a card hanging off the top recoverable: enough of it, and of the
   * rolled-up strip, stays where a pointer can reach it.
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
    coverEnabled: cover.enabled,
    autoStartApplied,
  });
}

/* --------------------------------------------------------------- auto-start */

/*
 * Start with Windows, once, and only for a real install.
 *
 * A mirror of what is playing is only useful if it is there when the music starts, so the first launch
 * after an install turns auto-start on and records that it did. The latch matters: auto-start is also
 * editable in Windows' own startup settings, and an app that kept re-enabling itself every launch would
 * be fighting its own user.
 *
 * Two cases where it must not happen at all:
 *
 *  - **Development** (`app.isPackaged` is false under `electron apps/overlay`): a checkout must not
 *    register itself to run at login.
 *  - **The portable build.** It unpacks itself into a temporary directory per run, and that directory
 *    is gone by the next boot, so a startup entry would point at a path that no longer exists - a broken
 *    entry in the user's startup list, created by us. electron-builder's portable target marks itself
 *    with `PORTABLE_EXECUTABLE_DIR`, and the README promises this behaviour, so it is checked here
 *    rather than assumed.
 */
let autoStartApplied = false;

/** True when running from electron-builder's portable target, which unpacks to a temp directory. */
function isPortableRun(env = process.env) {
  return typeof env.PORTABLE_EXECUTABLE_DIR === 'string' && env.PORTABLE_EXECUTABLE_DIR.length > 0;
}

function applyAutoStartOnce() {
  if (!app.isPackaged || autoStartApplied) return;
  if (isPortableRun()) {
    autoStartApplied = true;
    persistWindowState();
    console.info('[shell] 免安装版：不设置开机自启（每次运行都会解包到临时目录）');
    return;
  }
  try {
    app.setLoginItemSettings({ openAtLogin: true, path: process.execPath });
    autoStartApplied = true;
    persistWindowState();
    console.info('[shell] 已设置为开机自启（可在 Windows 启动项里关掉）');
  } catch (err) {
    console.warn('[shell] 设置开机自启失败', err);
  }
}

/* ------------------------------------------------------- the NetEase client */

/*
 * Restarting the client with its debug channel open.
 *
 * The overlay only exists because the client's loopback debug port is open, and that port opens at
 * *launch*. If the client was started any other way - the Start menu, the updater, Windows itself -
 * nothing the overlay does can help except restarting it, which is why "the card cannot find the
 * client" is such a common first run.
 *
 * Killing someone's music is a big thing to do unprompted, so this never runs on its own: the card
 * shows a button when the host reports the channel is missing, and pressing it is what gets here.
 * `tools/relaunch-ncm.ps1` does the same three steps for anyone who would rather run it by hand.
 */
const RESTART_SETTLE_MS = 900;

function stopClientProcesses() {
  for (const image of CLIENT_IMAGE_NAMES) {
    /*
     * `taskkill` rather than a process API: the client is a Windows app with a helper process, and
     * `/IM` is the reliable way to catch both without a process walk. Failure is expected when it is
     * not running, and `stdio: 'ignore'` keeps a fast-exiting child from ever blocking on a pipe.
     */
    execFile('taskkill', ['/IM', image, '/F'], { stdio: 'ignore', windowsHide: true }, () => {});
  }
}

/** @returns {Promise<{ok: boolean, message: string}>} what the card should say */
async function restartClient() {
  const exe = findClientExe(process.env, existsSync);
  if (!exe) {
    console.warn('[shell] 没找到网易云客户端，无法带通道启动');
    return { ok: false, message: '没找到网易云客户端，请手动启动' };
  }

  stopClientProcesses();
  // The port has to be released before the new process can bind it; 900ms is what the PowerShell
  // script's Start-Sleep uses, and it has not been seen to fail.
  await new Promise((resolve) => setTimeout(resolve, RESTART_SETTLE_MS));

  try {
    const child = spawn(exe, clientDebugArgs(CDP_PORT), { detached: true, stdio: 'ignore' });
    child.unref();
  } catch (err) {
    console.warn('[shell] 启动客户端失败', err);
    return { ok: false, message: '启动客户端失败，请看终端日志' };
  }

  console.info(`[shell] 已带同步通道启动客户端：${exe} ${clientDebugArgs(CDP_PORT).join(' ')}`);
  return { ok: true, message: '正在启动客户端…' };
}

/* -------------------------------------------------------------- custom cover */
/*
 * The user's own cover: a picture kept beside the state file, which temporarily stands in for whatever
 * the client says the song's cover is.
 *
 * Held here rather than in the host because it is a *presentation* choice - the client's cover is still
 * mirrored faithfully, and switching this off puts it straight back. The image is stored as a file plus
 * an enabled flag, so a restart remembers the choice without the state file growing by megabytes; the
 * renderer gets it as a data URL, on request, because it cannot read a local file from an http page.
 */
const cover = { url: null, enabled: true, rev: 0 };
const COVER_MAX_WIDTH = 1600;

/** The kept image's path, beside the window state. */
function coverFilePath() {
  return join(app.getPath('userData'), 'custom-cover.png');
}

/** Read the kept image into memory as a data URL, if there is one. */
function loadCoverImage() {
  const file = coverFilePath();
  try {
    if (!existsSync(file)) {
      cover.url = null;
      return;
    }
    const bytes = readFileSync(file);
    cover.url = `data:image/png;base64,${bytes.toString('base64')}`;
  } catch (err) {
    console.warn('[shell] 自选封面读取失败，按没有处理', err);
    cover.url = null;
  }
}

/** Tell the renderer what it needs to know; the image itself is fetched separately. */
function sendState() {
  mainWindow?.webContents.send('overlay:state', {
    locked,
    /*
     * `rev` counts replaces and clears. `has`/`enabled` are both still true when a *second* picture is
     * picked, so the renderer cannot tell "same image" from "new image" without this - and would keep
     * drawing the first one.
     */
    cover: { has: cover.url !== null, enabled: cover.enabled, rev: cover.rev },
  });
}

/**
 * Ask for a picture and keep a downscaled copy of it.
 *
 * Downscaled because a 4000px photograph is a ~12MB data URL that the card draws at ~880px: resizing
 * once here costs nothing and keeps the renderer's copy small. PNG rather than JPEG so a chosen image
 * with transparency keeps it.
 */
async function pickCover() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '选择一张图片作为封面',
    properties: ['openFile'],
    filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'ico'] }],
  });
  if (result.canceled || !result.filePaths?.length) return;

  const source = nativeImage.createFromPath(result.filePaths[0]);
  if (source.isEmpty()) {
    console.warn(`[shell] 自选封面：这不是能解码的图片 ${result.filePaths[0]}`);
    return;
  }
  const size = source.getSize();
  const chosen = size.width > COVER_MAX_WIDTH ? source.resize({ width: COVER_MAX_WIDTH, quality: 'best' }) : source;
  try {
    const png = chosen.toPNG();
    writeFileSync(coverFilePath(), png);
    cover.url = `data:image/png;base64,${png.toString('base64')}`;
    cover.enabled = true;
    cover.rev += 1;
  } catch (err) {
    console.warn('[shell] 自选封面保存失败', err);
    return;
  }
  console.info(`[shell] 自选封面已设置：${result.filePaths[0]}（${size.width}x${size.height} → ${chosen.getSize().width}px）`);
  sendState();
  persistWindowState();
}

/** Switch the chosen cover on or off. Nothing chosen yet means nothing to switch. */
function toggleCover() {
  if (!cover.url) return;
  cover.enabled = !cover.enabled;
  console.info(`[shell] 自选封面: ${cover.enabled ? '开' : '关'}`);
  sendState();
  persistWindowState();
}

/** Forget the chosen cover and go back to the song's own art. */
function clearCover() {
  try {
    rmSync(coverFilePath(), { force: true });
  } catch {
    // Losing the delete only means the file is reloaded next launch; the state is cleared anyway.
  }
  cover.url = null;
  cover.enabled = true;
  cover.rev += 1;
  console.info('[shell] 自选封面已清除');
  sendState();
  persistWindowState();
}

/**
 * "Do not auto-collapse". Owned and persisted here; the card's lock button and `L` are its only
 * controls, and they are views of this value rather than copies of it.
 */
function setLocked(next) {
  locked = next === true;
  if (locked && collapsed) setCollapsed(false);
  sendState();
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
      /*
       * The pointer is "on the card" only when it is on the **card**, not on the transparent margin the
       * window keeps for its shadow.
       *
       * That margin is 24px on every side, and testing the window's bounds counted all of it as the card:
       * the pointer could sit a finger's width outside the visible edge and the card would stay open, and
       * rolling up only began once it left the shadow too. `cardRect` insets the window by the margin, so
       * the trigger is the thing the user can actually see.
       */
      const card = cardRect(bounds);
      const inside =
        point.x >= card.x &&
        point.x < card.x + card.width &&
        point.y >= card.y &&
        point.y < card.y + card.height;

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

/**
 * What the window shows when the UI cannot be loaded.
 *
 * A packaged app has no console, so a silent failure is all the owner can see. This says what is wrong
 * and where the log is, which is the difference between "it does not work" and a diagnosis.
 */
function failurePage(detail) {
  return `data:text/html;charset=utf-8,${encodeURIComponent(
    '<!doctype html><meta charset="utf-8"><style>' +
      'html,body{margin:0;height:100%;background:rgba(12,14,18,0.86);overflow:hidden;' +
      "font:13px/1.7 system-ui,'Microsoft YaHei',sans-serif;color:#e8eef2}" +
      'body{display:grid;place-items:center;padding:0 24px}' +
      '.box{text-align:center}.why{color:#ffd9a0;margin-bottom:6px}' +
      '.where{color:#9fb1bd;font-size:11px;word-break:break-all}' +
      '</style><body><div class="box">' +
      '<div class="why">界面没能启动：' +
      detail +
      '</div><div class="where">日志：' +
      logFilePath() +
      '</div></div>',
  )}`;
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
/**
 * Load the real UI, once its server is answering.
 *
 * `dom-ready` rather than an IPC handshake from the preload: the roll-up must not depend on the
 * bridge. Attached here, and not in `createWindow`, because the window first shows the startup page -
 * and that page must not be what marks the renderer ready, or the card could roll up before the real
 * interface had ever been drawn.
 *
 * `hostReady` comes from the caller's `waitForUi` (which asks the UI server for `/config.json` - a
 * stronger question than "is the port open"). There is deliberately only *one* wait: an earlier version
 * waited here as well, which meant a host that never came up took forty seconds to say so.
 */
async function loadUi(hostReady) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.once('dom-ready', () => {
    rendererReady = true;
    suppressUntil = Date.now() + SUPPRESS_MS;
    // The renderer may have asked for the state before we could answer; a duplicate is harmless.
    sendState();
    console.info('[shell] 界面已加载，自动收起开始工作');
  });

  if (!hostReady) {
    /*
     * Say what is wrong and where the log is. A packaged app has no console, so a silent failure is all
     * the owner can see - and the first packaged build's host died on a missing module with nothing
     * anywhere to say so.
     */
    const detail = '宿主没有就绪（看日志第一行起的原因：多半是宿主进程启动即退出）';
    console.error(`[shell] ${detail}`);
    await mainWindow.loadURL(failurePage(detail));
    return;
  }

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await mainWindow.loadURL(UI_URL);
      return;
    } catch (err) {
      console.error(`[shell] 加载界面失败（第 ${attempt} 次）(${UI_URL})`, err);
      await new Promise((done) => setTimeout(done, 500));
    }
  }
  await mainWindow.loadURL(failurePage(`界面服务器在，但页面加载失败（${UI_URL}）`));
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
  cover.enabled = state.coverEnabled;
  autoStartApplied = state.autoStartApplied;
  loadCoverImage();
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
  // preload or a thrown module impossible to diagnose from the terminal - and in a packaged app,
  // impossible to diagnose at all. It goes to the log file now.
  mainWindow.webContents.on('console-message', (...args) => {
    const details =
      args[0] && typeof args[0] === 'object' && 'message' in args[0] ? args[0] : { message: args[2] };
    console.log(`[ui] ${details.message}`);
  });

  /*
   * A page that fails to load is the other half of "the card never appeared": the load itself, the
   * subresources, and the renderer dying. All three were silent in the packaged build.
   */
  mainWindow.webContents.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
    console.error(`[shell] 页面加载失败 ${isMainFrame ? '(主框架)' : ''} ${url} — ${description} (${code})`);
  });
  mainWindow.webContents.on('did-finish-load', () => {
    console.info(`[shell] 页面已加载 ${mainWindow?.webContents.getURL() ?? ''}`);
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
  tray.setToolTip('网易云同步卡片（单击显示/隐藏）');
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

  /*
   * The custom cover's three verbs. `pick-cover` is `handle` rather than `on` so the renderer can be
   * told when the dialog closed and the image is ready, which keeps the button's state honest; the
   * other two just change state and broadcast.
   */
  ipcMain.handle('overlay:pick-cover', () => pickCover());
  ipcMain.handle('overlay:cover-url', () => cover.url);

  /*
   * Restart the client with its debug channel. An `invoke`, so the button can report what
   * happened; the host says `ready` on its own once the channel answers.
   */
  ipcMain.handle('overlay:restart-client', () => restartClient());
  ipcMain.on('overlay:toggle-cover', () => toggleCover());
  ipcMain.on('overlay:clear-cover', () => clearCover());

  ipcMain.on('overlay:request-state', (event) => {
    // Answer only the window that asked, so a stale sender cannot be trusted with it.
    if (mainWindow && event.sender === mainWindow.webContents) {
      event.sender.send('overlay:state', { locked, cover: { has: cover.url !== null, enabled: cover.enabled, rev: cover.rev } });
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
    /*
     * Land the resize tween first, so the size captured below is a real one.
     *
     * `animateGeometryTo` interpolates the height while setting the target width immediately, so a
     * drag that begins mid-tween would capture a mismatched pair - the log showed `432x740`
     * requested, where 432 of width implies a height of 744. The drag then holds that pair for its
     * whole duration, which is a window with the wrong proportions until it ends.
     */
    if (resizeAnim) {
      const target = resizeAnim.target;
      stopResizeTween();
      mainWindow.setBounds(target, false);
    }
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
    // Before the window, so the state file records the latch even if a later step fails.
    applyAutoStartOnce();
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
    await loadUi(ready);

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
