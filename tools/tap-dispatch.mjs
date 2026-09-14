#!/usr/bin/env node
// Read-only: tap the store's dispatch stream and the DOM to find live progress.
//
//   node tools/tap-dispatch.mjs [--port 9223] [--seconds 6]
//
// Rationale: the audio pipeline observables in module 1186 never emit, and the
// dva lyric slice is static, so we tap the one entry point every state change
// must pass through -- store.dispatch -- and also look at the progress bar the UI
// already renders (its inline style is a direct function of playback position).

import { connectToNeteasePage, diagnoseChannel, DEFAULT_CDP_PORT } from './lib/cdp-client.mjs';
import { bootstrapRequireExpression, discoverDvaExpression } from './lib/inject.mjs';
import { resolveStoreExpression } from './lib/probe.mjs';

function parseArgs(argv) {
  const out = { port: DEFAULT_CDP_PORT, seconds: 6 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port') out.port = Number(argv[++i]);
    else if (a === '--seconds') out.seconds = Number(argv[++i]);
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

try {
  await evalJson(bootstrapRequireExpression());
  await evalJson(discoverDvaExpression());
  await evalJson(resolveStoreExpression());

  const install = await evalJson(`(() => {
    const store = window.__moStore;
    if (!store) return { ok: false, reason: 'no store' };
    window.__moTap = { actions: [], startedAt: Date.now() };
    if (window.__moUnsub) { try { window.__moUnsub(); } catch (_) {} }
    const orig = store.dispatch;
    store.dispatch = function (action) {
      try {
        if (window.__moTap.actions.length < 600) {
          const a = action || {};
          let payload = null;
          try {
            payload = a.payload && typeof a.payload === 'object'
              ? JSON.parse(JSON.stringify(a.payload, (k, v) => (typeof v === 'function' ? '[fn]' : v)))
              : a.payload;
          } catch (_) { payload = '[unserializable]'; }
          window.__moTap.actions.push({ t: Date.now(), type: String(a.type), payload });
        }
      } catch (_) {}
      return orig.apply(this, arguments);
    };
    window.__moUnsub = () => { store.dispatch = orig; };
    return { ok: true };
  })()`);

  const samples = [];
  const total = Math.max(2, Math.round((args.seconds * 1000) / 500));
  for (let i = 0; i < total; i++) {
    await new Promise((r) => setTimeout(r, 500));
    const s = await evalJson(`(() => {
      const st = window.__moStore.getState();
      return {
        line: st.playing.playingLyricLineNumber,
        state: st.playing.playingState,
        actions: window.__moTap ? window.__moTap.actions.length : -1,
      };
    })()`);
    samples.push(s);
  }

  const dom = await evalJson(`(() => {
    const out = [];
    const re = /(progress|slider|seek|bar|playing|process)/i;
    for (const el of document.querySelectorAll('*')) {
      if (out.length >= 25) break;
      const style = el.getAttribute && el.getAttribute('style');
      if (!style) continue;
      const cls = String(el.className || '');
      if (!re.test(cls)) continue;
      if (!/(width|transform|left)/.test(style)) continue;
      out.push({ tag: el.tagName, cls: cls.slice(0, 70), style: style.slice(0, 140) });
    }
    return out;
  })()`);

  const actions = await evalJson(`(() => {
    const a = window.__moTap ? window.__moTap.actions : [];
    const byType = {};
    for (const it of a) byType[it.type] = (byType[it.type] || 0) + 1;
    return {
      total: a.length,
      byType,
      progressLike: a.filter((it) => /progress|time|seek|position|lyric/i.test(it.type)).slice(-12),
      last8: a.slice(-8),
    };
  })()`);

  await evalJson('(() => { if (window.__moUnsub) window.__moUnsub(); return true; })()');

  console.log('=== 采样（每 500ms）===');
  for (const [i, s] of samples.entries()) console.log(`  #${i}  line=${s.line} state=${s.state} actions=${s.actions}`);

  console.log('\n=== dispatch 汇总 ===');
  console.log(JSON.stringify(actions, null, 2));

  console.log('\n=== DOM 进度锚点 ===');
  console.log(JSON.stringify(dom, null, 2));
} finally {
  session.close();
}
