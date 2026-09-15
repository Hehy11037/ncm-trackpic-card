// Syntax-check the generated bridge script without executing it.
//
//   node tools/check-bridge-script.mjs
//
// The bridge is assembled from template strings, so a stray edit can produce a
// script that only fails once injected into the live client. This catches that.

import vm from 'node:vm';

import { buildBridgeScript } from '../packages/host/src/bridge-script.ts';

for (const audioModuleId of ['1186', '9999']) {
  const source = buildBridgeScript({ audioModuleId });
  try {
    // eslint-disable-next-line no-new
    new vm.Script(source, { filename: `bridge-${audioModuleId}.js` });
    console.log(`ok   audioModuleId=${audioModuleId}  (${source.length} chars)`);
  } catch (err) {
    console.error(`FAIL audioModuleId=${audioModuleId}: ${err.message}`);
    // Print the offending line for a quick fix.
    const lineMatch = /bridge-\d+\.js:(\d+)/.exec(err.stack ?? '');
    if (lineMatch) {
      const lines = source.split('\n');
      const n = Number(lineMatch[1]);
      for (let i = Math.max(0, n - 3); i < Math.min(lines.length, n + 2); i++) {
        console.error(`${String(i + 1).padStart(4)} | ${lines[i]}`);
      }
    }
    process.exitCode = 1;
  }
}

// Also assert the pieces the host relies on are present.
const source = buildBridgeScript({ audioModuleId: '1186' });
const required = [
  'audioPlayerPlayProgress$',
  'async:lyric/fetchLyric',
  "send('lyrics'",
  "send('state'",
  "send('progress'",
  '__moCmdQ',
  '__moBridge',
];
for (const needle of required) {
  if (!source.includes(needle)) {
    console.error(`MISSING from bridge: ${needle}`);
    process.exitCode = 1;
  }
}

/*
 * Every command the overlay can send must be handled by the bridge, and everything the overlay
 * actually sends must be one of those.
 *
 * This is the check that would have caught play/pause being dead. `ControlCommand` declared
 * `playPause`, the UI sent `playPause` from the button and the space bar, and the bridge's switch
 * had no case for it - so the largest control on the card fell through to `default` and threw
 * `unsupported command: playPause` on every single press. Nothing failed loudly: the type was
 * legal, the button looked wired up, and the only trace was a line in the host's log.
 */
{
  const { readFileSync } = await import('node:fs');

  /** Command types the shared contract allows. */
  // Anchored on the newline: the union's own members contain `;` (`{ type: 'setVolume'; volume }`),
  // so a naive "up to the first semicolon" stops two members early.
  const union = /export type ControlCommand =([\s\S]*?);\s*\n/.exec(
    readFileSync('packages/shared/src/types.ts', 'utf8'),
  )?.[1] ?? '';
  const declared = [...union.matchAll(/type:\s*'([a-zA-Z]+)'/g)].map((m) => m[1]);

  /**
   * Command types the bridge's command switch answers to.
   *
   * Scoped to the `execute` function: the generated script has other switches, and counting their
   * cases would let an unhandled command look handled.
   */
  const executeBody = source.slice(
    source.indexOf('const execute = (command) => {'),
    source.indexOf('const timer = setInterval'),
  );
  const handled = [...executeBody.matchAll(/case\s*'([a-zA-Z]+)'\s*:/g)].map((m) => m[1]);

  /** Command types the overlay sends: literals in the scripts, and the buttons' data-action. */
  const sent = [
    ...[...readFileSync('ui/src/main.js', 'utf8').matchAll(/control\(\{\s*type:\s*'([a-zA-Z]+)'/g)].map(
      (m) => m[1],
    ),
    ...[...readFileSync('ui/index.html', 'utf8').matchAll(/data-action="([a-zA-Z]+)"/g)].map((m) => m[1]),
  ];

  console.log(`\n指令契约: 声明 ${declared.length} 种，桥接处理 ${handled.length} 种，界面发送 ${new Set(sent).size} 种`);

  for (const type of declared) {
    const ok = handled.includes(type);
    if (!ok) process.exitCode = 1;
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} 桥接处理 ${type}`);
  }
  for (const type of new Set(sent)) {
    const ok = declared.includes(type) && handled.includes(type);
    if (!ok) process.exitCode = 1;
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} 界面发送的 ${type} 有实现`);
  }
}

console.log(process.exitCode ? '\n桥接脚本检查未通过' : '\n桥接脚本检查通过');
