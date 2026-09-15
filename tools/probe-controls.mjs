#!/usr/bin/env node
// Read-only reconnaissance for the controls the card does not have yet: play mode,
// volume, and seeking.
//
//   node tools/probe-controls.mjs [--port 9223] [--json]
//
// The card can already play/pause and skip, because those have media keys. Mode,
// volume and position have none, so they have to go through the client - and *how*
// is a question about this build, not something to guess at. This enumerates the
// three candidate routes in one pass:
//
//   1. the dva action names in the store's `@@dva` model table, filtered to the
//      names that could plausibly do the job;
//   2. the values already in the `playing` slice (`playingMode`, `playingVolume`,
//      `muteVolume`) - these say what the *shape* of a valid command is;
//   3. the client's own controls in its DOM, with their rectangles, which is the
//      fallback route: drive the button the client itself uses;
//   4. the exports of the audio pipeline module, with their arity, for the direct
//      call route.
//
// Nothing here writes to the client.

import { connectToNeteasePage, diagnoseChannel, DEFAULT_CDP_PORT } from './lib/cdp-client.mjs';
import { bootstrapRequireExpression, discoverDvaExpression } from './lib/inject.mjs';
import { resolveStoreExpression } from './lib/probe.mjs';

function parseArgs(argv) {
  const out = { port: DEFAULT_CDP_PORT, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') out.json = true;
    else if (a === '--port') out.port = Number(argv[++i]);
    else if (a.startsWith('--port=')) out.port = Number(a.slice(7));
  }
  return out;
}

/** Action names that could move one of the three controls. */
function candidateActionsExpression() {
  return `(() => {
    const store = window.__moStore;
    if (!store) return { ok: false, reason: 'no store' };
    const state = store.getState();
    const dva = state['@@dva'] || {};
    const re = /(mode|order|shuffle|repeat|volume|mute|seek|progress|position|jump|speed|rate|playlist)/i;
    const hits = Object.keys(dva).filter((k) => re.test(k)).sort();
    return { ok: true, total: Object.keys(dva).length, hits };
  })()`;
}

/** The current value of every relevant field in the playing slice, with its type. */
function playingValuesExpression() {
  return `(() => {
    const store = window.__moStore;
    if (!store) return { ok: false, reason: 'no store' };
    const playing = store.getState().playing || {};
    const re = /(mode|order|shuffle|repeat|volume|mute|speed|rate|progress|position|time)/i;
    const out = {};
    for (const key of Object.keys(playing).sort()) {
      if (!re.test(key)) continue;
      const value = playing[key];
      const t = typeof value;
      out[key] = t === 'object' && value !== null
        ? { type: Array.isArray(value) ? 'array' : 'object', keys: Object.keys(value).slice(0, 10) }
        : { type: t, value };
    }
    return { ok: true, fields: out };
  })()`;
}

/**
 * The client's own controls for the three features.
 *
 * Its DOM is where the answers are: a mode button carries its current state in a
 * class or a title, and a volume slider has the geometry a synthetic drag needs.
 */
function clientControlsExpression() {
  return `(() => {
    const out = [];
    const seen = new Set();
    const all = document.querySelectorAll('[class],[title],[data-action],[aria-label]');
    for (const el of all) {
      const cls = typeof el.className === 'string' ? el.className : '';
      const title = el.getAttribute('title') || el.getAttribute('aria-label') || '';
      const hay = cls + ' ' + title + ' ' + (el.getAttribute('data-action') || '');
      if (!/(volume|volum|mode|order|shuffle|repeat|loop|progress|slider|seek|bar)/i.test(hay)) continue;
      const rect = el.getBoundingClientRect();
      if (rect.width < 4 || rect.height < 4) continue;
      const key = cls + '|' + title + '|' + Math.round(rect.width) + 'x' + Math.round(rect.height);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        tag: el.tagName.toLowerCase(),
        cls: cls.slice(0, 90),
        title: title.slice(0, 40),
        rect: [Math.round(rect.x), Math.round(rect.y), Math.round(rect.width), Math.round(rect.height)],
      });
      if (out.length >= 40) break;
    }
    return { ok: true, controls: out };
  })()`;
}

