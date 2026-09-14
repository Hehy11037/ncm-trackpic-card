// Design reconnaissance: pull TrackPic's actual stylesheet and extract the numbers
// that define its layout (card size, cover size, type scale, spacing, palette).
//
//   node tools/trackpic-design.mjs
//
// The reference site is a 9:16 wallpaper maker. We want its proportions and type
// scale, not its code, so this only reads and reports.

const BASE = 'https://pic-kn.github.io/trackpic/';

const res = await fetch(BASE, { headers: { 'user-agent': 'Mozilla/5.0' } });
if (!res.ok) {
  console.error(`page fetch failed: HTTP ${res.status}`);
  process.exit(1);
}
const html = await res.text();
console.log(`page: ${html.length} bytes`);

const assets = [...new Set([...html.matchAll(/(?:href|src)="([^"]+\.(?:css|js))"/g)].map((m) => m[1]))];
console.log('\n=== assets referenced ===');
for (const asset of assets) console.log(`  ${asset}`);

const cssUrls = assets
  .filter((a) => a.endsWith('.css'))
  .map((a) => new URL(a, BASE).href);

if (!cssUrls.length) {
  console.log('\n(no stylesheet link found - checking for inline styles)');
}

for (const url of cssUrls) {
  const cssRes = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0' } });
  if (!cssRes.ok) {
    console.log(`\nCSS fetch failed: ${url} HTTP ${cssRes.status}`);
    continue;
  }
  const css = await cssRes.text();
  console.log(`\n=== ${url} (${css.length} bytes) ===`);

  // Report the design-relevant declarations rather than dumping everything.
  const interesting = [
    /width:\s*[^;]+/g,
    /height:\s*[^;]+/g,
    /aspect-ratio:\s*[^;]+/g,
    /font-size:\s*[^;]+/g,
    /font-family:\s*[^;]+/g,
    /font-weight:\s*[^;]+/g,
    /letter-spacing:\s*[^;]+/g,
    /line-height:\s*[^;]+/g,
    /border-radius:\s*[^;]+/g,
    /padding:\s*[^;]+/g,
    /gap:\s*[^;]+/g,
    /--[a-z0-9-]+:\s*#[0-9a-fA-F]{3,8}/g,
  ];

  const seen = new Map();
  for (const pattern of interesting) {
    for (const match of css.matchAll(pattern)) {
      const value = match[0];
      seen.set(value, (seen.get(value) ?? 0) + 1);
    }
  }

  console.log('\n-- most common design declarations --');
  const sorted = [...seen.entries()].sort((a, b) => b[1] - a[1]);
  for (const [value, count] of sorted.slice(0, 70)) {
    console.log(`  ${String(count).padStart(3)}x  ${value.slice(0, 96)}`);
  }

  console.log('\n-- @font-face / font families --');
  for (const match of css.matchAll(/font-family:\s*([^;}]+)/g)) {
    console.log(`  ${match[1].slice(0, 110)}`);
  }
  for (const match of css.matchAll(/@font-face\s*\{[^}]*\}/g)) {
    const block = match[0];
    const family = /font-family:\s*([^;}]+)/.exec(block)?.[1];
    const src = /src:\s*url\(([^)]+)\)/.exec(block)?.[1];
    console.log(`  @font-face ${family ?? '?'} -> ${src ?? '?'}`);
  }

  console.log('\n-- aspect / size rules --');
  for (const match of css.matchAll(/(?:aspect-ratio|width|height):\s*[^;}]+/g)) {
    const value = match[0];
    if (/9\s*\/\s*16|1320|2868|1080|1920|2400|3200/.test(value)) console.log(`  ${value}`);
  }
}
