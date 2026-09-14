// Development entry point for the host: runs it in the foreground and prints a
// live view of what the overlay would receive.
//
//   node tools/host-run.mjs [--cdp-port 9223] [--host-port 8787] [--ui-port 8788]
//                           [--ui-root <dir>] [--quiet]
//
// This is the thing to keep running while building the overlay: it turns the
// client's playback into a stream of HostMessages on ws://127.0.0.1:8787.
//
// The Electron shell launches this same file, so the desktop app and the dev
// workflow cannot drift apart.

import { createHost, DEFAULT_HOST_PORT, DEFAULT_UI_PORT } from '../packages/host/src/index.ts';
import { DEFAULT_CDP_PORT } from '../packages/host/src/cdp.ts';

function parseArgs(argv) {
  const out = {
    cdpPort: DEFAULT_CDP_PORT,
    hostPort: DEFAULT_HOST_PORT,
    uiPort: DEFAULT_UI_PORT,
    uiRoot: undefined,
    quiet: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--quiet') out.quiet = true;
    else if (a === '--cdp-port') out.cdpPort = Number(argv[++i]);
    else if (a === '--host-port') out.hostPort = Number(argv[++i]);
    else if (a === '--ui-port') out.uiPort = Number(argv[++i]);
    else if (a === '--ui-root') out.uiRoot = argv[++i];
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));

const host = createHost({
  cdpPort: args.cdpPort,
  hostPort: args.hostPort,
  uiPort: args.uiPort,
  uiRoot: args.uiRoot,
  log: (level, message) => {
    if (args.quiet && level !== 'warn' && level !== 'error') return;
    const stamp = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    console.log(`[${stamp}] ${level.padEnd(5)} ${message}`);
  },
});

let lastSongKey = null;
let lastStatus = null;

await host.start();

const timer = setInterval(() => {
  const snapshot = host.currentSnapshot();
  if (!snapshot) return;
  const songKey = `${snapshot.song?.id ?? 'none'}|${snapshot.song?.name ?? ''}`;
  const status = snapshot.playback.status;
  if (songKey !== lastSongKey || status !== lastStatus) {
    lastSongKey = songKey;
    lastStatus = status;
    const artists = (snapshot.song?.artists ?? []).map((a) => a.name).join(' / ');
    const pos = snapshot.playhead ? `${Math.round(snapshot.playhead.positionMs / 1000)}s` : '—';
    console.log(
      `♪ ${snapshot.song?.name ?? '(无)'} — ${artists || '(未知)'}  [${status}]  ${pos}` +
        `  队列 ${snapshot.queue.index != null ? snapshot.queue.index + 1 : '?'}/${snapshot.queue.length}` +
        (snapshot.chorus ? `  副歌 ${Math.round(snapshot.chorus.startMs / 1000)}s` : ''),
    );
  }
}, 250);

console.log('\n宿主运行中。按 Ctrl+C 退出。');
console.log(`界面端请连接 ws://127.0.0.1:${args.hostPort}\n`);

let shuttingDown = false;
const shutdown = async () => {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(timer);
  console.log('\n正在停止宿主…');
  await host.stop();
  console.log('已停止。');
  process.exit(0);
};

process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
