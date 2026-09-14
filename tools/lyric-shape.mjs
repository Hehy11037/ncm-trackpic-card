#!/usr/bin/env node
// Read-only: dump the lyric document the client itself holds for the current song.
//
//   node tools/lyric-shape.mjs [--port 9223] [--force]
//
// Purpose: decide whether the overlay should read lyrics from the client (version
// resilient, reuses the client's cache and session) or fetch them itself from the
// public endpoint. This prints the real structure, including word-level timings,
// instead of us guessing at it.

import { connectToNeteasePage, diagnoseChannel, DEFAULT_CDP_PORT } from './lib/cdp-client.mjs';
import { bootstrapRequireExpression, discoverDvaExpression, snapshotExpression } from './lib/inject.mjs';
import { resolveStoreExpression } from './lib/probe.mjs';

function parseArgs(argv) {
  const out = { port: DEFAULT_CDP_PORT, force: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port') out.port = Number(argv[++i]);
    else if (a === '--force') out.force = true;
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

/** Bounded deep describe: keeps a few elements of each array, truncates strings. */
const DESCRIBE = `
  const describe = (v, depth, seen) => {
    if (v === null || v === undefined) return v;
    const t = typeof v;
    if (t === 'number' || t === 'boolean') return v;
    if (t === 'string') return v.length > 90 ? v.slice(0, 90) + '…(' + v.length + ')' : v;
    if (t === 'function') return '[fn ' + (v.name || '') + ']';
    if (depth > 4) return '[depth]';
    if (seen.indexOf(v) >= 0) return '[circular]';
    seen.push(v);
    if (Array.isArray(v)) {
      return { __array: true, length: v.length, sample: v.slice(0, 3).map((x) => describe(x, depth + 1, seen)) };
    }
    const out = {};
    let n = 0;
    for (const k of Object.keys(v)) {
      if (n++ >= 28) { out['…'] = 'truncated'; break; }
      let val;
      try { val = v[k]; } catch (e) { out[k] = '[getter threw]'; continue; }
      out[k] = describe(val, depth + 1, seen);
    }
    return out;
  };
`;

try {
  await evalJson(bootstrapRequireExpression());
  await evalJson(discoverDvaExpression());
  await evalJson(resolveStoreExpression());

  const snap = await evalJson(snapshotExpression());
  console.log('=== 当前歌曲 ===');
  console.log(JSON.stringify({ name: snap?.name, songId: snap?.resourceId, state: snap?.playingState }, null, 2));

  const before = await evalJson(`(() => {
    const st = window.__moStore.getState();
    const l = st['async:lyric'] || {};
    return {
      isLoading: l.isLoading,
      currentUsedLyric: l.currentUsedLyric,
      currentUsedLyricVersion: l.currentUsedLyricVersion,
      lyricLines: Array.isArray(l.lyricLines) ? l.lyricLines.length : null,
      yrcInfoKeys: l.yrcInfo ? Object.keys(l.yrcInfo) : null,
      isLyricFetchFailed: l.isLyricFetchFailed,
    };
  })()`);
  console.log('\n=== 强制取歌词前 ===');
  console.log(JSON.stringify(before, null, 2));

  if (args.force) {
    console.log('\n→ dispatch async:lyric/fetchLyric {force:true} …');
    const dispatched = await evalJson(`(() => {
      try {
        window.__moStore.dispatch({ type: 'async:lyric/fetchLyric', payload: { force: true } });
        return { ok: true };
      } catch (err) {
        return { ok: false, error: String((err && err.message) || err) };
      }
    })()`);
    console.log(JSON.stringify(dispatched));
    await new Promise((r) => setTimeout(r, 2500));
  }

  const after = await evalJson(`(() => {
    ${DESCRIBE}
    const st = window.__moStore.getState();
    const l = st['async:lyric'] || {};
    const playing = st.playing || {};
    return {
      keys: Object.keys(l).sort(),
      isLoading: l.isLoading,
      currentUsedLyric: l.currentUsedLyric,
      currentUsedLyricVersion: l.currentUsedLyricVersion,
      offset: l.offset,
      isLyricFetchFailed: l.isLyricFetchFailed,
      lyricLines: describe(l.lyricLines, 0, []),
      tlyricLines: describe(l.tlyricLines, 0, []),
      romaLyricLines: describe(l.romaLyricLines, 0, []),
      yrcInfo: describe(l.yrcInfo, 0, []),
      playingLyric: describe(playing.playingLyric, 0, []),
      playingLyricLineNumber: playing.playingLyricLineNumber,
    };
  })()`);

  console.log('\n=== 客户端持有的歌词结构 ===');
  console.log(JSON.stringify(after, null, 2));
} finally {
  session.close();
}
