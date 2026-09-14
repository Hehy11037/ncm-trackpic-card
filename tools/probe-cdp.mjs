#!/usr/bin/env node
// Read-only: report whether the NetEase client is exposing its local debug channel.
//
//   node tools/probe-cdp.mjs [--port 9223] [--json]
//
// Distinguishes the three states that need different user-facing fixes:
//   client-not-running  -> start NetEase Cloud Music
//   needs-relaunch      -> running, but without --remote-debugging-port
//   ready               -> channel usable

import { diagnoseChannel, listTargets, DEFAULT_CDP_PORT } from './lib/cdp-client.mjs';

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

let targets = [];
if (diagnosis.state === 'ready' || diagnosis.state === 'no-target') {
  try {
    targets = (await listTargets({ port: args.port })).targets;
  } catch {
    /* keep the diagnosis as-is */
  }
}

if (args.json) {
  console.log(JSON.stringify({ ...diagnosis, targets }, null, 2));
  process.exit(diagnosis.state === 'ready' ? 0 : 1);
}

const messages = {
  ready: '✅ 控制通道已开启，可以开始同步',
  'no-target': `⚠️  调试端口已开，但没找到 orpheus:// 页面目标（客户端可能还在启动，稍后重试）`,
  'needs-relaunch':
    '⚠️  客户端正在运行，但没有带调试端口。需要关闭后用 tools/relaunch-ncm.ps1 重启一次（会中断当前播放，登录态保留）',
  'client-not-running': '⚠️  网易云音乐没有在运行，请先启动客户端',
};

console.log(`端口: 127.0.0.1:${args.port}`);
console.log(
  `客户端进程: ${diagnosis.running ? `运行中（${diagnosis.processCount} 个进程）` : '未运行'}`,
);
console.log(`状态: ${diagnosis.state}`);
console.log(messages[diagnosis.state] ?? '未知状态');
if (targets.length) {
  console.log('\n调试目标:');
  for (const t of targets) {
    console.log(`  - [${t.type}] ${t.title || '(no title)'}`);
    console.log(`      ${t.url}`);
  }
}
process.exit(diagnosis.state === 'ready' ? 0 : 1);
