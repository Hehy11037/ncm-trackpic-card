#!/usr/bin/env node
// Read-only: capture the real dispatch actions behind each transport control.
//
//   node tools/capture-controls.mjs [--seconds 25]
//
// Instead of guessing action type strings (they differ between client builds),
// this taps store.dispatch, then asks you to press each control in the NetEase UI
// once. The captured types become the ground truth for the host's control layer.

import { connectToNeteasePage, diagnoseChannel, DEFAULT_CDP_PORT } from './lib/cdp-client.mjs';
import { bootstrapRequireExpression, discoverDvaExpression } from './lib/inject.mjs';
import { resolveStoreExpression } from './lib/probe.mjs';

function parseArgs(argv) {
  const out = { port: DEFAULT_CDP_PORT, seconds: 25 };
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
    if (window.__moTapRestore) { try { window.__moTapRestore(); } catch (_) {} }
    const orig = store.dispatch;
    window.__moCap = { actions: [] };
    store.dispatch = function (action) {
      try {
        if (window.__moCap.actions.length < 1500) {
          const a = action || {};
          let payload = null;
          try {
            payload = a.payload && typeof a.payload === 'object'
              ? JSON.parse(JSON.stringify(a.payload, (k, v) => (typeof v === 'function' ? '[fn]' : v)))
              : a.payload;
          } catch (_) { payload = '[unserializable]'; }
          window.__moCap.actions.push({ t: Date.now(), type: String(a.type), payload });
        }
      } catch (_) {}
      return orig.apply(this, arguments);
    };
    window.__moTapRestore = () => { store.dispatch = orig; };
    return { ok: true };
  })()`);

  if (install?.ok === false) {
    console.error('无法安装 dispatch 监听:', install.reason);
    process.exit(1);
  }

  console.log('已开始监听 dispatch。');
  console.log(`请在 ${args.seconds} 秒内，依次在网易云界面里点一遍这些按钮：`);
  console.log('   1) 暂停   2) 播放   3) 下一首   4) 上一首   5) 音量 +/- 或静音   6) 切换播放模式（顺序/列表循环/单曲/随机）');
  console.log('   （只需各点一次；中间可以停一下，方便区分）\n');

  const ticks = Math.max(2, Math.round((args.seconds * 1000) / 500));
  let lastCount = -1;
  for (let i = 0; i < ticks; i++) {
    await new Promise((r) => setTimeout(r, 500));
    const s = await evalJson(`(() => {
      const c = window.__moCap ? window.__moCap.actions : [];
      return { count: c.length, tail: c.slice(-3) };
    })()`);
    if (s?.count !== lastCount) {
      lastCount = s?.count;
      const tail = (s?.tail ?? []).map((a) => a.type).join(' | ');
      process.stdout.write(`  [${String(i * 0.5).padStart(5)}s] +${s?.count ?? 0}  ${tail}\n`);
    }
  }

  const summary = await evalJson(`(() => {
    const a = window.__moCap ? window.__moCap.actions : [];
    const byType = {};
    for (const it of a) byType[it.type] = (byType[it.type] || 0) + 1;
    return {
      total: a.length,
      byType,
      controlLike: a
        .filter((it) => /playing|play|pause|next|prev|volume|mute|mode|rate|speed/i.test(it.type))
        .slice(0, 40),
    };
  })()`);

  await evalJson('(() => { if (window.__moTapRestore) window.__moTapRestore(); return true; })()');

  console.log('\n=== 全部动作类型统计 ===');
  console.log(JSON.stringify(summary?.byType, null, 2));

  console.log('\n=== 疑似控制动作（含 payload）===');
  for (const it of summary?.controlLike ?? []) {
    console.log(`  ${it.type}`);
    if (it.payload !== null && it.payload !== undefined) {
      console.log(`      payload: ${JSON.stringify(it.payload).slice(0, 220)}`);
    }
  }
  if (!summary?.controlLike?.length) {
    console.log('  （没有捕获到控制动作——可能你还没点击按钮）');
  }
} finally {
  session.close();
}
