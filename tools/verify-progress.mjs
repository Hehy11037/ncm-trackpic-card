#!/usr/bin/env node
// Read-only: figure out how to obtain live playback progress.
//
//   node tools/verify-progress.mjs [--port 9223] [--seconds 6]
//
// Tries, in order of preference:
//   1. audioPlayerPlayProgress$ (the client's own progress stream)
//   2. any DOM node whose style/attribute carries a progress ratio
//   3. the dva lyric slice (line number + lyric line timings)
// and prints a timeline so we can see which source actually ticks.

import { connectToNeteasePage, diagnoseChannel, DEFAULT_CDP_PORT } from './lib/cdp-client.mjs';
import { bootstrapRequireExpression, discoverDvaExpression, snapshotExpression } from './lib/inject.mjs';
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

  // Keep one long-lived subscription to the progress stream and to every other
  // pipeline stream, storing what they emit on the window for later reads.
  const install = await evalJson(
    `(() => {
      const require = window.__moRequire;
      if (typeof require !== 'function') return { ok: false, reason: 'no require' };
      const mod = require('1186');
      if (!mod) return { ok: false, reason: 'module 1186 missing' };
      window.__moLog = { events: [], installedAt: Date.now() };
      const names = Object.keys(mod).filter((n) => {
        const v = mod[n];
        return v && typeof v === 'object' && typeof v.subscribe === 'function';
      });
      window.__moSubs = window.__moSubs || [];
      for (const s of window.__moSubs) { try { s.unsubscribe(); } catch (_) {} }
      window.__moSubs = [];
      for (const name of names) {
        try {
          const sub = mod[name].subscribe((v) => {
            let d;
            try {
              d = (v && typeof v === 'object')
                ? JSON.parse(JSON.stringify(v, (k, val) => (typeof val === 'function' ? '[fn]' : val)))
                : v;
            } catch (_) { d = String(v); }
            if (window.__moLog.events.length < 400) {
              window.__moLog.events.push({ t: Date.now(), name, value: d });
            }
          });
          window.__moSubs.push(sub);
        } catch (_) {}
      }
      return { ok: true, subscribed: names };
    })()`,
  );

  // Snapshot the store once, then sample every 200ms.
  const snap = await evalJson(snapshotExpression());

  const readDom = `(() => {
    const out = [];
    const nodes = document.querySelectorAll('[style*="width"], [style*="transform"], [class*="progress"], [class*="slider"], [class*="bar"]');
    let n = 0;
    for (const el of nodes) {
      if (n++ > 400) break;
      const cls = String(el.className || '').slice(0, 60);
      if (!/progress|slider|bar|playing|seek/i.test(cls)) continue;
      const st = el.getAttribute('style') || '';
      const w = el.style && el.style.width ? el.style.width : '';
      const tf = el.style && el.style.transform ? el.style.transform : '';
      if (!w && !tf) continue;
      out.push({ cls, style: st.slice(0, 120), width: w, transform: tf.slice(0, 80) });
      if (out.length >= 20) break;
    }
    return out;
  })()`;

  const samples = [];
  const total = Math.max(2, Math.round((args.seconds * 1000) / 200));
  for (let i = 0; i < total; i++) {
    const tick = await evalJson(`(() => {
      const line = (window.__moDva && window.__moDva.getStore().playing.playingLyricLineNumber) ?? null;
      const events = window.__moLog ? window.__moLog.events.slice(-6) : [];
      const count = window.__moLog ? window.__moLog.events.length : -1;
      return { line, count, events };
    })()`);
    samples.push(tick);
    await new Promise((r) => setTimeout(r, 200));
  }

  const dom = await evalJson(readDom);

  const summary = {};
  const allEvents = await evalJson(
    '(() => { const e = window.__moLog ? window.__moLog.events : []; const by = {}; for (const ev of e) { by[ev.name] = (by[ev.name] || 0) + 1; } return { total: e.length, byName: by, last: e.slice(-12) }; })()',
  );

  const cleanup = await evalJson(
    '(() => { if (window.__moSubs) { for (const s of window.__moSubs) { try { s.unsubscribe(); } catch (_) {} } window.__moSubs = []; } return true; })()',
  );

  console.log('=== 播放状态 ===');
  console.log(JSON.stringify(snap, null, 2));

  console.log('\n=== 订阅安装 ===');
  console.log(JSON.stringify(install, null, 2));

  console.log('\n=== 时间线（每 200ms；line=歌词行号, count=累计事件数）===');
  for (const [i, s] of samples.entries()) {
    console.log(`  #${i}  line=${s.line}  events=${s.count}  latest=${JSON.stringify(s.events?.[s.events.length - 1] ?? null)}`);
  }

  console.log('\n=== 流事件汇总 ===');
  console.log(JSON.stringify(allEvents, null, 2));

  console.log('\n=== 可能的 DOM 进度锚点 ===');
  console.log(JSON.stringify(dom, null, 2));

  console.log('\ncleanup:', JSON.stringify(cleanup));
} finally {
  session.close();
}
