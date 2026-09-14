#!/usr/bin/env node
// Read-only: persistent dispatch recorder.
//
//   node tools/arm-dispatch-tap.mjs --install   arm the recorder (stays armed)
//   node tools/arm-dispatch-tap.mjs --dump      read everything captured since
//   node tools/arm-dispatch-tap.mjs --clear     forget captured actions
//
// Unlike capture-controls.mjs (which watches a fixed time window), the recorder
// stays armed in the page until the page reloads, so the user can click controls
// whenever convenient and we read the result afterwards.

import { connectToNeteasePage, diagnoseChannel, DEFAULT_CDP_PORT } from './lib/cdp-client.mjs';
import { bootstrapRequireExpression, discoverDvaExpression } from './lib/inject.mjs';
import { resolveStoreExpression } from './lib/probe.mjs';

function parseArgs(argv) {
  const out = { port: DEFAULT_CDP_PORT, mode: 'dump' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port') out.port = Number(argv[++i]);
    else if (['--install', '--dump', '--clear'].includes(a)) out.mode = a.slice(2);
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
const evalJson = async (expr) => {
  try {
    return await session.evaluate(expr);
  } catch (err) {
    return { error: String(err.message ?? err) };
  }
};

try {
  await evalJson(bootstrapRequireExpression());
  await evalJson(discoverDvaExpression());
  await evalJson(resolveStoreExpression());

  if (args.mode === 'install') {
    const res = await evalJson(`(() => {
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
    console.log(JSON.stringify(res, null, 2));
  } else if (args.mode === 'clear') {
    const res = await evalJson(
      '(() => { if (window.__moDisp) window.__moDisp.actions = []; return { ok: true }; })()',
    );
    console.log(JSON.stringify(res));
  } else {
    const res = await evalJson(`(() => {
      const d = window.__moDisp;
      if (!d) return { ok: false, reason: 'recorder not armed; run --install first' };
      const byType = {};
      const firstPayload = {};
      for (const it of d.actions) {
        byType[it.type] = (byType[it.type] || 0) + 1;
        if (!firstPayload[it.type] && it.payload !== null && it.payload !== undefined) {
          firstPayload[it.type] = it.payload;
        }
      }
      return { ok: true, total: d.actions.length, byType, firstPayload, last20: d.actions.slice(-20) };
    })()`);

    if (res?.ok === false) {
      console.log(JSON.stringify(res, null, 2));
    } else {
      console.log(`总动作数: ${res.total}\n`);
      console.log('=== 动作类型统计 ===');
      for (const [type, count] of Object.entries(res.byType).sort()) {
        console.log(`  ${String(count).padStart(4)}  ${type}`);
      }
      console.log('\n=== 每个动作类型的首个 payload ===');
      for (const [type, payload] of Object.entries(res.firstPayload)) {
        console.log(`\n  ${type}`);
        console.log(`      ${JSON.stringify(payload).slice(0, 400)}`);
      }
    }
  }
} finally {
  session.close();
}
