#!/usr/bin/env node
// Learn how the client's *own* controls do what the card needs to do, by using them
// and recording the actions they dispatch.
//
//   node tools/probe-client-ui.mjs baseline
//   node tools/probe-client-ui.mjs mode          # click the client's mode button once
//   node tools/probe-client-ui.mjs hover-volume  # hover the volume button, dump what appears
//   node tools/probe-client-ui.mjs drag-volume 0.3
//   node tools/probe-client-ui.mjs seek 0.5
//   node tools/probe-client-ui.mjs restore       # put mode and volume back
//
// *** This tool MOVES THE USER'S PLAYBACK. *** It drives the real client through CDP
// `Input` events - the same events a mouse produces - because that is the only way to
// learn what the client itself dispatches. It records `store.dispatch` while doing so,
// so the answer is a measurement rather than a reading of the minified bundle.
//
// Three questions, none of which can be answered by guessing:
//
//   1. play mode  - which action carries it, and what is the payload called;
//   2. volume     - the store field is `playing.playingVolume`, but writing the field
//                   is not the same as changing the volume;
//   3. position   - `audioplayer.seek` exists but takes `(playId, seekId, value)` and
//                   nothing on disk says what `value` is measured in.
//
// The baseline is stashed in the page (`window.__moProbeBase`) so `restore` can undo
// the mode and volume changes. Playback position is restored too, to the second.

import { connectToNeteasePage, diagnoseChannel, DEFAULT_CDP_PORT } from './lib/cdp-client.mjs';
import { bootstrapRequireExpression, discoverDvaExpression } from './lib/inject.mjs';
import { resolveStoreExpression } from './lib/probe.mjs';

function parseArgs(argv) {
  const out = { port: DEFAULT_CDP_PORT, step: 'baseline', value: null };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port') out.port = Number(argv[++i]);
    else if (a.startsWith('--port=')) out.port = Number(a.slice(7));
    else rest.push(a);
  }
  out.step = rest[0] ?? 'baseline';
  out.value = rest[1] != null ? Number(rest[1]) : null;
  out.rest = rest;
  return out;
}

const args = parseArgs(process.argv.slice(2));
const diagnosis = await diagnoseChannel({ port: args.port });
if (diagnosis.state !== 'ready') {
  console.error(`通道不可用（状态: ${diagnosis.state}）。先运行: node tools/probe-cdp.mjs`);
  process.exit(1);
}

const session = await connectToNeteasePage({ port: args.port });
const page = (expr, awaitPromise = false) => session.evaluate(expr, { awaitPromise });

