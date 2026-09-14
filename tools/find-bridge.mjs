#!/usr/bin/env node
// Read-only: hunt for the player/native bridge that owns playback progress.
//
//   node tools/find-bridge.mjs [--port 9223] [--json]

import { connectToNeteasePage, diagnoseChannel, DEFAULT_CDP_PORT } from './lib/cdp-client.mjs';
import { bootstrapRequireExpression, discoverDvaExpression } from './lib/inject.mjs';
import { resolveStoreExpression } from './lib/probe.mjs';
import {
  findGlobalBridgeExpression,
  findPlayerModuleExpression,
  listAllTargetsExpression,
} from './lib/probe-bridge.mjs';

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
  console.error(`通道不可用（状态: ${diagnosis.state}）`);
  process.exit(1);
}

const session = await connectToNeteasePage({ port: args.port });
const report = {};
const step = async (name, expression) => {
  try {
    report[name] = await session.evaluate(expression);
  } catch (err) {
    report[name] = { ok: false, error: String(err.message ?? err) };
  }
};

try {
  await step('bootstrap', bootstrapRequireExpression());
  await step('discovery', discoverDvaExpression());
  await step('store', resolveStoreExpression());
  await step('globals', findGlobalBridgeExpression());
  await step('modules', findPlayerModuleExpression());
  await step('page', listAllTargetsExpression());
} finally {
  session.close();
}

if (args.json) {
  console.log(JSON.stringify(report, null, 2));
  process.exit(0);
}

console.log('=== page ===');
console.log(JSON.stringify(report.page, null, 2));

console.log('\n=== globals whose names look like a player/native bridge ===');
for (const h of report.globals?.hits ?? []) {
  console.log(`  window.${h.key}  (${h.kind})`);
  if (h.methods?.length) console.log(`      methods: ${h.methods.join(', ')}`);
  if (h.props?.length) console.log(`      props:   ${h.props.join(', ')}`);
}

console.log('\n=== modules exposing progress-like methods ===');
for (const h of report.modules?.timerHits ?? []) {
  console.log(`  module ${h.moduleId} [${h.bucket}]  fns=${h.fns.join(', ')}`);
  if (h.sample) console.log(`      sample: ${JSON.stringify(h.sample)}`);
}

console.log('\n=== modules exposing transport controls ===');
for (const h of report.modules?.controlHits ?? []) {
  console.log(`  module ${h.moduleId} [${h.bucket}]  fns=${h.fns.join(', ')}`);
}
