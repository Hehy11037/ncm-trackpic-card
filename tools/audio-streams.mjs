#!/usr/bin/env node
// Read-only: sample the client's audio pipeline streams (progress, state, seek)
// and learn the control API's calling convention from real call sites.
//
//   node tools/audio-streams.mjs [--port 9223] [--module 1186] [--json]

import { connectToNeteasePage, diagnoseChannel, DEFAULT_CDP_PORT } from './lib/cdp-client.mjs';
import { bootstrapRequireExpression, discoverDvaExpression } from './lib/inject.mjs';
import { sampleAudioStreamsExpression, findControlCallSitesExpression } from './lib/probe-audio.mjs';

function parseArgs(argv) {
  const out = { port: DEFAULT_CDP_PORT, json: false, moduleId: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') out.json = true;
    else if (a === '--port') out.port = Number(argv[++i]);
    else if (a === '--module') out.moduleId = String(argv[++i]);
  }
  return out;
}

/** Locate the audio pipeline module by looking for audioPlayerPlayProgress$. */
const FIND_AUDIO_MODULE = `(() => {
  const require = window.__moRequire;
  if (typeof require !== 'function') return { ok: false, reason: 'no require' };
  const cache = require.c || {};
  for (const id of Object.keys(cache)) {
    let mod;
    try { mod = require(id); } catch (_) { continue; }
    if (!mod) continue;
    const keys = Object.keys(mod);
    if (keys.indexOf('audioPlayerPlayProgress$') >= 0) {
      return { ok: true, moduleId: id, keys };
    }
  }
  return { ok: false, reason: 'audio pipeline module not found in require cache' };
})()`;

const args = parseArgs(process.argv.slice(2));
const diagnosis = await diagnoseChannel({ port: args.port });
if (diagnosis.state !== 'ready') {
  console.error(`通道不可用（状态: ${diagnosis.state}）`);
  process.exit(1);
}

const session = await connectToNeteasePage({ port: args.port });
const report = {};
const step = async (name, expr, awaitPromise = false) => {
  try {
    return await session.evaluate(expr, { awaitPromise });
  } catch (err) {
    return { ok: false, error: String(err.message ?? err) };
  }
};

try {
  await step('bootstrap', bootstrapRequireExpression());
  await step('discovery', discoverDvaExpression());

  let moduleId = args.moduleId;
  if (!moduleId) {
    const found = await step('find', FIND_AUDIO_MODULE);
    report.found = found;
    moduleId = found?.moduleId;
  }
  if (!moduleId) {
    console.error('找不到音频管道模块');
    process.exit(1);
  }
  report.moduleId = moduleId;

  report.streams = await step('streams', sampleAudioStreamsExpression(moduleId), true);
  report.callSites = await step('callSites', findControlCallSitesExpression(moduleId));
} finally {
  session.close();
}

if (args.json) {
  console.log(JSON.stringify(report, null, 2));
  process.exit(0);
}

console.log(`音频管道模块: ${report.moduleId}`);
if (report.found?.keys) console.log(`导出: ${report.found.keys.join(', ')}`);

console.log('\n=== 流采样（订阅约 0.3s）===');
for (const r of report.streams?.results ?? []) {
  console.log(`\n  ${r.name}`);
  console.log(`    initial:  ${JSON.stringify(r.initial)}`);
  console.log(`    samples:  ${JSON.stringify(r.samples)}`);
}
if (!report.streams?.results?.length) console.log(JSON.stringify(report.streams, null, 2));

console.log('\n=== 控制方法的真实调用点 ===');
for (const h of report.callSites?.hits ?? []) {
  console.log(`\n  module ${h.moduleId} [${h.exportName}]  mentioned=${JSON.stringify(h.mentioned)} pipeline=${h.touchesPipeline}`);
  console.log(`    ${h.excerpt?.slice(0, 500)}`);
}
if (!report.callSites?.hits?.length) console.log(JSON.stringify(report.callSites, null, 2));
