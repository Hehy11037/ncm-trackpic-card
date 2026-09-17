#!/usr/bin/env node
// Does changing the play mode actually do what the mode means?
//
//   node tools/probe-mode-action.mjs [--host-port 8790]
//
// The card's mode button is one command, `setMode`, and for a while it dispatched the last line of
// the client's own mode effect rather than the effect itself. The mode changed, the client's icon
// followed, and everything looked right - but the shuffle was missing: entering 随机播放 through the
// effect re-draws every queue entry's `randomOrder`, and the hand-rolled write did not. "Random"
// would then replay the previous random order.
//
// So this checks the *meaning* of the mode, not the state field: it reads the queue's randomOrder
// values, sends the command through the host and bridge, and reads them again. Pauses nothing and
// changes no audio - the mode is put back the way it was found.

import { connectToNeteasePage, diagnoseChannel } from './lib/cdp-client.mjs';
import { bootstrapRequireExpression, discoverDvaExpression } from './lib/inject.mjs';
import { resolveStoreExpression } from './lib/probe.mjs';
import { createHost } from '../packages/host/src/index.ts';

function parseArgs(argv) {
  const out = { hostPort: 8790, cdpPort: 9223 };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--host-port') out.hostPort = Number(argv[++i]);
    else if (argv[i] === '--cdp-port') out.cdpPort = Number(argv[++i]);
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

const diagnosis = await diagnoseChannel({ port: args.cdpPort });
if (diagnosis.state !== 'ready') {
  console.error(`通道不可用（状态: ${diagnosis.state}）`);
  process.exit(1);
}

const READ = `(() => {
  const state = window.__moStore.getState();
  const playing = state.playing || {};
  const list = (state.playingList && state.playingList.curPlayingList) || [];
  return {
    mode: playing.playingMode,
    lastMode: playing.lastPlayingMode,
    randomOrder: list.slice(0, 8).map((x) => (x && x.randomOrder) || null),
  };
})()`;

const problems = [];
const check = (name, ok, detail = '') => {
  if (!ok) problems.push(name);
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? `  ${detail}` : ''}`);
};

const host = createHost({
  cdpPort: args.cdpPort,
  hostPort: args.hostPort,
  uiPort: 0,
  log: (level, message) => {
    if (level === 'warn' || level === 'error') console.log(`[host:${level}] ${message}`);
  },
});

const session = await connectToNeteasePage({ port: args.cdpPort }).catch(() => null);
try {
  await host.start();
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline && !host.currentSnapshot()) await delay(200);
  if (!host.currentSnapshot()) {
    console.error('✗ 宿主没有拿到快照');
    process.exit(1);
  }

  const page = (expr) => session.evaluate(expr);
  await page(bootstrapRequireExpression());
  await page(discoverDvaExpression());
  await page(resolveStoreExpression());

  const before = await page(READ);
  console.log(`\n起始模式 ${before.mode}（lastMode ${before.lastMode}）`);
  console.log(`randomOrder: ${before.randomOrder.join(' ')}\n`);

  const toRandom = await host.control({ type: 'setMode', mode: 'playRandom' });
  await delay(900);
  const afterRandom = await page(READ);
  console.log(`改为随机 → ${afterRandom.mode}，randomOrder: ${afterRandom.randomOrder.join(' ')}`);

  check('随机模式被确认', toRandom.confirmed === true, toRandom.message ?? '');
  check('模式确实变了', afterRandom.mode === 'playRandom', `现在是 ${afterRandom.mode}`);
  check(
    '随机顺序被重新抽取',
    JSON.stringify(before.randomOrder) !== JSON.stringify(afterRandom.randomOrder),
    'randomOrder 变了才是真的洗牌；没变说明走的不是客户端自己的动作',
  );

  // Put the mode back before anything else can be affected by it.
  const restore = await host.control({ type: 'setMode', mode: before.mode });
  await delay(800);
  const after = await page(READ);
  check('模式已还原', after.mode === before.mode, `现在是 ${after.mode}`);
  check('还原也被确认', restore.confirmed === true, restore.message ?? '');
} finally {
  session?.close();
  await host.stop();
}

console.log(`\n${problems.length ? `✗ ${problems.length} 项不符合预期：${problems.join('；')}` : '✓ 模式命令按客户端的语义生效'}`);
process.exit(problems.length ? 1 : 0);
