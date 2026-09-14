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
console.log(process.exitCode ? '\n桥接脚本检查未通过' : '\n桥接脚本检查通过');
