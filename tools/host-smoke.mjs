// Live end-to-end harness for phase 1.
//
//   node tools/host-smoke.mjs [--seconds 12] [--send]
//
// Starts the real host (CDP -> discovery -> bridge -> loopback broadcast),
// connects a fake overlay client with Node's built-in WebSocket, and reports what
// actually arrives. Exits non-zero if the essential path is broken.

import { createHost } from '../packages/host/src/index.ts';

function parseArgs(argv) {
  const out = { seconds: 12, send: false, hostPort: 8787, cdpPort: 9223 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--send') out.send = true;
    else if (a === '--seconds') out.seconds = Number(argv[++i]);
    else if (a === '--host-port') out.hostPort = Number(argv[++i]);
    else if (a === '--cdp-port') out.cdpPort = Number(argv[++i]);
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const counts = { hello: 0, connection: 0, snapshot: 0, playhead: 0, lyrics: 0, error: 0 };
let lastSnapshot = null;
let lastPlayhead = null;
let firstPlayheadAt = null;
let lastPlayheadAt = null;
const connectionStates = new Set();

const host = createHost({
  cdpPort: args.cdpPort,
  hostPort: args.hostPort,
  log: (level, message) => {
    if (level === 'debug') return;
    console.log(`[host:${level}] ${message}`);
  },
});

await host.start();

const ws = new WebSocket(`ws://127.0.0.1:${args.hostPort}`);
const opened = await new Promise((resolve) => {
  const timer = setTimeout(() => resolve(false), 5000);
  ws.addEventListener('open', () => {
    clearTimeout(timer);
    resolve(true);
  });
  ws.addEventListener('error', () => {
    clearTimeout(timer);
    resolve(false);
  });
});

if (!opened) {
  console.error('❌ 无法连接到宿主 WebSocket');
  await host.stop();
  process.exit(1);
}
console.log('✅ 界面端已连接宿主');

ws.addEventListener('message', (ev) => {
  let msg;
  try {
    msg = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data));
  } catch {
    return;
  }
  if (msg.kind in counts) counts[msg.kind] += 1;
  if (msg.kind === 'connection') connectionStates.add(msg.connection?.state);
  if (msg.kind === 'snapshot') lastSnapshot = msg.snapshot;
  if (msg.kind === 'playhead') {
    lastPlayhead = msg.playhead;
    if (firstPlayheadAt == null) firstPlayheadAt = Date.now();
    lastPlayheadAt = Date.now();
  }
});

// Force the host to resend current state.
ws.send(JSON.stringify({ kind: 'requestSnapshot' }));

if (args.send) {
  await new Promise((r) => setTimeout(r, 500));
  console.log('→ 发送控制指令 playPause');
  const result = await host.control({ type: 'playPause' });
  console.log(`   结果: ok=${result.ok} via=${result.via} ${result.message ?? ''}`);
  await new Promise((r) => setTimeout(r, 500));
  const result2 = await host.control({ type: 'playPause' });
  console.log(`   回切: ok=${result2.ok} via=${result2.via} ${result2.message ?? ''}`);
}

await new Promise((r) => setTimeout(r, args.seconds * 1000));

console.log('\n=== 收到的消息统计 ===');
console.log(JSON.stringify(counts, null, 2));
console.log('connection 状态:', JSON.stringify([...connectionStates]));

if (lastSnapshot) {
  const s = lastSnapshot;
  console.log('\n=== 最后的快照 ===');
  console.log(`  歌曲:   ${s.song?.name ?? '(无)'} — ${(s.song?.artists ?? []).map((a) => a.name).join(' / ')}`);
  console.log(`  歌曲ID: ${s.song?.id ?? '(无)'}`);
  console.log(`  时长:   ${s.song?.durationMs ?? '(无)'} ms`);
  console.log(`  封面:   ${s.song?.coverUrl ? '有' : '无'}`);
  console.log(`  状态:   ${s.playback.status} (raw=${s.playback.rawPlayingState})  模式=${s.playback.mode}  音量=${s.playback.volume}`);
  console.log(`  队列:   ${s.queue.length} 首, 当前索引=${s.queue.index}`);
  console.log(`  副歌:   ${s.chorus ? `${s.chorus.startMs}–${s.chorus.endMs} ms` : '(无)'}`);
  console.log(`  歌词行: ${s.lyricLine}`);
}

if (lastPlayhead) {
  const span = lastPlayheadAt - firstPlayheadAt;
  console.log('\n=== 进度流 ===');
  console.log(`  最后位置: ${lastPlayhead.positionMs} ms  playId=${lastPlayhead.playId}  样本数=${lastPlayhead.sampleCount}`);
  console.log(`  首末间隔: ${span} ms 内收到 ${counts.playhead} 条`);
  if (span > 0) {
    const rate = Math.round((counts.playhead / span) * 1000);
    console.log(`  速率:     约 ${rate} 次/秒`);
  }
} else {
  console.log('\n⚠️  未收到任何进度事件（音乐当前可能是暂停状态，属正常）。');
  console.log('   请在播放中重跑本工具以验证进度链路。');
}

ws.close();
await host.stop();

const ok = counts.hello > 0 && counts.snapshot > 0 && connectionStates.has('ready');
console.log(`\n${ok ? '✅' : '❌'} 阶段1 联调${ok ? '通过' : '未通过'}（hello+snapshot+ready 为必需）`);
process.exit(ok ? 0 : 1);
