#!/usr/bin/env node
// Compare the lyrics the host is holding against a fresh public-API fetch.
//
//   node tools/diagnose-lyrics.mjs
//
// The reported symptom is that switching to one particular track shows the previous track's
// lyrics. That can happen in two places: the host caches the wrong document, or the overlay
// renders a stale one. This prints both sources so the difference is visible, along with the
// evidence a mismatch heuristic would use (credit lines naming the current track, timings).

import { connectToNeteasePage, diagnoseChannel, DEFAULT_CDP_PORT } from './lib/cdp-client.mjs';
import { bootstrapRequireExpression, discoverDvaExpression, snapshotExpression } from './lib/inject.mjs';
import { resolveStoreExpression } from './lib/probe.mjs';

const HOST = 'ws://127.0.0.1:8787';
const CDP_PORT = DEFAULT_CDP_PORT;

/* ------------------------------------------------------- what the client holds */

const diagnosis = await diagnoseChannel({ port: CDP_PORT });
let clientSlice = null;
let currentSongId = null;

if (diagnosis.state === 'ready') {
  const session = await connectToNeteasePage({ port: CDP_PORT });
  try {
    await session.evaluate(bootstrapRequireExpression());
    await session.evaluate(discoverDvaExpression());
    await session.evaluate(resolveStoreExpression());

    const snap = await session.evaluate(snapshotExpression());
    currentSongId = snap?.resourceId ?? null;

    clientSlice = await session.evaluate(`(() => {
      const st = window.__moStore.getState();
      const l = st['async:lyric'] || {};
      const playing = st.playing || {};
      return {
        playingSongId: Number(playing.resourceTrackId) || null,
        playingName: playing.resourceName || null,
        currentUsedLyric: l.currentUsedLyric,
        currentUsedLyricVersion: l.currentUsedLyricVersion,
        isLoading: !!l.isLoading,
        isLyricFetchFailed: !!l.isLyricFetchFailed,
        lineCount: Array.isArray(l.lyricLines) ? l.lyricLines.length : 0,
        firstLines: (Array.isArray(l.lyricLines) ? l.lyricLines : []).slice(0, 4).map((e) => ({
          time: e && e.time,
          lyric: e && e.lyric,
        })),
      };
    })()`);
  } finally {
    session.close();
  }
}

/* ------------------------------------------------------------- what the host has */

const host = await new Promise((resolve) => {
  const ws = new WebSocket(HOST);
  const state = { snapshot: null, lyrics: null, playhead: null };
  const timer = setTimeout(() => {
    ws.close();
    resolve(state);
  }, 3000);
  ws.addEventListener('open', () => {
    ws.send(JSON.stringify({ kind: 'requestSnapshot' }));
    ws.send(JSON.stringify({ kind: 'requestLyrics' }));
  });
  ws.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.kind === 'snapshot') state.snapshot = message.snapshot;
    if (message.kind === 'lyrics') state.lyrics = message.doc;
    if (message.kind === 'playhead') state.playhead = message.playhead;
  });
  ws.addEventListener('error', () => {
    clearTimeout(timer);
    resolve(state);
  });
});

/* ------------------------------------------------- a fresh fetch for that song id */

const songId = host.snapshot?.song?.id ?? currentSongId;
let publicLines = null;

if (songId) {
  const url =
    `https://music.163.com/api/song/lyric/v1?id=${songId}` +
    '&cp=false&lv=-1&kv=-1&tv=-1&rv=-1&yv=-1&ytv=-1&yrv=-1';
  try {
    const res = await fetch(url, {
      headers: { referer: 'https://music.163.com/', 'user-agent': 'Mozilla/5.0' },
    });
    const json = await res.json();
    const lrc = json?.lrc?.lyric ?? '';
    const yrc = json?.yrc?.lyric ?? '';
    const source = lrc || yrc;
    publicLines = source
      .split('\n')
      .filter((line) => /\[\d/.test(line))
      .slice(0, 4)
      .map((line) => line.trim().slice(0, 90));
  } catch (err) {
    publicLines = [`fetch failed: ${err.message}`];
  }
}

/* ------------------------------------------------------------------- reporting */

console.log('=== 客户端当前状态 ===');
console.log(JSON.stringify(clientSlice, null, 2));

console.log('\n=== 当前歌曲 ===');
console.log(JSON.stringify(host.snapshot?.song ?? { id: currentSongId }, null, 2));

console.log('\n=== 宿主内存里的歌词 ===');
if (!host.lyrics) {
  console.log('  (宿主没有返回歌词文档)');
} else {
  console.log(`  songId: ${host.lyrics.songId}   来源: ${host.lyrics.source}   行数: ${host.lyrics.lines.length}`);
  for (const line of host.lyrics.lines.slice(0, 4)) {
    console.log(`    [${String(line.startMs).padStart(7)}] ${line.text.trim().slice(0, 80)}`);
  }
}

console.log('\n=== 公开接口为同一 songId 返回的歌词 ===');
if (!publicLines) console.log('  (未获取)');
else for (const line of publicLines) console.log(`    ${line}`);

console.log('\n=== 判定 ===');
const hostFirst = host.lyrics?.lines?.[0]?.text?.trim() ?? null;
const publicFirst = publicLines?.[0]?.replace(/^\[\d+[:.]\d+\]/, '').trim() ?? null;
if (hostFirst && publicFirst) {
  const same = hostFirst.slice(0, 8) === publicFirst.slice(0, 8);
  console.log(same ? '  ✅ 宿主歌词与公开接口首行一致' : '  ❌ 首行不一致 —— 宿主很可能缓存了别的歌的歌词');
  console.log(`     宿主: ${hostFirst.slice(0, 60)}`);
  console.log(`     公开: ${publicFirst.slice(0, 60)}`);
} else {
  console.log('  (无法比较：有一侧没有歌词)');
}
