#!/usr/bin/env node
// Read-only: learn the calling convention of the audio pipeline's transport
// functions by wrapping them and recording the arguments real UI input passes.
//
//   node tools/tap-controls.mjs --install          (arm the taps)
//   node tools/tap-controls.mjs --dump             (read what was captured)
//   node tools/tap-controls.mjs --remove           (restore the original functions)
//
// Why: play/pause/mute/mode never show up on store.dispatch in this build, so the
// overlay must call the pipeline functions directly. Their argument lists are not
// documented anywhere; recording real invocations is the only reliable way to
// learn them.

import { connectToNeteasePage, diagnoseChannel, DEFAULT_CDP_PORT } from './lib/cdp-client.mjs';
import { bootstrapRequireExpression, discoverDvaExpression } from './lib/inject.mjs';
import { resolveStoreExpression } from './lib/probe.mjs';

const WATCHED = [
  'setAudioPlayerPlay',
  'setAudioPlayerPause',
  'setAudioPlayerStop',
  'seekAudioPlayer',
  'startLoad',
];

function parseArgs(argv) {
  const out = { port: DEFAULT_CDP_PORT, mode: 'dump' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port') out.port = Number(argv[++i]);
    else if (a === '--install') out.mode = 'install';
    else if (a === '--dump') out.mode = 'dump';
    else if (a === '--remove') out.mode = 'remove';
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const diagnosis = await diagnoseChannel({ port: args.port });
if (diagnosis.state !== 'ready') {
  console.error(`通道不可用（状态: ${diagnosis.state}）`);
  process.exit(1);
}

const session = await connectToNeteasePage({ port: args.port });
const evalJson = async (expr, awaitPromise = false) => {
  try {
    return await session.evaluate(expr, { awaitPromise });
  } catch (err) {
    return { error: String(err.message ?? err) };
  }
};

const setup = async () => {
  await evalJson(bootstrapRequireExpression());
  await evalJson(discoverDvaExpression());
  await evalJson(resolveStoreExpression());
};

// Find the audio module id at runtime (do not hardcode it).
const FIND_AUDIO = `(() => {
  const require = window.__moRequire;
  if (typeof require !== 'function') return null;
  for (const id of Object.keys(require.c || {})) {
    let mod;
    try { mod = require(id); } catch (_) { continue; }
    if (mod && Object.keys(mod).indexOf('audioPlayerPlayProgress$') >= 0) return id;
  }
  return null;
})()`;

try {
  await setup();

  if (args.mode === 'install') {
    const result = await evalJson(`(() => {
      const require = window.__moRequire;
      const audioId = (${FIND_AUDIO});
      if (!audioId) return { ok: false, reason: 'audio module not found' };
      const mod = require(audioId);
      window.__moCtl = window.__moCtl || { calls: [], arity: {} };
      window.__moCtl.audioId = audioId;

      const watched = ${JSON.stringify(WATCHED)};
      // Also wrap anything else on the module that looks like a command sink.
      for (const name of Object.keys(mod)) {
        if (typeof mod[name] !== 'function') continue;
        if (watched.indexOf(name) < 0 && !/^(set|seek|start|stop|toggle)/.test(name)) continue;
        if (mod[name].__moWrapped) continue;
        const original = mod[name];
        window.__moCtl.arity[name] = original.length;
        const wrapped = function () {
          try {
            const a = Array.prototype.slice.call(arguments).map((v) => {
              if (v === null || v === undefined) return v;
              const t = typeof v;
              if (t === 'number' || t === 'boolean' || t === 'string') return v;
              if (t === 'function') return '[fn]';
              try { return JSON.parse(JSON.stringify(v, (k, val) => (typeof val === 'function' ? '[fn]' : val))); }
              catch (_) { return '[object]'; }
            });
            if (window.__moCtl.calls.length < 200) {
              window.__moCtl.calls.push({ t: Date.now(), name, args: a, argc: arguments.length });
            }
          } catch (_) {}
          return original.apply(this, arguments);
        };
        wrapped.__moWrapped = true;
        mod[name] = wrapped;
      }
      return { ok: true, audioId, arity: window.__moCtl.arity };
    })()`);
    console.log(JSON.stringify(result, null, 2));
    console.log('\n探针已装上。请点击界面按钮，然后用 --dump 读取。');
  } else if (args.mode === 'dump') {
    const result = await evalJson(`(() => {
      const c = window.__moCtl;
      if (!c) return { ok: false, reason: 'taps not installed' };
      const byName = {};
      for (const call of c.calls) {
        if (!byName[call.name]) byName[call.name] = [];
        if (byName[call.name].length < 4) byName[call.name].push(call.args);
      }
      return { ok: true, audioId: c.audioId, arity: c.arity, total: c.calls.length, byName, timeline: c.calls.slice(-25) };
    })()`);

    if (result?.ok === false) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`音频模块: ${result.audioId}   捕获调用数: ${result.total}`);
      console.log('\n=== 各函数的声明参数个数 ===');
      console.log(JSON.stringify(result.arity, null, 2));
      console.log('\n=== 各函数的真实调用参数 ===');
      for (const [name, calls] of Object.entries(result.byName ?? {})) {
        console.log(`\n  ${name}`);
        calls.forEach((a, i) => console.log(`     #${i}: ${JSON.stringify(a)}`));
      }
      if (!Object.keys(result.byName ?? {}).length) {
        console.log('  （还没捕获到调用）');
      }
      console.log('\n=== 调用时间线（最后 25 条）===');
      for (const c of result.timeline ?? []) {
        console.log(`  ${c.name}(${JSON.stringify(c.args)})`);
      }
    }
  } else if (args.mode === 'remove') {
    const result = await evalJson(`(() => {
      const require = window.__moRequire;
      const audioId = window.__moCtl && window.__moCtl.audioId;
      if (!audioId) return { ok: false, reason: 'no audio id recorded' };
      const mod = require(audioId);
      let restored = 0;
      for (const name of Object.keys(mod)) {
        if (typeof mod[name] === 'function' && mod[name].__moWrapped) {
          // The original is captured by closure; nothing to restore to, so just
          // mark it inert by dropping the recorder.
          mod[name].__moWrapped = false;
          restored++;
        }
      }
      window.__moCtl = null;
      return { ok: true, restored, note: 'recording stopped (wrappers are now pass-through)' };
    })()`);
    console.log(JSON.stringify(result, null, 2));
  }
} finally {
  session.close();
}
