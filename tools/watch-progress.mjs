#!/usr/bin/env node
// Read-only: watch the client's playback progress in real time.
//
//   node tools/watch-progress.mjs [--port 9223] [--seconds 12]
//
// This is the phase-0 acceptance check for progress. It subscribes to the audio
// pipeline's audioPlayerPlayProgress$ and prints a timeline, so we can confirm we
// really can drive a smooth lyric scroll from the client's own clock.
// Run it while the client is PLAYING (it prints a warning if playback is paused).

import { connectToNeteasePage, diagnoseChannel, DEFAULT_CDP_PORT } from './lib/cdp-client.mjs';
import { bootstrapRequireExpression, discoverDvaExpression } from './lib/inject.mjs';
import { resolveStoreExpression } from './lib/probe.mjs';

function parseArgs(argv) {
  const out = { port: DEFAULT_CDP_PORT, seconds: 12 };
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

  // Subscribe to every pipeline stream and keep the last value of each, plus a
  // rolling log so we can see the emission rate.
  const install = await evalJson(`(() => {
    const require = window.__moRequire;
    if (typeof require !== 'function') return { ok: false, reason: 'no require' };
    const mod = require('1186');
    if (!mod) return { ok: false, reason: 'module 1186 missing' };
    if (window.__moSubs) { for (const s of window.__moSubs) { try { s.unsubscribe(); } catch (_) {} } }
    window.__moWatch = { last: {}, counts: {}, events: [] };
    window.__moSubs = [];
    const names = Object.keys(mod).filter((n) => {
      const v = mod[n];
      return v && typeof v === 'object' && typeof v.subscribe === 'function';
    });
    for (const name of names) {
      try {
        const sub = mod[name].subscribe((v) => {
          let d = v;
          try {
            if (v && typeof v === 'object') {
              d = JSON.parse(JSON.stringify(v, (k, val) => (typeof val === 'function' ? '[fn]' : val)));
            }
          } catch (_) { d = String(v); }
          window.__moWatch.last[name] = d;
          window.__moWatch.counts[name] = (window.__moWatch.counts[name] || 0) + 1;
          if (window.__moWatch.events.length < 200) {
            window.__moWatch.events.push({ t: Date.now(), name, value: d });
          }
        });
        window.__moSubs.push(sub);
      } catch (_) {}
    }
    return { ok: true, subscribed: names };
  })()`);

  const initial = await evalJson(`(() => {
    const st = window.__moStore.getState();
    return {
      song: st.playing.resourceName,
      songId: Number(st.playing.resourceTrackId) || null,
      playingState: st.playing.playingState,
      durationSec: st.playing.resourceDuration,
      lyricLine: st.playing.playingLyricLineNumber,
    };
  })()`);

  console.log('=== 当前歌曲 ===');
  console.log(JSON.stringify(initial, null, 2));
  console.log(`\n订阅到的流: ${JSON.stringify(install?.subscribed)}`);
  if (initial?.playingState === 1) {
    console.log('\n⚠️  playingState=1 且未观察到状态变化时，说明客户端可能处于暂停/停止状态。');
    console.log('   请在网易云里按播放，再重新运行本工具。');
  }

  console.log('\n=== 时间线（每 400ms）===');
  const ticks = Math.max(2, Math.round((args.seconds * 1000) / 400));
  for (let i = 0; i < ticks; i++) {
    await new Promise((r) => setTimeout(r, 400));
    const t = await evalJson(`(() => {
      const w = window.__moWatch || { counts: {}, last: {} };
      const st = window.__moStore.getState();
      return {
        elapsed: w.last['audioPlayerPlayProgress$'] ?? null,
        playState: w.last['audioPlayerPlayState$'] ?? null,
        seekSeconds: w.last['audioPlayerSeekSeconds$'] ?? null,
        counts: w.counts,
        lyricLine: st.playing.playingLyricLineNumber,
      };
    })()`);
    const progress =
      t.elapsed && typeof t.elapsed === 'object'
        ? JSON.stringify(t.elapsed)
        : JSON.stringify(t.elapsed);
    const counts = t.counts
      ? Object.entries(t.counts).map(([k, v]) => `${k.replace('audioPlayer', '').replace('$', '')}=${v}`).join(' ')
      : '';
    console.log(
      `  #${String(i).padStart(2)}  progress=${String(progress).padEnd(34)} lyricLine=${String(t.lyricLine).padEnd(5)} ${counts}`,
    );
  }

  const final = await evalJson(
    `(() => { const w = window.__moWatch || {}; return { counts: w.counts, last: w.last, sampleEvents: (w.events || []).slice(-10) }; })()`,
  );
  console.log('\n=== 汇总 ===');
  console.log(JSON.stringify(final, null, 2));

  await evalJson(
    '(() => { if (window.__moSubs) { for (const s of window.__moSubs) { try { s.unsubscribe(); } catch (_) {} } window.__moSubs = []; } return true; })()',
  );
} finally {
  session.close();
}
