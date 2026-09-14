#!/usr/bin/env node
// Read-only: bootstrap a webpack `require` inside the client page and locate the
// dva store singleton, then print a first playback snapshot.
//
//   node tools/discover.mjs [--port 9223] [--json]
//
// This is the phase-0 gate: it proves we can reach playback state without
// hardcoding any webpack module ids. See tools/lib/inject.mjs for why.

import { connectToNeteasePage, diagnoseChannel, DEFAULT_CDP_PORT } from './lib/cdp-client.mjs';
import { bootstrapRequireExpression, discoverDvaExpression, snapshotExpression } from './lib/inject.mjs';

function parseArgs(argv) {
  const out = { port: DEFAULT_CDP_PORT, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') out.json = true;
    else if (a === '--port') out.port = Number(argv[++i]);
    else if (a.startsWith('--port=')) out.port = Number(a.slice(7));
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const diagnosis = await diagnoseChannel({ port: args.port });
if (diagnosis.state !== 'ready') {
  console.error(`通道不可用（状态: ${diagnosis.state}）。先运行: node tools/probe-cdp.mjs`);
  process.exit(1);
}

const session = await connectToNeteasePage({ port: args.port });
const result = { port: args.port, bootstrap: null, discovery: null, snapshot: null };

try {
  result.bootstrap = await session.evaluate(bootstrapRequireExpression());
  if (result.bootstrap?.ok || result.bootstrap?.reason === 'all chunk ids rejected') {
    // Even when every id looks rejected, a previous attempt may have captured it.
    result.discovery = await session.evaluate(discoverDvaExpression());
  }
  if (result.discovery?.ok) {
    result.snapshot = await session.evaluate(snapshotExpression());
  }
} finally {
  session.close();
}

if (args.json) {
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.discovery?.ok ? 0 : 1);
}

console.log('=== 1. 自举 webpack require ===');
console.log(JSON.stringify(result.bootstrap, null, 2));

console.log('\n=== 2. 运行时模块发现（找 dva 单例）===');
console.log(JSON.stringify(result.discovery, null, 2));

console.log('\n=== 3. 播放状态快照 ===');
if (result.snapshot?.ok) {
  const s = result.snapshot;
  console.log(`歌曲:      ${s.name ?? '(未知)'} - ${s.artists.join(' / ') || '(未知)'}`);
  console.log(`专辑:      ${s.albumName ?? '(未知)'}`);
  console.log(`歌曲 ID:   ${s.resourceId ?? '(未知)'}`);
  console.log(`播放状态:  ${s.playingState ?? '(未知)'}   模式: ${s.playingMode ?? '(未知)'}`);
  console.log(`音量:      ${s.playingVolume ?? '(未知)'}   静音: ${s.mute ?? '(未知)'}`);
  console.log(`时长(ms):  ${s.durationMs ?? '(未知)'}   playId: ${s.playId ?? '(未知)'}`);
  console.log(`队列:      ${s.queueLength} 首  ${JSON.stringify(s.queueIds)}`);
  console.log(`封面:      ${s.coverUrl ?? '(未知)'}`);
  console.log(`\nplaying 字段: ${s.playingKeys.join(', ')}`);
  console.log(`track 字段:   ${s.curTrackKeys.join(', ')}`);
} else {
  console.log(JSON.stringify(result.snapshot, null, 2));
}

process.exit(result.discovery?.ok ? 0 : 1);
