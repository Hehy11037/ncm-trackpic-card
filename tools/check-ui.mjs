#!/usr/bin/env node
// Verify that the host serves the overlay UI correctly.
//
//   node tools/check-ui.mjs [--ui-port 8788] [--host-port 8787]
//
// Checks the pieces that can be checked headlessly: the config endpoint, every
// file the UI loads, their content types, and that path traversal is refused. The
// visual result still needs a browser, but a broken asset path shows up here.

const args = process.argv.slice(2);
let uiPort = 8788;
let hostPort = 8787;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--ui-port') uiPort = Number(args[++i]);
  else if (args[i] === '--host-port') hostPort = Number(args[++i]);
}

const base = `http://127.0.0.1:${uiPort}`;
const ASSETS = [
  ['/', 'text/html'],
  ['/config.json', 'application/json'],
  ['/styles/tokens.css', 'text/css'],
  ['/styles/card.css', 'text/css'],
  ['/src/main.js', 'text/javascript'],
  ['/src/card.js', 'text/javascript'],
  ['/src/clock.js', 'text/javascript'],
  ['/src/layout.js', 'text/javascript'],
  ['/src/lyrics.js', 'text/javascript'],
  ['/src/palette.js', 'text/javascript'],
  ['/src/socket.js', 'text/javascript'],
];

let failures = 0;

console.log(`检查界面服务 ${base}\n`);

for (const [path, expectedType] of ASSETS) {
  try {
    const res = await fetch(base + path);
    const contentType = res.headers.get('content-type') ?? '';
    const body = await res.text();
    const typeOk = contentType.includes(expectedType.split(';')[0]);
    const sizeOk = body.length > 0;
    if (res.ok && typeOk && sizeOk) {
      console.log(`  ok    ${path.padEnd(22)} ${res.status}  ${contentType.split(';')[0]}  ${body.length}B`);
    } else {
      failures++;
      console.log(`  FAIL  ${path.padEnd(22)} ${res.status}  ${contentType}  ${body.length}B`);
    }
  } catch (err) {
    failures++;
    console.log(`  FAIL  ${path.padEnd(22)} ${err.message}`);
  }
}

console.log('\n--- config.json content ---');
try {
  const res = await fetch(`${base}/config.json`);
  const config = await res.json();
  console.log(JSON.stringify(config, null, 2));
  if (config.hostPort !== hostPort) {
    console.log(`  note: config hostPort=${config.hostPort}, expected ${hostPort} (pass --host-port to match)`);
  }
} catch (err) {
  failures++;
  console.log(`  FAIL: ${err.message}`);
}

console.log('\n--- path traversal must be refused ---');
for (const probe of ['/../package.json', '/..%2fpackage.json', '/src/../../package.json']) {
  try {
    const res = await fetch(base + probe);
    const refused = res.status === 403 || res.status === 404;
    console.log(`  ${refused ? 'ok   ' : 'FAIL '} ${probe.padEnd(28)} -> ${res.status}`);
    if (!refused) failures++;
  } catch (err) {
    console.log(`  FAIL  ${probe.padEnd(28)} ${err.message}`);
    failures++;
  }
}

console.log('\n--- WebSocket reachable? ---');
try {
  const ws = new WebSocket(`ws://127.0.0.1:${hostPort}`);
  const outcome = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve('timeout'), 4000);
    ws.addEventListener('open', () => {
      clearTimeout(timer);
      resolve('open');
    });
    ws.addEventListener('error', () => {
      clearTimeout(timer);
      resolve('error');
    });
  });
  console.log(`  ${outcome === 'open' ? 'ok   ' : 'FAIL '} ws://127.0.0.1:${hostPort} -> ${outcome}`);
  if (outcome !== 'open') failures++;
  ws.close();
} catch (err) {
  console.log(`  FAIL  ${err.message}`);
  failures++;
}

console.log(`\n${failures ? `❌ ${failures} 项失败` : '✅ 界面服务检查通过'}`);
process.exit(failures ? 1 : 0);