/** Exports of the audio module that look like they set position, volume or mode. */
function audioExportsExpression(audioModuleId) {
  return `(() => {
    const require = window.__moRequire;
    if (typeof require !== 'function') return { ok: false, reason: 'no require' };
    const ids = ${JSON.stringify([audioModuleId])}.concat(['1186']);
    const re = /(seek|position|progress|volume|mute|mode|order|shuffle|repeat|speed|rate|currentTime|duration)/i;
    const out = [];
    for (const id of [...new Set(ids)]) {
      let mod;
      try { mod = require(id); } catch (_) { continue; }
      if (!mod) continue;
      for (const [name, value] of Object.entries(mod)) {
        if (!re.test(name)) continue;
        const t = typeof value;
        let arity = null;
        if (t === 'function') {
          try { arity = value.length; } catch (_) {}
        }
        out.push({ moduleId: id, name, type: t, arity });
      }
    }
    return { ok: true, exports: out.slice(0, 60) };
  })()`;
}

/**
 * The source text of the seek function.
 *
 * A function's parameters are a fact about this build that cannot be guessed, and
 * `Function.prototype.toString` is the only place it is written down when the
 * bundle is packed. Same trick as the lyric endpoint search: read, do not assume.
 */
function seekSourceExpression() {
  return `(() => {
    const require = window.__moRequire;
    if (typeof require !== 'function') return { ok: false, reason: 'no require' };
    const out = [];
    for (const id of Object.keys(require.c || {})) {
      let mod;
      try { mod = require(id); } catch (_) { continue; }
      if (!mod || typeof mod !== 'object') continue;
      for (const [name, value] of Object.entries(mod)) {
        if (typeof value !== 'function' || !/(seek|setProgress|setPosition|setCurrentTime|setVolume|setMode|switchPlayingMode)/i.test(name)) continue;
        let src = '';
        try { src = Function.prototype.toString.call(value); } catch (_) { continue; }
        out.push({ moduleId: id, name, arity: value.length, source: src.slice(0, 700) });
        if (out.length >= 14) return { ok: true, hits: out };
      }
    }
    return { ok: true, hits: out };
  })()`;
}

/**
 * Every mode literal the bundle mentions, with its surrounding text.
 *
 * The card has to show the same four modes the client does, and the client names
 * them `playOneCycle`, `playRandom`, ... The list is in the bundle, next to the
 * labels, so it is recoverable rather than guessed.
 */
function modeLiteralsExpression() {
  return `(() => {
    const require = window.__moRequire;
    if (typeof require !== 'function') return { ok: false, reason: 'no require' };
    const needles = ['playOneCycle', 'playRandom', 'playOne', 'playOrder', 'playListLoop', 'singleCycle'];
    const hits = [];
    const seen = new Set();
    const ids = Object.keys(require.c || {});
    for (const id of ids) {
      let mod;
      try { mod = require(id); } catch (_) { continue; }
      if (!mod || typeof mod !== 'object') continue;
      for (const [name, value] of Object.entries(mod)) {
        if (typeof value !== 'function') continue;
        let src = '';
        try { src = Function.prototype.toString.call(value); } catch (_) { continue; }
        for (const needle of needles) {
          let at = src.indexOf(needle);
          while (at >= 0 && hits.length < 40) {
            const excerpt = src.slice(Math.max(0, at - 70), at + 90);
            const key = needle + excerpt;
            if (!seen.has(key)) {
              seen.add(key);
              hits.push({ moduleId: id, exportName: name, needle, excerpt });
            }
            at = src.indexOf(needle, at + needle.length);
          }
        }
        if (hits.length >= 40) break;
      }
      if (hits.length >= 40) break;
    }
    return { ok: true, scanned: ids.length, hits };
  })()`;
}