/** Real mouse input, through the browser's own pipeline rather than a synthetic event. */
async function mouse(type, x, y, buttons = 0) {
  await session.send('Input.dispatchMouseEvent', {
    type,
    x: Math.round(x),
    y: Math.round(y),
    button: type === 'mouseMoved' ? 'none' : 'left',
    buttons,
    clickCount: type === 'mouseMoved' ? 0 : 1,
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function click(x, y) {
  await mouse('mouseMoved', x, y, 0);
  await sleep(40);
  await mouse('mousePressed', x, y, 1);
  await sleep(60);
  await mouse('mouseReleased', x, y, 0);
}

async function drag(fromX, fromY, toX, toY, steps = 8) {
  await mouse('mouseMoved', fromX, fromY, 0);
  await sleep(40);
  await mouse('mousePressed', fromX, fromY, 1);
  await sleep(60);
  for (let i = 1; i <= steps; i++) {
    const f = i / steps;
    await mouse('mouseMoved', fromX + (toX - fromX) * f, fromY + (toY - fromY) * f, 1);
    await sleep(30);
  }
  await mouse('mouseReleased', toX, toY, 0);
}

/** Arm the dispatch recorder if it is not already armed. */
async function armTap() {
  return page(`(() => {
    const store = window.__moStore;
    if (!store) return { ok: false, reason: 'no store' };
    if (window.__moTapArmed) return { ok: true, already: true };
    const orig = store.dispatch;
    window.__moDisp = window.__moDisp || { actions: [] };
    store.dispatch = function (action) {
      try {
        const a = action || {};
        if (window.__moDisp.actions.length < 3000) {
          let payload = null;
          try {
            payload = a.payload && typeof a.payload === 'object'
              ? JSON.parse(JSON.stringify(a.payload, (k, v) => (typeof v === 'function' ? '[fn]' : v)))
              : a.payload;
          } catch (_) { payload = '[unserializable]'; }
          window.__moDisp.actions.push({ t: Date.now(), type: String(a.type), payload });
        }
      } catch (_) {}
      return orig.apply(this, arguments);
    };
    window.__moTapArmed = true;
    return { ok: true };
  })()`);
}

/** The recorded actions since the last clear. */
async function drainTap() {
  return page(`(() => {
    const d = window.__moDisp;
    if (!d) return { ok: false, reason: 'not armed' };
    const out = d.actions.slice();
    d.actions = [];
    return { ok: true, actions: out };
  })()`);
}

async function clearTap() {
  return page('(() => { if (!window.__moDisp) return { ok: false }; window.__moDisp.actions = []; return { ok: true }; })()');
}

const READ_STATE = `(() => {
  const store = window.__moStore;
  const p = (store && store.getState().playing) || {};
  return {
    mode: p.playingMode ?? null,
    lastMode: p.lastPlayingMode ?? null,
    volume: p.playingVolume ?? null,
    muteVolume: p.muteVolume ?? null,
    playingState: p.playingState ?? null,
    songId: (p.curPlaying && p.curPlaying.resourceId) || p.resourceTrackId || null,
    songName: p.resourceName ?? null,
    positionSec: p.playingPosition ?? p.position ?? null,
  };
})()`;

/** The client's own mode button: it is the footer icon whose tooltip names the mode. */
const MODE_BUTTON = `(() => {
  const RE = /^(随机播放|单曲循环|列表循环|顺序播放|播放模式|心动模式)/;
  const all = document.querySelectorAll('footer [title], footer [class*="icon"]');
  for (const el of all) {
    const title = el.getAttribute('title') || el.getAttribute('aria-label') || '';
    if (!RE.test(title)) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 8 || r.height < 8) continue;
    return { ok: true, title, cls: String(el.className).slice(0, 80), x: r.x + r.width / 2, y: r.y + r.height / 2, rect: [r.x, r.y, r.width, r.height] };
  }
  return { ok: false, reason: 'mode button not found' };
})()`;

/** The volume icon in the footer, skipping the hidden vinyl-mode copy at 0,0. */
const VOLUME_BUTTON = `(() => {
  const all = document.querySelectorAll('footer [class*="cmd-icon-Volume"], footer [title="静音"], footer [title*="音量"]');
  for (const el of all) {
    const r = el.getBoundingClientRect();
    if (r.width < 8 || r.height < 8) continue;
    return { ok: true, cls: String(el.className).slice(0, 90), title: el.getAttribute('title') || '', x: r.x + r.width / 2, y: r.y + r.height / 2, rect: [r.x, r.y, r.width, r.height] };
  }
  return { ok: false, reason: 'volume button not found' };
})()`;

/** The playback progress bar: the full-width slider along the top of the footer. */
const PROGRESS_BAR = `(() => {
  const footer = document.querySelector('footer');
  if (!footer) return { ok: false, reason: 'no footer' };
  let best = null;
  for (const el of footer.querySelectorAll('[class*="slider"], [class*="Slider"], [class*="progress"], [class*="Progress"]')) {
    const r = el.getBoundingClientRect();
    if (r.width < 200 || r.height < 1 || r.height > 16) continue;
    if (!best || r.width > best.rect[2]) best = { cls: String(el.className).slice(0, 90), rect: [r.x, r.y, r.width, r.height] };
  }
  if (!best) return { ok: false, reason: 'progress bar not found' };
  const [x, y, w, h] = best.rect;
  return { ok: true, cls: best.cls, rect: best.rect, x, y: y + h / 2, width: w };
})()`;

/** Everything that looks like a slider in the app, with geometry - for the popup hunt. */
const SLIDER_INVENTORY = `(() => {
  const out = [];
  for (const el of document.querySelectorAll('div,span,input')) {
    const cls = typeof el.className === 'string' ? el.className : '';
    if (!/slider|Slider/.test(cls)) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 4 || r.height < 4) continue;
    out.push({
      cls: cls.slice(0, 90),
      rect: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)],
      parentCls: String(el.parentElement && el.parentElement.className || '').slice(0, 60),
      style: (el.getAttribute('style') || '').slice(0, 80),
    });
    if (out.length >= 20) break;
  }
  return { ok: true, sliders: out };
})()`;

/**
 * Stash the audio module (the one publishing the progress stream).
 *
 * The store has no position field, so the playhead has to come from the client's own
 * progress observable - the same one the bridge subscribes to.
 */
const FIND_AUDIO = `(() => {
  if (window.__moAudioMod) return { ok: true, cached: true };
  const require = window.__moRequire;
  if (typeof require !== 'function') return { ok: false, reason: 'no require' };
  for (const id of Object.keys(require.c || {})) {
    let mod;
    try { mod = require(id); } catch (_) { continue; }
    if (mod && mod.audioPlayerPlayProgress$ && typeof mod.audioPlayerPlayProgress$.subscribe === 'function') {
      window.__moAudioMod = mod;
      return { ok: true, moduleId: id };
    }
  }
  return { ok: false, reason: 'audio module not found' };
})()`;

/** The current playhead: [playId, seconds, state] from the client's own stream. */
const PROGRESS_NOW = `(() => new Promise((resolve) => {
  const stream = window.__moAudioMod && window.__moAudioMod.audioPlayerPlayProgress$;
  if (!stream) return resolve({ ok: false, reason: 'no stream' });
  let done = false;
  const finish = (value) => { if (!done) { done = true; resolve(value); } };
  const sub = stream.subscribe((v) => {
    if (Array.isArray(v) && v.length >= 2) finish({ ok: true, playId: v[0], seconds: v[1], state: v[2] });
  });
  setTimeout(() => finish({ ok: false, reason: 'no emission' }), 1500);
  setTimeout(() => { try { sub.unsubscribe(); } catch (_) {} }, 100);
}))()`;

/**
 * Record what the client itself passes to the native player.
 *
 * The slider paths dispatch nothing a store tap can see, so the wrapper on the
 * AudioPlayer instance is the only place their arguments are observable. Wrapping it
 * on the instance shadows the prototype method, and the recorded call is the client's
 * own - not a guess about units.
 */
const TAP_INSTALL = `(() => {
  const ap = window.__moAP;
  if (!ap) return { ok: false, reason: 'no AudioPlayer' };
  if (window.__moApTap) return { ok: true, already: true };
  const tap = { calls: [] };
  window.__moApTap = tap;
  for (const name of ['seek', 'setVolume', 'getPlayedTime', 'getPlaybackInfo', 'play', 'pause', 'resumePlay']) {
    const original = ap[name];
    if (typeof original !== 'function') continue;
    ap[name] = function () {
      try {
        const args = Array.prototype.slice.call(arguments).map((v) => {
          if (v === null || typeof v !== 'object') return v;
          try { return JSON.parse(JSON.stringify(v, (k, val) => (typeof val === 'function' ? '[fn]' : val))); }
          catch (_) { return '[object]'; }
        });
        if (tap.calls.length < 200) tap.calls.push({ t: Date.now(), name, args });
      } catch (_) {}
      return original.apply(this, arguments);
    };
  }
  return { ok: true, methods: Object.keys(ap).length };
})()`;

const TAP_DUMP = `(() => {
  const tap = window.__moApTap;
  if (!tap) return { ok: false, reason: 'not installed' };
  const out = tap.calls.slice();
  tap.calls = [];
  return { ok: true, calls: out };
})()`;

/**
 * Stash the audio wrapper so its own getters can be called.
 *
 * `getApplicationVolume` is what makes an experiment possible: without a way to read
 * the *native* volume back, "the store field changed" and "the volume changed" are
 * indistinguishable - and that distinction is the whole question for volume.
 */
const FIND_AP = `(() => {
  if (window.__moAP) return { ok: true, cached: true };
  const require = window.__moRequire;
  if (typeof require !== 'function') return { ok: false, reason: 'no require' };
  for (const id of Object.keys(require.c || {})) {
    let mod;
    try { mod = require(id); } catch (_) { continue; }
    if (mod && mod.AudioPlayer && typeof mod.AudioPlayer.setVolume === 'function') {
      window.__moAP = mod.AudioPlayer;
      return { ok: true, moduleId: id };
    }
  }
  return { ok: false, reason: 'AudioPlayer not found' };
})()`;

/** The store's volume next to the native player's own, which is the one that matters. */
const VOLUME_READ = `(async () => {
  const store = window.__moStore;
  const p = (store && store.getState().playing) || {};
  const out = { store: p.playingVolume ?? null, muteVolume: p.muteVolume ?? null, app: null, master: null, err: null };
  try { out.app = await window.__moAP.getApplicationVolume(); } catch (e) { out.err = String(e && e.message || e); }
  try { out.master = await window.__moAP.getSystemMasterVolume(); } catch (_) {}
  return out;
})()`;

try {
  await page(bootstrapRequireExpression());
  await page(discoverDvaExpression());
  await page(resolveStoreExpression());
  const armed = await armTap();

  const report = { step: args.step, armed };
  report.audioPlayer = args.step.startsWith('volume') ? await page(FIND_AP) : null;

  if (args.step === 'tap-install') {
    report.ap = await page(FIND_AP);
    report.audio = await page(FIND_AUDIO);
    report.installed = await page(TAP_INSTALL);
  } else if (args.step === 'tap-dump') {
    report.calls = await page(TAP_DUMP);
    report.progress = await page(PROGRESS_NOW, true);
  } else if (args.step === 'progress-now') {
    report.audio = await page(FIND_AUDIO);
    report.progress = await page(PROGRESS_NOW, true);
  } else if (args.step === 'baseline') {
    report.state = await page(READ_STATE);
    report.saved = await page(
      `(() => { window.__moProbeBase = ${READ_STATE}; return window.__moProbeBase; })()`,
    );
    report.modeButton = await page(MODE_BUTTON);
    report.volumeButton = await page(VOLUME_BUTTON);
    report.progressBar = await page(PROGRESS_BAR);
  } else if (args.step === 'mode') {
    const before = await page(READ_STATE);
    const button = await page(MODE_BUTTON);
    if (!button?.ok) {
      report.error = button;
    } else {
      await clearTap();
      await click(button.x, button.y);
      await sleep(400);
      report.button = button;
      report.before = before;
      report.after = await page(READ_STATE);
      report.dispatched = await drainTap();
      // The tooltip is the label: it changes with the mode, which is how the four
      // modes and their Chinese names get tied together.
      report.buttonAfter = await page(MODE_BUTTON);
    }
  } else if (args.step === 'hover-volume') {
    const button = await page(VOLUME_BUTTON);
    if (!button?.ok) {
      report.error = button;
    } else {
      await page('(() => { window.__moSeen = document.querySelectorAll("*").length; return window.__moSeen; })()');
      await mouse('mouseMoved', button.x, button.y, 0);
      await sleep(500);
      report.button = button;
      report.inventory = await page(SLIDER_INVENTORY);
      report.volumePopups = await page(`(() => {
        const out = [];
        // A volume popup is a container with a slider inside it, near the volume icon.
        for (const el of document.querySelectorAll('div')) {
          const r = el.getBoundingClientRect();
          if (r.width < 20 || r.height < 30 || r.height > 200) continue;
          if (r.y > ${Math.round(button.y)} + 20) continue;
          if (Math.abs((r.x + r.width / 2) - ${Math.round(button.x)}) > 120) continue;
          const inner = el.querySelector('[class*="slider"], [class*="Slider"]');
          if (!inner) continue;
          const ir = inner.getBoundingClientRect();
          out.push({
            cls: String(el.className).slice(0, 80),
            rect: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)],
            innerCls: String(inner.className).slice(0, 80),
            innerRect: [Math.round(ir.x), Math.round(ir.y), Math.round(ir.width), Math.round(ir.height)],
          });
          if (out.length >= 6) break;
        }
        return { ok: true, popups: out };
      })()`);
    }
  } else if (args.step === 'drag-volume') {
    const target = args.value ?? 0.3;
    const button = await page(VOLUME_BUTTON);
    const before = await page(READ_STATE);
    await mouse('mouseMoved', button.x, button.y, 0);
    await sleep(500);
    // The slider the popup made: vertical, just above the volume icon.
    const slider = await page(`(() => {
      let best = null;
      for (const el of document.querySelectorAll('[class*="slider"], [class*="Slider"]')) {
        const r = el.getBoundingClientRect();
        if (r.width < 4 || r.height < 40) continue;
        if (r.y > ${Math.round(button.y)}) continue;
        if (Math.abs((r.x + r.width / 2) - ${Math.round(button.x)}) > 150) continue;
        if (!best || r.height > best.rect[3]) best = { cls: String(el.className).slice(0, 90), rect: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)] };
      }
      return best ? { ok: true, ...best } : { ok: false, reason: 'no vertical slider above the volume icon' };
    })()`);
    report.button = button;
    report.before = before;
    report.slider = slider;
    if (slider?.ok) {
      const [sx, sy, sw, sh] = slider.rect;
      const cx = sx + sw / 2;
      // Volume sliders are bottom-up: 0 at the bottom.
      const fromY = sy + sh - 2;
      const toY = sy + sh - sh * target;
      await clearTap();
      await drag(cx, fromY, cx, toY);
      await sleep(400);
      report.after = await page(READ_STATE);
      report.dispatched = await drainTap();
    }
  } else if (args.step === 'seek') {
    const target = args.value ?? 0.5;
    const bar = await page(PROGRESS_BAR);
    await page(FIND_AUDIO);
    report.bar = bar;
    report.before = await page(READ_STATE);
    report.progressBefore = await page(PROGRESS_NOW, true);
    if (bar?.ok) {
      const fromX = bar.x + bar.width * 0.1;
      const toX = bar.x + bar.width * target;
      await clearTap();
      await drag(fromX, bar.y, toX, bar.y, 10);
      await sleep(700);
      report.after = await page(READ_STATE);
      report.progressAfter = await page(PROGRESS_NOW, true);
      report.dispatched = await drainTap();
      report.apCalls = await page(TAP_DUMP);
    }
  } else if (args.step === 'seek-direct') {
    /*
     * The call the card will make: the same wrapper, the same argument shape, with the
     * play id taken from the client's own progress stream. The reply carries a `code`
     * and the resulting `position`, which is a real receipt - unlike a boolean saying
     * the command "ran".
     */
    const seconds = args.value ?? 60;
    await page(FIND_AP);
    await page(FIND_AUDIO);
    const before = await page(PROGRESS_NOW, true);
    report.before = before;
    report.called = await page(
      `(async () => {
        const playId = ${JSON.stringify(before?.playId ?? null)};
        if (!playId) return { ok: false, reason: 'no playId' };
        const songId = String(playId).split('_')[0];
        const seekId = songId + '|seek|' + Math.random().toString(36).slice(2, 8).toUpperCase();
        const reply = await window.__moAP.seek({ playId, seekId, value: ${seconds} });
        return { ok: true, playId, seekId, value: ${seconds}, reply };
      })()`,
      true,
    );
    await sleep(800);
    report.after = await page(PROGRESS_NOW, true);
  } else if (args.step === 'volume-read') {
    report.before = await page(VOLUME_READ, true);
  } else if (args.step === 'volume-dispatch') {
    /*
     * Try an action *by name*. `playing/setVolume` turned out to be a reducer that
     * writes the store and leaves the native volume alone, which is exactly the sort of
     * thing that cannot be told apart from a working control without reading the native
     * value back - so every candidate is tried this way.
     */
    const type = args.rest[2] ?? 'playing/setVolume';
    const target = args.value ?? 0.35;
    report.type = type;
    report.before = await page(VOLUME_READ, true);
    report.dispatched = await page(`(() => {
      window.__moStore.dispatch({ type: ${JSON.stringify(type)}, payload: { volume: ${target} } });
      return { ok: true };
    })()`);
    await sleep(700);
    report.after = await page(VOLUME_READ, true);
  } else if (args.step === 'volume-direct') {
    const target = args.value ?? 0.42;
    report.before = await page(VOLUME_READ, true);
    report.called = await page(
      `(async () => { await window.__moAP.setVolume(${target}); return { ok: true }; })()`,
      true,
    );
    await sleep(700);
    report.after = await page(VOLUME_READ, true);
  } else if (args.step === 'mode-dispatch') {
    /*
     * The client's own mode button changes `playingMode` without dispatching anything a
     * `store.dispatch` tap can see, so the only way to find the action is to try one and
     * read the result: the mode icon in the client's own footer is rendered from the
     * store, so its tooltip is the receipt.
     */
    const mode = args.rest[1] ?? 'playCycle';
    const last = args.rest[2] ?? null;
    report.before = await page(READ_STATE);
    report.dispatched = await page(`(() => {
      const payload = { playingMode: ${JSON.stringify(mode)} };
      ${last ? `payload.lastPlayingMode = ${JSON.stringify(last)};` : ''}
      window.__moStore.dispatch({ type: 'playing/onUpdate', payload });
      return { ok: true, payload };
    })()`);
    await sleep(500);
    report.after = await page(READ_STATE);
    report.buttonAfter = await page(MODE_BUTTON);
  } else if (args.step === 'volume-action') {
    const target = args.value ?? 0.35;
    report.before = await page(VOLUME_READ, true);
    report.dispatched = await page(`(() => {
      window.__moStore.dispatch({ type: 'playing/setVolume', payload: { volume: ${target} } });
      return { ok: true };
    })()`);
    await sleep(700);
    report.after = await page(VOLUME_READ, true);
  } else if (args.step === 'restore') {
    const base = await page('(() => window.__moProbeBase || null)()');
    report.base = base;
    if (base?.mode) {
      // Click until the tooltip says the mode is back.
      for (let i = 0; i < 6; i++) {
        const state = await page(READ_STATE);
        if (state?.mode === base.mode) break;
        const button = await page(MODE_BUTTON);
        if (!button?.ok) break;
        await click(button.x, button.y);
        await sleep(350);
      }
      report.modeNow = (await page(READ_STATE))?.mode ?? null;
    }
    if (typeof base?.volume === 'number') {
      /*
       * Straight to the wrapper, not through the store.
       *
       * `playing/setVolume` writes `playing.playingVolume` and leaves the native volume
       * untouched - measured by reading `getApplicationVolume` back and by the fact that
       * the client's own slider dispatches nothing at all. Restoring through the action
       * would therefore "restore" only the number the card displays.
       */
      await page(FIND_AP);
      report.volumeRestored = await page(
        `(async () => { await window.__moAP.setVolume(${base.volume}); return { ok: true }; })()`,
        true,
      );
      await sleep(600);
      report.volumeNow = (await page(READ_STATE))?.volume ?? null;
      report.volumeNative = await page('(async () => window.__moAP.getApplicationVolume())().catch(() => null)', true);
    }
    report.state = await page(READ_STATE);
  }

  console.log(JSON.stringify(report, null, 2));
} finally {
  session.close();
}
