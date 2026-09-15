#!/usr/bin/env node
// Does seeking work while the client is *paused*?
//
//   node tools/probe-seek-paused.mjs [--host-port 8790] [--seconds 45]
//
// *** This pauses the user's music for a few seconds and then resumes it. ***
//
// Why it matters: the card lets the pointer be dragged while the track is paused, and two things
// depend on the answer.
//
//   1. If the client *ignores* a seek while paused, then resuming would carry on from the old
//      position - the bar would have shown a place the music never went to, which is worse than
//      refusing the drag.
//   2. The UI holds its preview only until the playhead reaches the target, and a paused client may
//      well stop publishing progress samples (`audioPlayerPlayProgress$`). If it does, the seek
//      *reply* - `{code, position}` - is the only thing that can place the bar, which is what
//      `snapTo()` relies on.
//
// So this measures all three: whether the seek is accepted, whether the progress stream keeps
// running while paused, and where playback actually resumes from.

import { connectToNeteasePage, diagnoseChannel } from './lib/cdp-client.mjs';
import { bootstrapRequireExpression, discoverDvaExpression } from './lib/inject.mjs';
import { resolveStoreExpression } from './lib/probe.mjs';
import { createHost } from '../packages/host/src/index.ts';

function parseArgs(argv) {
  const out = { hostPort: 8790, seconds: 45 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--host-port') out.hostPort = Number(argv[++i]);
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

  // The bridge needs a moment to attach and publish its first snapshot.
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline && !host.currentSnapshot()) await delay(200);
  const first = host.currentSnapshot();
  if (!first) {
    console.error('✗ 宿主没有拿到快照（客户端在跑吗？）');
    process.exit(1);
  }

  session = await connectToNeteasePage({ port: 9223 });
  const page = (expr, awaitPromise = false) => session.evaluate(expr, { awaitPromise });
  await page(bootstrapRequireExpression());
  await page(discoverDvaExpression());
  await page(resolveStoreExpression());

  /** How often the client's own progress stream fires, over a short window. */
  const sampleProgress = async (ms = 1200) =>
    page(
      `(() => new Promise((resolve) => {
        const require = window.__moRequire;
        let stream = null;
        for (const id of Object.keys(require.c || {})) {
          let mod;
          try { mod = require(id); } catch (_) { continue; }
          if (mod && mod.audioPlayerPlayProgress$ && typeof mod.audioPlayerPlayProgress$.subscribe === 'function') { stream = mod.audioPlayerPlayProgress$; break; }
        }
        if (!stream) return resolve({ ok: false });
        let count = 0;
        let last = null;
        const sub = stream.subscribe((v) => { count++; last = Array.isArray(v) ? v.slice(0, 2) : null; });
        setTimeout(() => { try { sub.unsubscribe(); } catch (_) {} resolve({ ok: true, count, last }); }, ${ms});
      }))()`,
      true,
    );

  const position = () => host.currentSnapshot()?.playhead?.positionMs ?? null;
  const state = () => host.currentSnapshot()?.playback.rawPlayingState ?? null;
  const duration = first.song?.durationMs ?? 0;
  const startPosition = position() ?? 0;
  const target = Math.max(5000, Math.min(startPosition + args.seconds * 1000, Math.max(5000, duration - 10000)));

  console.log(`\n曲目: ${first.song?.name ?? '(无)'}  时长 ${Math.round(duration / 1000)}s`);
  console.log(`起点 ${Math.round(startPosition / 1000)}s → 跳到 ${Math.round(target / 1000)}s（暂停状态下）\n`);

  console.log('--- 暂停 ---');
  const paused = await host.control({ type: 'pause' });
  await delay(700);
  check('暂停被确认', paused.confirmed === true && state() === 1, `playingState=${state()} via=${paused.via}`);

  console.log('\n--- 暂停时的进度流 ---');
  const streamWhilePaused = await sampleProgress();
  check(
    '暂停时进度流仍在推送',
    (streamWhilePaused?.count ?? 0) > 0,
    `${streamWhilePaused?.count ?? 0} 次样本，最后 ${JSON.stringify(streamWhilePaused?.last ?? null)}`,
  );

  console.log('\n--- 暂停时跳转 ---');
  const seeked = await host.control({ type: 'seek', positionMs: Math.round(target) });
  await delay(900);
  check(
    '暂停时跳转被接受',
    seeked.ok === true && seeked.confirmed === true,
    `${seeked.message ?? ''} positionMs=${seeked.positionMs ?? '(无)'}`,
  );
  const afterSeek = position();
  check(
    '播放头到了目标',
    afterSeek != null && Math.abs(afterSeek - target) < 3000,
    `${Math.round((afterSeek ?? 0) / 1000)}s`,
  );

  console.log('\n--- 恢复 ---');
  const resumed = await host.control({ type: 'play' });
  await delay(1500);
  check('恢复播放被确认', resumed.confirmed === true && state() === 2, `playingState=${state()} via=${resumed.via}`);
  const afterResume = position();
  check(
    '从跳转点继续（而不是回到原处）',
    afterResume != null && Math.abs(afterResume - target) < 6000 && Math.abs(afterResume - startPosition) > 3000,
    `恢复后 ${Math.round((afterResume ?? 0) / 1000)}s，原处 ${Math.round(startPosition / 1000)}s`,
  );
} finally {
  // Always leave the client playing: the whole point is not to leave the owner's music paused.
  try {
    const snapshot = host.currentSnapshot();
    if (snapshot && snapshot.playback.rawPlayingState === 1) {
      console.log('\n（补一次播放，避免把音乐留在暂停）');
      await host.control({ type: 'play' });
    }
  } catch {
    /* nothing more to do */
  }
  session?.close();
  await host.stop();
}

console.log(`\n${problems.length ? `✗ ${problems.length} 项不符合预期：${problems.join('；')}` : '✓ 暂停时跳转、进度流与恢复都符合预期'}`);
process.exit(problems.length ? 1 : 0);