/**
 * The client's playback progress bar and volume slider, found by role rather than
 * by class name: a progress bar is an element with a `slider` role or an inline
 * transform, and the volume slider only exists while the pointer is over the
 * volume button.
 */
function sliderExpression() {
  return `(() => {
    const describe = (el) => {
      const rect = el.getBoundingClientRect();
      return {
        tag: el.tagName.toLowerCase(),
        cls: (typeof el.className === 'string' ? el.className : '').slice(0, 80),
        role: el.getAttribute('role'),
        title: el.getAttribute('title') || el.getAttribute('aria-label') || '',
        rect: [Math.round(rect.x), Math.round(rect.y), Math.round(rect.width), Math.round(rect.height)],
        children: el.children.length,
      };
    };
    const out = { roles: [], inFooter: [], volumeIcon: null };
    for (const el of document.querySelectorAll('[role="slider"],[role="progressbar"],input[type="range"]')) {
      out.roles.push(describe(el));
      if (out.roles.length >= 12) break;
    }
    // The footer holds the play bar; list its interesting descendants by size.
    const footer = document.querySelector('footer');
    if (footer) {
      for (const el of footer.querySelectorAll('*')) {
        const rect = el.getBoundingClientRect();
        if (rect.width >= 80 && rect.height <= 12 && rect.height >= 2) {
          out.inFooter.push(describe(el));
          if (out.inFooter.length >= 16) break;
        }
      }
    }
    const vol = document.querySelector('.cmd-icon-Volume2, .cmd-icon-Volume1, .cmd-icon-Volume0, [title="静音"]');
    if (vol) {
      out.volumeIcon = describe(vol);
      // Hovering is a real event on this page, and the slider is created in response.
      try {
        for (const type of ['mouseover', 'mouseenter', 'mousemove']) {
          vol.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
        }
      } catch (_) {}
    }
    return out;
  })()`;
}

/**
 * Every `audioplayer.*` command string the bundle mentions.
 *
 * The audio pipeline talks to the native player over a named-call bridge, and the
 * names are literals in the bundle. `seekAudioPlayer` turned out to be
 * `call("audioplayer.seek", ...)`, so the full list of names is the full list of
 * things the native player can be asked to do - which is where the volume and
 * position commands live.
 */
function audioCommandsExpression() {
  return `(() => {
    const require = window.__moRequire;
    if (typeof require !== 'function') return { ok: false, reason: 'no require' };
    const re = /["']([a-zA-Z]+\\.[a-zA-Z]+)["']/g;
    const found = new Map();
    for (const id of Object.keys(require.c || {})) {
      let mod;
      try { mod = require(id); } catch (_) { continue; }
      if (!mod || typeof mod !== 'object') continue;
      for (const [name, value] of Object.entries(mod)) {
        if (typeof value !== 'function') continue;
        let src = '';
        try { src = Function.prototype.toString.call(value); } catch (_) { continue; }
        if (src.indexOf('.call(') < 0) continue;
        for (const m of src.matchAll(re)) {
          if (!/^(audioplayer|player|audio)\\./i.test(m[1])) continue;
          if (!found.has(m[1])) found.set(m[1], { command: m[1], moduleId: id, exportName: name });
        }
      }
    }
    return { ok: true, commands: [...found.values()].sort((a, b) => a.command.localeCompare(b.command)) };
  })()`;
}

/** For each needle, the first few excerpts of function source that mention it. */
function needleContextsExpression(needles) {
  return `(() => {
    const require = window.__moRequire;
    if (typeof require !== 'function') return { ok: false, reason: 'no require' };
    const needles = ${JSON.stringify(needles)};
    const out = {};
    for (const needle of needles) out[needle] = [];
    for (const id of Object.keys(require.c || {})) {
      let mod;
      try { mod = require(id); } catch (_) { continue; }
      if (!mod || typeof mod !== 'object') continue;
      for (const [name, value] of Object.entries(mod)) {
        if (typeof value !== 'function') continue;
        let src = '';
        try { src = Function.prototype.toString.call(value); } catch (_) { continue; }
        for (const needle of needles) {
          if (out[needle].length >= 6) continue;
          let at = src.indexOf(needle);
          while (at >= 0 && out[needle].length < 6) {
            out[needle].push({
              moduleId: id,
              exportName: name,
              excerpt: src.slice(Math.max(0, at - 110), at + 150),
            });
            at = src.indexOf(needle, at + needle.length);
          }
        }
      }
    }
    return { ok: true, contexts: out };
  })()`;
}

