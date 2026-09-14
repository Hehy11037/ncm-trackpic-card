// Extract the design parameters TrackPic uses when drawing its 9:16 artwork.
//
//   node tools/trackpic-canvas.mjs
//
// The site's chrome is a control panel; what we care about is the composition it
// draws on the canvas (type sizes, spacing, colour handling). Those numbers live in
// the page chunk, so this pulls it and reports the relevant literals.

const BASE = 'https://pic-kn.github.io/trackpic/';
const CHUNK = '/trackpic/_next/static/chunks/app/page-15338c13801fbe91.js';

const res = await fetch(BASE + CHUNK.replace('/trackpic/', ''), {
  headers: { 'user-agent': 'Mozilla/5.0' },
});
if (!res.ok) {
  console.error(`chunk fetch failed: HTTP ${res.status}`);
  process.exit(1);
}
const source = await res.text();
console.log(`chunk: ${source.length} bytes\n`);

function report(label, pattern, limit = 40) {
  const matches = [...source.matchAll(pattern)].map((m) => m[0]);
  const unique = [...new Set(matches)];
  console.log(`=== ${label} (${unique.length} unique) ===`);
  for (const value of unique.slice(0, limit)) console.log(`  ${value.slice(0, 150)}`);
  console.log('');
}

// Canvas text sizing and spacing.
report('font declarations', /font\s*=\s*[`'"][^`'"]{2,110}[`'"]/g);
report('font shorthand calls', /ctx\.font[^;]{0,90}/g);
report('letterSpacing / tracking', /letterSpacing[^,;]{0,60}/g);
report('fillText / strokeText calls', /(?:fillText|strokeText)\([^;]{0,80}/g);

// Layout maths: padding, margins, offsets used in the drawing code.
report('numeric layout constants', /(?:padding|margin|gap|offset|lineHeight|titleY|artistY|coverSize|blockSize)\s*[:=]\s*-?\d+(?:\.\d+)?/g);
report('hex colours in the chunk', /#[0-9a-fA-F]{6}\b/g, 60);
report('rgb/rgba literals', /rgba?\([^)]{5,60}\)/g, 40);

// Palette extraction internals tell us how the five colours are chosen.
report('palette helpers', /(?:MMCQ|quantiz|dominant|palette|swatch|median)[A-Za-z]*/g, 40);

// Background handling: this is what we need for the six-option background picker.
report('background handling', /(?:background|bg|fillRect|clearRect)[A-Za-z]*\s*[=(][^;]{0,70}/g, 50);
