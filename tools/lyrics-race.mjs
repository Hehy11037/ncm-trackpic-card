#!/usr/bin/env node
// Time-series observation of the client's lyric store around a track change.
//
//   node tools/lyrics-race.mjs [--seconds 20]
//
// The host was found holding the previous track's 77 lines under the new track's id. The
// bridge reads the store on every change, so if the client keeps the old lyrics in place for
// a moment after switching tracks, the bridge forwards them stamped with the new id. This
// watches the store's identity fields over time to confirm the window and to see whether the
// client ever refreshes by itself.

import { connectToNeteasePage, diagnoseChannel, DEFAULT_CDP_PORT } from './lib/cdp-client.mjs';
import { bootstrapRequireExpression, discoverDvaExpression } from './lib/inject.mjs';
import { resolveStoreExpression } from './lib/probe.mjs';

const args = process.argv.slice(2);
let seconds = 20;
for (let i = 0; i < args.length; i++) if (args[i] === '--seconds') seconds = Number(args[++i]);

const diagnosis = await diagnoseChannel({ port: DEFAULT_CDP_PORT });
if (diagnosis.state !== 'ready') {
  console.error(`通道不可用（${diagnosis.state}）`);
  process.exit(1);
}

const session = await connectToNeteasePage({ port: DEFAULT_CDP_PORT });
const evaluate = async (expression, awaitPromise = false) => {
  try {
    return await session.evaluate(expression, { awaitPromise });
  } catch (err) {
    return { error: String(err.message ?? err) };
  }
};

try {
  await evaluate(bootstrapRequireExpression());
  await evaluate(discoverDvaExpression());
  await evaluate(resolveStoreExpression());

  const read = `(() => {
    const st = window.__moStore.getState();
    const l = st['async:lyric'] || {};
    const playing = st.playing || {};
    const lines = Array.isArray(l.lyricLines) ? l.lyricLines : [];
    return JSON.stringify({
      song: playing.resourceName || null,
      songId: Number(playing.resourceTrackId) || null,
      version: l.currentUsedLyricVersion,
      used: l.currentUsedLyric,
      loading: !!l.isLoading,
      failed: !!l.isLyricFetchFailed,
      count: lines.length,
      first: lines[0] && lines[0].lyric ? String(lines[0].lyric).slice(0, 40) : null,
      last: lines.length && lines[lines.length-1] && lines[lines.length-1].lyric
        ? String(lines[lines.length-1].lyric).slice(0, 40) : null,
    });
  })()`;

  console.log('轮询客户端歌词 store（每 500ms）…\n');
  const ticks = Math.max(4, Math.round((seconds * 1000) / 500));
  let previousKey = null;

  for (let i = 0; i < ticks; i++) {
    const raw = await evaluate(read);
    const state = typeof raw === 'string' ? JSON.parse(raw) : raw;
    const key = `${state.songId}|${state.version}|${state.count}|${state.loading ? 1 : 0}`;

    if (key !== previousKey) {
      console.log(
        `[${String(i * 0.5).padStart(5)}s] ${String(state.song ?? '?')}  ` +
          `id=${state.songId}  ver=${state.version}  used=${state.used}  ` +
          `loading=${state.loading ? 'Y' : 'N'}  failed=${state.failed ? 'Y' : 'N'}  ` +
          `行数=${String(state.count).padStart(3)}`,
      );
      console.log(`          首行: ${state.first ?? '(无)'}`);
      if (state.count > 6) console.log(`          末行: ${state.last ?? '(无)'}`);
      previousKey = key;
    }

    await new Promise((r) => setTimeout(r, 500));
  }

  // Fetch what the public endpoint has for the current song, for comparison.
  const finalRaw = await evaluate(read);
  const finalState = typeof finalRaw === 'string' ? JSON.parse(finalRaw) : finalRaw;
  if (finalState?.songId) {
    const url =
      `https://music.163.com/api/song/lyric/v1?id=${finalState.songId}` +
      '&cp=false&lv=-1&kv=-1&tv=-1&rv=-1&yv=-1&ytv=-1&yrv=-1';
    try {
      const res = await fetch(url, {
        headers: { referer: 'https://music.163.com/', 'user-agent': 'Mozilla/5.0' },
      });
      const json = await res.json();
      const text = json?.lrc?.lyric ?? json?.yrc?.lyric ?? '';
      const lines = text.split('\n').filter((l) => /\[\d/.test(l));
      console.log(`\n公开接口（id=${finalState.songId}）: ${lines.length} 行`);
      console.log(`  首行: ${lines[0]?.slice(0, 70) ?? '(无)'}`);
    } catch (err) {
      console.log(`\n公开接口请求失败: ${err.message}`);
    }
  }
} finally {
  session.close();
}