/**
 * Every method name the bundle calls on the `AudioPlayer` wrapper.
 *
 * Volume is not an `audioplayer.*` command, so it must be a method on this
 * wrapper. Enumerating what the client calls tells us the whole vocabulary
 * instead of guessing at one name.
 */
function audioPlayerMethodsExpression() {
  return `(() => {
    const require = window.__moRequire;
    if (typeof require !== 'function') return { ok: false, reason: 'no require' };
    const re = /AudioPlayer\\.([a-zA-Z_$][a-zA-Z0-9_$]*)/g;
    const found = new Map();
    for (const id of Object.keys(require.c || {})) {
      let mod;
      try { mod = require(id); } catch (_) { continue; }
      if (!mod || typeof mod !== 'object') continue;
      for (const [name, value] of Object.entries(mod)) {
        if (typeof value !== 'function') continue;
        let src = '';
        try { src = Function.prototype.toString.call(value); } catch (_) { continue; }
        for (const m of src.matchAll(re)) {
          if (!found.has(m[1])) found.set(m[1], { method: m[1], moduleId: id, exportName: name });
        }
      }
    }
    return { ok: true, methods: [...found.values()].sort((a, b) => a.method.localeCompare(b.method)) };
  })()`;
}

/**
 * The play-mode enum, found by value shape rather than by name.
 *
 * The reducer's initial state contains `lastPlayingMode: y.i.playCycle`, so the
 * modes are members of some exported object. Scanning every object export for
 * `play*` strings finds that object without knowing which module it is in - and
 * the same pass collects the Chinese labels, which is what the card has to show.
 */
function modeEnumExpression() {
  return `(() => {
    const require = window.__moRequire;
    if (typeof require !== 'function') return { ok: false, reason: 'no require' };
    const enums = [];
    const labels = [];
    for (const id of Object.keys(require.c || {})) {
      let mod;
      try { mod = require(id); } catch (_) { continue; }
      if (!mod || typeof mod !== 'object') continue;
      for (const [name, value] of Object.entries(mod)) {
        if (!value || typeof value !== 'object' || typeof value === 'function') continue;
        if (Array.isArray(value)) continue;
        const pairs = {};
        let modeCount = 0;
        let labelCount = 0;
        for (const [k, v] of Object.entries(value)) {
          if (typeof v === 'string' && /^play[A-Z]/.test(v)) { pairs[k] = v; modeCount++; }
          else if (typeof v === 'string' && /循环|随机|顺序播放|播放列表/.test(v)) { pairs[k] = v; labelCount++; }
          if (Object.keys(pairs).length >= 24) break;
        }
        if (modeCount >= 2 && enums.length < 10) enums.push({ moduleId: id, exportName: name, pairs });
        if (labelCount >= 2 && labels.length < 10) labels.push({ moduleId: id, exportName: name, pairs });
      }
    }
    return { ok: true, enums, labels };
  })()`;
}

/** Every export of the audio module, with its type and arity. */
function audioModuleExportsExpression(audioModuleId) {
  return `(() => {
    const require = window.__moRequire;
    if (typeof require !== 'function') return { ok: false, reason: 'no require' };
    let mod;
    try { mod = require(${JSON.stringify(audioModuleId)}); } catch (err) { return { ok: false, reason: String(err) }; }
    if (!mod) return { ok: false, reason: 'no module' };
    const out = [];
    for (const [name, value] of Object.entries(mod)) {
      const t = typeof value;
      let arity = null;
      if (t === 'function') { try { arity = value.length; } catch (_) {} }
      out.push({ name, type: t, arity });
    }
    return { ok: true, exports: out };
  })()`;
}

