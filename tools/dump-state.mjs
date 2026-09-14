#!/usr/bin/env node
// Read-only: deep reconnaissance of the running client's playback state.
//
//   node tools/dump-state.mjs [--port 9223] [--json]
//
// Answers the questions phase 0 must settle before the host is written:
//   * where does current playback progress (milliseconds) actually live?
//   * what is the exact shape of the lyric data the client already has?
//   * which module owns the internal request layer (for fetching lyrics
//     through the client instead of re-implementing the public API)?

import { connectToNeteasePage, diagnoseChannel, DEFAULT_CDP_PORT } from './lib/cdp-client.mjs';
import { bootstrapRequireExpression, discoverDvaExpression, snapshotExpression } from './lib/inject.mjs';
import {
  resolveStoreExpression,
  audioProbeExpression,
  findApiModuleExpression,
  playbackDetailExpression,
} from './lib/probe.mjs';

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

const step = async (name, expression, awaitPromise = false) => {
  try {
    report[name] = await session.evaluate(expression, { awaitPromise });
  } catch (err) {
    report[name] = { ok: false, error: String(err.message ?? err) };
  }
};

try {
  await step('bootstrap', bootstrapRequireExpression());
  await step('discovery', discoverDvaExpression());
  await step('storeHandle', resolveStoreExpression());
  await step('audio', audioProbeExpression());
  await step('snapshot', snapshotExpression());
  await step('detail', playbackDetailExpression());
  await step('apiModule', findApiModuleExpression());

  // Sample the audio clock twice to prove progress is observable in real time.
  const first = await session.evaluate(
    '(() => { const a = window.__moAudio; return a ? a.currentTime : null; })()',
  );
  await new Promise((r) => setTimeout(r, 1200));
  const second = await session.evaluate(
    '(() => { const a = window.__moAudio; return a ? a.currentTime : null; })()',
  );
  report.clockSample = { first, second, deltaMs: second != null && first != null ? second - first : null };
} finally {
  session.close();
}

if (args.json) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log('=== store handle ===');
  console.log(JSON.stringify(report.storeHandle, null, 2));

  console.log('\n=== audio element ===');
  console.log(JSON.stringify(report.audio, null, 2));

  console.log('\n=== clock sample (1.2s apart) ===');
  console.log(JSON.stringify(report.clockSample, null, 2));

  console.log('\n=== lyric state seen by the client ===');
  console.log(JSON.stringify(report.detail?.lyric, null, 2));
  console.log('async:lyric slice:');
  console.log(JSON.stringify(report.detail?.asyncLyricSlice, null, 2));

  console.log('\n=== resource / playback fields ===');
  console.log(JSON.stringify(report.detail?.keyPlayingFields, null, 2));
  console.log('curPlaying keys:', JSON.stringify(report.detail?.curPlayingKeys));
  console.log('curTrack keys:  ', JSON.stringify(report.detail?.curTrackKeys));

  console.log('\n=== internal api module candidates ===');
  console.log(JSON.stringify(report.apiModule, null, 2));
}
