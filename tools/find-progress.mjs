#!/usr/bin/env node
// Read-only: locate playback progress and callable player controls at runtime.
//
//   node tools/find-progress.mjs [--port 9223] [--json]
//
// Phase-0 question this answers: the Redux `playing` slice has no currentTime
// field, and the bundle creates no <audio> element, so progress must be read from
// somewhere else (a stream, the WebAudio graph, or the dva lyric slice). This
// script enumerates those surfaces instead of guessing.

import { connectToNeteasePage, diagnoseChannel, DEFAULT_CDP_PORT } from './lib/cdp-client.mjs';
import { bootstrapRequireExpression, discoverDvaExpression } from './lib/inject.mjs';
import { resolveStoreExpression } from './lib/probe.mjs';
import { findProgressExpression, listActionsExpression, findControlsExpression } from './lib/probe-deep.mjs';

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
  await step('actions', listActionsExpression());
  await step('progress', findProgressExpression());
  await step('controls', findControlsExpression());
} finally {
  session.close();
}

if (args.json) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log('=== resolved dva actions ===');
  console.log('namespaces:', JSON.stringify(report.actions?.namespaces));
  console.log('playing actions:', JSON.stringify(report.actions?.playingActions, null, 2));
  console.log('lyric actions:', JSON.stringify(report.actions?.lyricActions, null, 2));

  console.log('\n=== progress-like values found in the state tree ===');
  console.log(JSON.stringify(report.progress?.progressLike, null, 2));

  console.log('\n=== localStorage hits ===');
  console.log(JSON.stringify(report.progress?.localStorageHits, null, 2));

  console.log('\n=== observable streams / controls ===');
  console.log(JSON.stringify(report.controls, null, 2));
}