/**
 * Locate the `AudioPlayer` wrapper object itself.
 *
 * The playing model calls `r.AudioPlayer.setVolume(...)`, `...seek(...)` and
 * `...getPlayedTime()` - so the wrapper is reachable from a module namespace.
 * Finding the object that owns those methods is what lets the bridge call the
 * same thing the client's own volume slider calls, instead of a guess.
 */
function findAudioPlayerExpression() {
  return `(() => {
    const require = window.__moRequire;
    if (typeof require !== 'function') return { ok: false, reason: 'no require' };
    const wanted = ['setVolume', 'seek', 'getPlayedTime', 'subscribeVolume'];
    const hits = [];
    const describe = (obj) => {
      const methods = [];
      for (const [k, v] of Object.entries(obj)) {
        const t = typeof v;
        if (t === 'function') { let a = null; try { a = v.length; } catch (_) {} methods.push(k + '/' + a); }
      }
      return methods;
    };
    const consider = (moduleId, exportName, obj) => {
      if (!obj || typeof obj !== 'object') return;
      const has = wanted.filter((w) => typeof obj[w] === 'function');
      if (has.length >= 2 && hits.length < 12) {
        hits.push({ moduleId, exportName, has, methodCount: Object.keys(obj).length, methods: describe(obj).slice(0, 60) });
      }
    };
    for (const id of Object.keys(require.c || {})) {
      let mod;
      try { mod = require(id); } catch (_) { continue; }
      if (!mod || typeof mod !== 'object') continue;
      for (const [name, value] of Object.entries(mod)) {
        consider(id, name, value);
        // A namespace whose member is the wrapper: r.AudioPlayer.
        if (value && typeof value === 'object' && value.AudioPlayer) {
          consider(id, name + '.AudioPlayer', value.AudioPlayer);
        }
      }
    }
    return { ok: true, hits };
  })()`;
}

/**
 * The AudioPlayer wrapper's own methods, with their source.
 *
 * This is where the units live. The wrapper is the layer between the client's
 * React components and the native player, so its `seek` says what its arguments
 * mean and whether it converts them - a fact that is otherwise unknowable from a
 * packed bundle. Its methods are on a prototype rather than on the exported
 * object, which is why an exports-only scan cannot see them.
 */
function audioPlayerDetailExpression() {
  return `(() => {
    const require = window.__moRequire;
    if (typeof require !== 'function') return { ok: false, reason: 'no require' };
    const wanted = ['setVolume', 'seek', 'getPlayedTime', 'getPlaybackInfo', 'setPlaybackRate', 'play', 'pause', 'stop', 'resumePlay'];
    let player = null;
    let where = null;
    for (const id of Object.keys(require.c || {})) {
      let mod;
      try { mod = require(id); } catch (_) { continue; }
      if (!mod || typeof mod !== 'object') continue;
      if (mod.AudioPlayer && typeof mod.AudioPlayer.setVolume === 'function') {
        player = mod.AudioPlayer;
        where = { moduleId: id, exportName: 'AudioPlayer' };
        break;
      }
      if (typeof mod.setVolume === 'function' && typeof mod.seek === 'function') {
        player = mod;
        where = { moduleId: id, exportName: '(module itself)' };
        break;
      }
    }
    if (!player) return { ok: false, reason: 'AudioPlayer not found' };
    const out = [];
    for (const name of wanted) {
      const fn = player[name];
      if (typeof fn !== 'function') { out.push({ name, missing: true }); continue; }
      let src = '';
      try { src = Function.prototype.toString.call(fn); } catch (_) {}
      out.push({ name, arity: fn.length, source: src.slice(0, 600) });
    }
    // Which prototype owns them? A class instance keeps its methods off the export.
    let proto = null;
    try {
      proto = Object.getOwnPropertyNames(Object.getPrototypeOf(player)).slice(0, 40);
    } catch (_) {}
    return { ok: true, where, ownKeys: Object.keys(player), proto, methods: out };
  })()`;
}

