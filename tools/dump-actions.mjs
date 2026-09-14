#!/usr/bin/env node
// Read-only: print individual captured actions in order, optionally filtered.
//
//   node tools/dump-actions.mjs [--match <substring>] [--limit 30]

import { connectToNeteasePage, diagnoseChannel } from './lib/cdp-client.mjs';

function parseArgs(argv) {
  const out = { match: null, limit: 30, port: 9223 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--match') out.match = argv[++i];
    else if (a === '--limit') out.limit = Number(argv[++i]);
    else if (a === '--port') out.port = Number(argv[++i]);
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
try {
  const result = await session.evaluate(`(() => {
    const d = window.__moDisp;
    if (!d) return { ok: false, reason: 'recorder not armed' };
    const all = d.actions;
    const match = ${JSON.stringify(args.match)};
    const filtered = match ? all.filter((a) => a.type.includes(match)) : all;
    return {
      ok: true,
      total: all.length,
      matched: filtered.length,
      actions: filtered.slice(-${args.limit}),
    };
  })()`);

  if (!result?.ok) {
    console.log(JSON.stringify(result, null, 2));
    process.exit(1);
  }

  console.log(`总动作 ${result.total}，匹配 ${result.matched}，显示最后 ${result.actions.length} 条\n`);
  for (const a of result.actions) {
    console.log(`--- ${a.type}`);
    if (a.payload !== null && a.payload !== undefined) {
      console.log(JSON.stringify(a.payload, null, 2).split('\n').slice(0, 40).join('\n'));
    }
    console.log('');
  }
} finally {
  session.close();
}
