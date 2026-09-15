#!/usr/bin/env node
// What happens when the client is asked to seek *while paused*?
//
//   node tools/probe-seek-paused-direct.mjs [--wait 6000]
//
// *** Pauses the user's music briefly and resumes it. ***
//
// The card can be dragged while the track is paused, and the first measurement said the seek then
// did nothing at all: no reply from the native player, and playback resumed from where it was. That
// is worth pinning down properly, because "no reply" and "no effect" are different findings with
// different fixes:
//
//   - the wrapper's promise is resolved by the native player's reply, so a missing reply means the
//     command may still have been carried out;
//   - and if the client's *own* progress bar behaves the same way when paused, then this is the
//     client's behaviour rather than a mistake in the card - which changes what the card should do
//     about it (offer the drag, or refuse it honestly).
//
// So this asks the page directly, with its own timeout, instead of going through the host's
// command queue and reading "no receipt".

import { connectToNeteasePage, diagnoseChannel } from './lib/cdp-client.mjs';
import { bootstrapRequireExpression, discoverDvaExpression } from './lib/inject.mjs';
import { resolveStoreExpression } from './lib/probe.mjs';
import { createHost } from '../packages/host/src/index.ts';

function parseArgs(argv) {
  const out = { hostPort: 8790, wait: 6000, seconds: 25 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--host-port') out.hostPort = Number(argv[++i]);
    else if (a === '--wait') out.wait = Number(argv[++i]);
    else if (a === '--seconds') out.seconds = Number(argv[++i]);
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const diagnosis = await diagnoseChannel({ port: 9223 });
if (diagnosis.state !== 'ready') {
  console.error(`通道不可用（状态: ${diagnosis.state}）`);
  process.exit(1);
}

const host = createHost({
  cdpPort: 9223,
  hostPort: args.hostPort,
  uiPort: 0,
  log: (level, message) => {
    if (level === 'warn' || level === 'error') console.log(`[host:${level}] ${message}`);
  },
});

const problems = [];
const check = (name, ok, detail = '') => {
  if (!ok) problems.push(name);
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? `  ${detail}` : ''}`);
};

let session = null;
try {
  await host.start();
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline && !host.currentSnapshot()) await delay(200);
  const first = host.currentSnapshot();
  if (!first) {
    console.error('✗ 宿主没有拿到快照');
    process.exit(1);
  }

  session = await connectToNeteasePage({ port: 9223 });
  const page = (expr, awaitPromise = false) => session.evaluate(expr, { awaitPromise });
  await page(bootstrapRequireExpression());
  await page(discoverDvaExpression());
  await page(resolveStoreExpression());

  const startPosition = first.playhead?.positionMs ?? 0;
  const duration = first.song?.durationMs ?? 0;
  const target = Math.max(5000, Math.min(startPosition + args.seconds * 1000, Math.max(5000, duration - 10000)));

  console.log(`\n曲目 ${first.song?.name ?? '(无)'}，起点 ${Math.round(startPosition / 1000)}s，目标 ${Math.round(target / 1000)}s`);
  console.log(`直接调用 AudioPlayer.seek，等待上限 ${args.wait}ms\n`);

  const paused = await host.control({ type: 'pause' });
  await delay(800);
  check('已暂停', paused.confirmed === true, `playingState=${host.currentSnapshot()?.playback.rawPlayingState}`);

  // The last play id the bridge would use, read the same way it does.
  const playId = await page(
    `(() => new Promise((resolve) => {
      const require = window.__moRequire;
      let stream = null;
      for (const id of Object.keys(require.c || {})) {
        let mod; try { mod = require(id); } catch (_) { continue; }
        if (mod && mod.audioPlayerPlayProgress$ && typeof mod.audioPlayerPlayProgress$.subscribe === 'function') { stream = mod.audioPlayerPlayProgress$; break; }
      }
      if (!stream) return resolve(null);
      let done = false;
      const sub = stream.subscribe((v) => { if (!done) { done = true; resolve(Array.isArray(v) ? v[0] : null); } });
      setTimeout(() => { if (!done) { done = true; resolve(null); } }, 1200);
      setTimeout(() => { try { sub.unsubscribe(); } catch (_) {} }, 1400);
    }))()`,
    true,
  );
  console.log(`  playId（暂停期间仍由流给出最后一次）: ${playId ?? '(拿不到)'}`);

  const direct = await page(
    `(() => new Promise((resolve) => {
      const ap = window.__moAP;
      if (!ap || !playId_placeholder) return resolve({ ok: false, reason: 'no AudioPlayer' });
      const started = Date.now();
      let settled = false;
      const timer = setTimeout(() => { if (!settled) { settled = true; resolve({ ok: false, reason: 'timeout', waitedMs: Date.now() - started }); } }, ${args.wait});
      Promise.resolve(ap.seek({ playId: playId_placeholder, seekId: 'probe|seek|' + Date.now(), value: ${Math.round(target / 1000)} }))
        .then((reply) => { if (!settled) { settled = true; clearTimeout(timer); resolve({ ok: true, reply, waitedMs: Date.now() - started }); } })
        .catch((err) => { if (!settled) { settled = true; clearTimeout(timer); resolve({ ok: false, reason: String(err && err.message || err) }); } });
    }))()`.replaceAll('playId_placeholder', JSON.stringify(playId)),
    true,
  );
  console.log(`  直接调用结果: ${JSON.stringify(direct)}`);
  check('暂停时 native 有回执', direct?.ok === true, direct?.ok ? `等了 ${direct.waitedMs}ms` : `无回执（${direct?.reason}）`);

  await delay(400);
  const afterDirect = await host.control({ type: 'play' });
  await delay(1500);
  check('已恢复播放', afterDirect.confirmed === true, `playingState=${host.currentSnapshot()?.playback.rawPlayingState}`);
  const resumed = host.currentSnapshot()?.playhead?.positionMs ?? null;
  const moved = resumed != null && Math.abs(resumed - target) < 6000;
  check(
    moved ? '暂停时的 seek 生效了' : '暂停时的 seek 没有生效',
    true,
    `恢复后 ${Math.round((resumed ?? 0) / 1000)}s（目标 ${Math.round(target / 1000)}s，原处 ${Math.round(startPosition / 1000)}s）`,
  );
} finally {
  try {
    if (host.currentSnapshot()?.playback.rawPlayingState === 1) {
      console.log('\n（补一次播放，避免把音乐留在暂停）');
      await host.control({ type: 'play' });
    }
  } catch {
    /* nothing more to do */
  }
  session?.close();
  await host.stop();
}

console.log(`\n${problems.length ? `✗ 有 ${problems.length} 项不符合预期` : '✓ 通过'}`);
process.exit(problems.length ? 1 : 0);