/** What appeared after the volume button was hovered. */
function volumeSliderExpression() {
  return `(() => {
    const out = [];
    const all = document.querySelectorAll('div,span,input');
    for (const el of all) {
      const cls = typeof el.className === 'string' ? el.className : '';
      if (!/volume|Volume|slider|Slider|progress|Progress/i.test(cls)) continue;
      const rect = el.getBoundingClientRect();
      if (rect.width < 10 || rect.height < 2) continue;
      if (rect.top < 500) continue;
      out.push({
        tag: el.tagName.toLowerCase(),
        cls: cls.slice(0, 80),
        role: el.getAttribute('role'),
        rect: [Math.round(rect.x), Math.round(rect.y), Math.round(rect.width), Math.round(rect.height)],
        style: (el.getAttribute('style') || '').slice(0, 90),
      });
      if (out.length >= 20) break;
    }
    return { ok: true, found: out };
  })()`;
}

const args = parseArgs(process.argv.slice(2));
const diagnosis = await diagnoseChannel({ port: args.port });
if (diagnosis.state !== 'ready') {
  console.error(`通道不可用（状态: ${diagnosis.state}）。先运行: node tools/probe-cdp.mjs`);
  process.exit(1);
}

const session = await connectToNeteasePage({ port: args.port });
const report = {};
const step = async (name, expression) => {
  try {
    report[name] = await session.evaluate(expression);
  } catch (err) {
    report[name] = { ok: false, error: String(err.message ?? err) };
  }
};

try {
  await step('bootstrap', bootstrapRequireExpression());
  await step('discovery', discoverDvaExpression());
  await step('store', resolveStoreExpression());
  const audioModuleId = report.discovery?.audioModuleId ?? report.store?.audioModuleId ?? '1186';
  report.audioModuleId = audioModuleId;
  await step('actions', candidateActionsExpression());
  await step('playing', playingValuesExpression());
  await step('clientControls', clientControlsExpression());
  await step('audioExports', audioExportsExpression(audioModuleId));
  await step('sliders', sliderExpression());
  await step('seekSources', seekSourceExpression());
  await step('modeLiterals', modeLiteralsExpression());
  await step('volumeSlider', volumeSliderExpression());
  await step('audioCommands', audioCommandsExpression());
  await step(
    'needles',
    needleContextsExpression([
      'audioplayer.seek',
      'seekAudioPlayer',
      'playingVolume',
      'muteVolume',
      'switchPlayingMode',
      'playingMode',
      'playCycle',
      'audioPlayerSeek',
      'setMiniPlayerMute',
      'AudioPlayer.seek(',
      'AudioPlayer.setVolume(',
      'AudioPlayer.getPlayedTime(',
      'AudioPlayer.getPlaybackInfo(',
    ]),
  );
  await step('modeEnum', modeEnumExpression());
  await step('audioPlayerMethods', audioPlayerMethodsExpression());
  await step('audioExportsAll', audioModuleExportsExpression(audioModuleId));
  await step('audioPlayerObject', findAudioPlayerExpression());
  await step('audioPlayerDetail', audioPlayerDetailExpression());
} finally {
  session.close();
}

