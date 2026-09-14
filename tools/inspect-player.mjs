#!/usr/bin/env node
// Read-only: introspect the dva app and the player-control modules to find where
// playback position lives and what control surface is callable.
//
//   node tools/inspect-player.mjs [--port 9223] [--json]

import { connectToNeteasePage, diagnoseChannel, DEFAULT_CDP_PORT } from './lib/cdp-client.mjs';
import { bootstrapRequireExpression, discoverDvaExpression } from './lib/inject.mjs';
import { resolveStoreExpression } from './lib/probe.mjs';
import { appIntrospectExpression, playerModuleExpression } from './lib/probe-app.mjs';

function parseArgs(argv) {
  const out = { port: DEFAULT_CDP_PORT, json: false, modules: ['716', '1186', '685', '30'] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') out.json = true;
    else if (a === '--port') out.port = Number(argv[++i]);
    else if (a === '--modules') out.modules = argv[++i].split(',').map((s) => s.trim());
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
const report = { modules: {} };
const step = async (name, expression) => {
  try {
    return await session.evaluate(expression);
  } catch (err) {
    return { ok: false, error: String(err.message ?? err) };
  }
};

try {
  await step('bootstrap', bootstrapRequireExpression());
  await step('discovery', discoverDvaExpression());
  report.store = await step('store', resolveStoreExpression());
  report.app = await step('app', appIntrospectExpression());
  for (const id of args.modules) {
    report.modules[id] = await step('module', playerModuleExpression(id));
  }
} finally {
  session.close();
}

if (args.json) {
  console.log(JSON.stringify(report, null, 2));
  process.exit(0);
}

console.log('=== dva app ===');
console.log(JSON.stringify(report.app, null, 2));

for (const [id, info] of Object.entries(report.modules)) {
  console.log(`\n=== module ${id} exports ===`);
  if (!info) {
    console.log('  (no result)');
    continue;
  }
  if (info.ok === false) {
    console.log(`  failed: ${info.reason ?? info.error}`);
    continue;
  }
  for (const [name, desc] of Object.entries(info.exports ?? {})) {
    console.log(`  ${name}: ${desc}`);
  }
}