if (args.json) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(`音频模块: ${report.audioModuleId}`);
  console.log(`\n=== 可能相关的 dva 动作（共 ${report.actions?.total ?? '?'} 个动作） ===`);
  for (const name of report.actions?.hits ?? []) console.log(`  ${name}`);

  console.log('\n=== playing 切片里的相关字段（当前值） ===');
  for (const [key, info] of Object.entries(report.playing?.fields ?? {})) {
    console.log(`  ${key}: ${JSON.stringify(info)}`);
  }

  console.log('\n=== 客户端自己的控件 ===');
  for (const c of report.clientControls?.controls ?? []) {
    console.log(`  <${c.tag}> ${c.cls}  title="${c.title}"  rect=${c.rect.join(',')}`);
  }

  console.log('\n=== 音频模块中相关的导出 ===');
  for (const e of report.audioExports?.exports ?? []) {
    console.log(`  [${e.moduleId}] ${e.name}  ${e.type}${e.arity === null ? '' : `/${e.arity}`}`);
  }

  console.log('\n=== 拖动条（按 role 找） ===');
  for (const s of report.sliders?.roles ?? []) {
    console.log(`  role=${s.role} <${s.tag}> ${s.cls} rect=${s.rect.join(',')}`);
  }
  console.log('  页脚里又宽又扁的元素:');
  for (const s of report.sliders?.inFooter ?? []) {
    console.log(`    <${s.tag}> ${s.cls} rect=${s.rect.join(',')} children=${s.children}`);
  }
  console.log(`  音量按钮: ${JSON.stringify(report.sliders?.volumeIcon)}`);

  console.log('\n=== 悬停音量按钮后出现的元素 ===');
  for (const s of report.volumeSlider?.found ?? []) {
    console.log(`  <${s.tag}> ${s.cls} rect=${s.rect.join(',')} style="${s.style}"`);
  }

  console.log('\n=== seek / volume / mode 相关函数的源码 ===');
  for (const h of report.seekSources?.hits ?? []) {
    console.log(`\n--- [${h.moduleId}] ${h.name} (arity ${h.arity})`);
    console.log(h.source);
  }

  console.log('\n=== 模式字面量 ===');
  for (const h of report.modeLiterals?.hits ?? []) {
    console.log(`  [${h.moduleId}] ${h.exportName}  …${h.excerpt}…`);
  }

  console.log('\n=== audioplayer.* 命令（原生播放器能做的事） ===');
  for (const c of report.audioCommands?.commands ?? []) {
    console.log(`  ${c.command}   [${c.moduleId}] ${c.exportName}`);
  }

  console.log('\n=== 关键字上下文 ===');
  for (const [needle, list] of Object.entries(report.needles?.contexts ?? {})) {
    console.log(`\n### ${needle}`);
    for (const h of list) console.log(`  [${h.moduleId}] ${h.exportName}: …${h.excerpt}…`);
  }

  console.log('\n=== 播放模式枚举 ===');
  for (const e of report.modeEnum?.enums ?? []) {
    console.log(`  [${e.moduleId}] ${e.exportName}: ${JSON.stringify(e.pairs)}`);
  }
  console.log('  带中文标签的对象:');
  for (const e of report.modeEnum?.labels ?? []) {
    console.log(`  [${e.moduleId}] ${e.exportName}: ${JSON.stringify(e.pairs)}`);
  }

  console.log('\n=== AudioPlayer.* 方法 ===');
  for (const m of report.audioPlayerMethods?.methods ?? []) {
    console.log(`  ${m.method}   [${m.moduleId}] ${m.exportName}`);
  }

  console.log(`\n=== 音频模块 ${report.audioModuleId} 的全部导出 ===`);
  for (const e of report.audioExportsAll?.exports ?? []) {
    console.log(`  ${e.name}  ${e.type}${e.arity === null ? '' : `/${e.arity}`}`);
  }

  console.log('\n=== AudioPlayer 包装对象 ===');
  for (const h of report.audioPlayerObject?.hits ?? []) {
    console.log(`  [${h.moduleId}] ${h.exportName}  有: ${h.has.join(', ')}  (共 ${h.methodCount} 个成员)`);
    console.log(`     ${h.methods.join(' ')}`);
  }

  const detail = report.audioPlayerDetail;
  console.log(`\n=== AudioPlayer 的方法源码（${JSON.stringify(detail?.where)}） ===`);
  console.log(`  自有键: ${JSON.stringify(detail?.ownKeys)}`);
  console.log(`  原型上的键: ${JSON.stringify(detail?.proto)}`);
  for (const m of detail?.methods ?? []) {
    if (m.missing) { console.log(`  ${m.name}: 不存在`); continue; }
    console.log(`\n--- ${m.name} (arity ${m.arity})`);
    console.log(m.source);
  }
}
