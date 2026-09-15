/**
 * A minimal SVG path reader, enough to inspect and rasterise this project's own icons.
 *
 * Why this exists: the card's mode and volume glyphs are hand-written `<path d="...">` strings, and
 * no check in this repository could tell a wrong icon from a right one - they are not laid out, so
 * the layout check ignores them, and there is no browser in the tooling shell to look at them with
 * (`tools/shot.mjs` cannot run here). "It looks fine" was therefore the entire evidence.
 *
 * So the paths are parsed and scanned here instead. Two uses:
 *
 *  - `pathBounds` answers "is this glyph actually inside its viewBox, and is it a shape rather than
 *    a sliver in one corner" from `check-interaction.mjs`;
 *  - `renderIcon` / `encodePng` (see tools/render-icons.mjs) turn them into a PNG, so the icons can
 *    be *looked at* rather than imagined.
 *
 * Only the subset this project uses is supported: M/L/H/V/C/S/Q/T/A/Z, absolute and relative. An
 * unsupported command is an error rather than a silent skip - a half-parsed icon that renders as a
 * partial shape is exactly the failure this is meant to catch.
 */

import zlib from 'node:zlib';

const NUMBER = /[+-]?(?:\d*\.\d+|\d+\.?)(?:[eE][+-]?\d+)?/g;
/** Split a path's `d` into commands with their numeric arguments. */
function tokenize(d) {
  const out = [];
  const commandRe = /([MmLlHhVvCcSsQqTtAaZz])([^MmLlHhVvCcSsQqTtAaZz]*)/g;
  let match;
  while ((match = commandRe.exec(d)) !== null) {
    const args = (match[2].match(NUMBER) ?? []).map(Number);
    out.push({ command: match[1], args });
  }
  return out;
}

/** How many arguments each command takes; a command may repeat its argument group. */
const ARITY = { M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, A: 7, Z: 0 };

/**
 * An elliptical arc, as a list of points.
 *
 * Straight out of the SVG specification's endpoint-to-centre conversion (F.6.5). It is here rather
 * than approximated because the speaker's sound waves are arcs, and a wrong arc turns a speaker
 * into a comma - which is precisely the kind of thing this file exists to make visible.
 */
function arcPoints(x0, y0, rx, ry, rotationDeg, largeArc, sweep, x1, y1, segments = 24) {
  if (rx === 0 || ry === 0 || (x0 === x1 && y0 === y1)) return [[x1, y1]];
  const phi = (rotationDeg * Math.PI) / 180;
  const cos = Math.cos(phi);
  const sin = Math.sin(phi);

  // Step 1: the midpoint, in the ellipse's own frame.
  const dx = (x0 - x1) / 2;
  const dy = (y0 - y1) / 2;
  const x1p = cos * dx + sin * dy;
  const y1p = -sin * dx + cos * dy;

  // Step 2: correct out-of-range radii.
  const lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
  if (lambda > 1) {
    const scale = Math.sqrt(lambda);
    rx *= scale;
    ry *= scale;
  }

  const sign = largeArc === sweep ? -1 : 1;
  const numerator = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
  const denominator = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
  const coefficient = sign * Math.sqrt(Math.max(0, numerator / denominator));
  const cxp = (coefficient * rx * y1p) / ry;
  const cyp = (-coefficient * ry * x1p) / rx;

  // Step 3: back to user space.
  const cx = cos * cxp - sin * cyp + (x0 + x1) / 2;
  const cy = sin * cxp + cos * cyp + (y0 + y1) / 2;

  const angle = (ux, uy, vx, vy) => {
    const dot = ux * vx + uy * vy;
    const len = Math.hypot(ux, uy) * Math.hypot(vx, vy);
    const value = Math.acos(Math.max(-1, Math.min(1, dot / (len || 1))));
    return ux * vy - uy * vx < 0 ? -value : value;
  };

  const start = angle(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
  let delta = angle((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry);
  if (!sweep && delta > 0) delta -= 2 * Math.PI;
  else if (sweep && delta < 0) delta += 2 * Math.PI;

  const points = [];
  const steps = Math.max(4, Math.round(segments * Math.abs(delta) / (Math.PI / 2)));
  for (let i = 1; i <= steps; i++) {
    const theta = start + (delta * i) / steps;
    points.push([
      cx + rx * Math.cos(theta) * cos - ry * Math.sin(theta) * sin,
      cy + rx * Math.cos(theta) * sin + ry * Math.sin(theta) * cos,
    ]);
  }
  return points;
}

/**
 * Parse a `d` attribute into subpaths of points.
 *
 * Curves are flattened by sampling: enough for inspection and for the rasteriser, and it keeps this
 * file to the one thing it needs to be.
 */
export function parsePath(d) {
  const subpaths = [];
  let current = [];
  let x = 0;
  let y = 0;
  let startX = 0;
  let startY = 0;
  let lastControl = null;
  let lastCommand = '';

  const push = (px, py) => {
    current.push([px, py]);
  };
  const finish = () => {
    if (current.length > 1) subpaths.push(current);
    current = [];
  };

  for (const { command, args } of tokenize(d)) {
    const upper = command.toUpperCase();
    const relative = command !== upper;
    const arity = ARITY[upper];
    if (arity === undefined) throw new Error(`unsupported SVG command: ${command}`);
    if (upper !== 'Z' && args.length === 0) throw new Error(`command ${command} has no arguments`);
    if (upper !== 'Z' && args.length % arity !== 0 && !(arity === 0)) {
      throw new Error(`command ${command} takes a multiple of ${arity} arguments, got ${args.length}`);
    }

    for (let at = 0; at < (arity === 0 ? 1 : args.length / arity); at++) {
      const a = args.slice(at * arity, at * arity + arity);
      // A repeated group after an `M` is an implicit `L`; that is what `m/L` in this file means.
      const effective = upper === 'M' && at > 0 ? 'L' : upper;
      const dx = relative ? x : 0;
      const dy = relative ? y : 0;

      switch (effective) {
        case 'M':
          finish();
          x = a[0] + dx;
          y = a[1] + dy;
          startX = x;
          startY = y;
          push(x, y);
          lastControl = null;
          break;
        case 'L':
          x = a[0] + dx;
          y = a[1] + dy;
          push(x, y);
          lastControl = null;
          break;
        case 'H':
          x = a[0] + dx;
          push(x, y);
          lastControl = null;
          break;
        case 'V':
          y = a[0] + dy;
          push(x, y);
          lastControl = null;
          break;
        case 'C': {
          const [c1x, c1y, c2x, c2y, ex, ey] = a;
          const points = [];
          for (let i = 1; i <= 16; i++) {
            const t = i / 16;
            const mt = 1 - t;
            points.push([
              mt * mt * mt * x + 3 * mt * mt * t * (c1x + dx) + 3 * mt * t * t * (c2x + dx) + t * t * t * (ex + dx),
              mt * mt * mt * y + 3 * mt * mt * t * (c1y + dy) + 3 * mt * t * t * (c2y + dy) + t * t * t * (ey + dy),
            ]);
          }
          x = ex + dx;
          y = ey + dy;
          for (const p of points) push(p[0], p[1]);
          lastControl = [c2x + dx, c2y + dy];
          break;
        }
        case 'S': {
          const [c2x, c2y, ex, ey] = a;
          const c1x = lastControl ? 2 * x - lastControl[0] : x;
          const c1y = lastControl ? 2 * y - lastControl[1] : y;
          const points = [];
          for (let i = 1; i <= 16; i++) {
            const t = i / 16;
            const mt = 1 - t;
            points.push([
              mt * mt * mt * x + 3 * mt * mt * t * c1x + 3 * mt * t * t * (c2x + dx) + t * t * t * (ex + dx),
              mt * mt * mt * y + 3 * mt * mt * t * c1y + 3 * mt * t * t * (c2y + dy) + t * t * t * (ey + dy),
            ]);
          }
          x = ex + dx;
          y = ey + dy;
          for (const p of points) push(p[0], p[1]);
          lastControl = [c2x + dx, c2y + dy];
          break;
        }
        case 'Q':
        case 'T': {
          const qx = effective === 'Q' ? a[0] + dx : lastControl ? 2 * x - lastControl[0] : x;
          const qy = effective === 'Q' ? a[1] + dy : lastControl ? 2 * y - lastControl[1] : y;
          const ex = effective === 'Q' ? a[2] + dx : a[0] + dx;
          const ey = effective === 'Q' ? a[3] + dy : a[1] + dy;
          const points = [];
          for (let i = 1; i <= 16; i++) {
            const t = i / 16;
            const mt = 1 - t;
            points.push([
              mt * mt * x + 2 * mt * t * qx + t * t * ex,
              mt * mt * y + 2 * mt * t * qy + t * t * ey,
            ]);
          }
          x = ex;
          y = ey;
          for (const p of points) push(p[0], p[1]);
          lastControl = [qx, qy];
          break;
        }
        case 'A': {
          const [rx, ry, rotation, largeArc, sweep, ex, ey] = a;
          const points = arcPoints(x, y, rx, ry, rotation, !!largeArc, !!sweep, ex + dx, ey + dy);
          x = ex + dx;
          y = ey + dy;
          for (const p of points) push(p[0], p[1]);
          lastControl = null;
          break;
        }
        case 'Z':
          x = startX;
          y = startY;
          if (current.length) push(x, y);
          finish();
          lastControl = null;
          break;
        default:
          throw new Error(`unhandled SVG command: ${effective}`);
      }
      lastCommand = effective;
    }
    void lastCommand;
  }
  finish();
  return subpaths;
}

/** Signed area; used to give generated stroke polygons one consistent winding. */
export function polygonArea(points) {
  let sum = 0;
  for (let i = 0; i < points.length; i++) {
    const [x0, y0] = points[i];
    const [x1, y1] = points[(i + 1) % points.length];
    sum += x0 * y1 - x1 * y0;
  }
  return sum / 2;
}

/**
 * A stroke, as filled polygons.
 *
 * The volume icon needs this: its sound waves are `fill: none; stroke: currentColor`, and a
 * fill-only rasteriser draws them as nothing at all - which is exactly how the mute cross turned out
 * to be a hollow outline rather than a cross, and how it stayed that way (an icon that is not laid
 * out is invisible to every other check in this repository).
 *
 * Each segment becomes a quad, and each vertex a small disc so joins and caps are round. Every
 * generated polygon is wound the same way: with the nonzero rule, two overlapping polygons of
 * opposite winding cancel and punch a hole at exactly the joins.
 */
export function strokeToSubpaths(subpaths, width) {
  const half = Math.max(0.01, width / 2);
  const out = [];
  const wound = (points) => (polygonArea(points) < 0 ? [...points].reverse() : points);

  for (const sub of subpaths) {
    for (let i = 0; i < sub.length - 1; i++) {
      const [x0, y0] = sub[i];
      const [x1, y1] = sub[i + 1];
      const dx = x1 - x0;
      const dy = y1 - y0;
      const length = Math.hypot(dx, dy);
      if (length < 1e-6) continue;
      const nx = (-dy / length) * half;
      const ny = (dx / length) * half;
      out.push(wound([[x0 + nx, y0 + ny], [x1 + nx, y1 + ny], [x1 - nx, y1 - ny], [x0 - nx, y0 - ny]]));
    }
    for (const [cx, cy] of sub) {
      const disc = [];
      for (let i = 0; i < 16; i++) {
        const angle = (i / 16) * Math.PI * 2;
        disc.push([cx + half * Math.cos(angle), cy + half * Math.sin(angle)]);
      }
      out.push(wound(disc));
    }
  }
  return out;
}

/** Fill and/or stroke a path into one set of polygons for the rasteriser. */
export function styledSubpaths(subpaths, { fill = true, strokeWidth = 0 } = {}) {
  const out = [];
  if (fill) out.push(...subpaths);
  if (strokeWidth > 0) out.push(...strokeToSubpaths(subpaths, strokeWidth));
  return out;
}

/** The axis-aligned bounds of every point in a set of subpaths. */
export function pathBounds(subpaths) {
  const xs = [];
  const ys = [];
  for (const sub of subpaths) {
    for (const [px, py] of sub) {
      xs.push(px);
      ys.push(py);
    }
  }
  if (!xs.length) return null;
  return {
    minX: Math.min(...xs),
    maxX: Math.max(...xs),
    minY: Math.min(...ys),
    maxY: Math.max(...ys),
    width: Math.max(...xs) - Math.min(...xs),
    height: Math.max(...ys) - Math.min(...ys),
  };
}

/**
 * Fill polygons with the nonzero winding rule, 4x supersampled into an alpha buffer.
 *
 * Scanline with a crossing list rather than a winding-number pass: the icons are small, and this is
 * the version whose behaviour can be reasoned about by reading it.
 */
export function rasterizeAlpha(subpaths, size, { scale = null } = {}) {
  const factor = scale ?? 4; // supersampling
  const W = size * factor;
  const H = size * factor;
  const coverage = new Float32Array(size * size);

  // Edges in device pixels, from the 0..24 user space of every icon here.
  const unit = W / 24;
  const edges = [];
  for (const sub of subpaths) {
    for (let i = 0; i < sub.length - 1; i++) {
      const [x0, y0] = sub[i];
      const [x1, y1] = sub[i + 1];
      if (y0 === y1) continue;
      edges.push([x0 * unit, y0 * unit, x1 * unit, y1 * unit]);
    }
  }
  if (!edges.length) return coverage;

  const yMin = Math.max(0, Math.floor(Math.min(...edges.map((e) => Math.min(e[1], e[3])))));
  const yMax = Math.min(H - 1, Math.ceil(Math.max(...edges.map((e) => Math.max(e[1], e[3])))));

  for (let py = yMin; py <= yMax; py++) {
    const yc = py + 0.5;
    const crossings = [];
    for (const [x0, y0, x1, y1] of edges) {
      const dir = y1 > y0 ? 1 : -1;
      if (yc >= Math.min(y0, y1) && yc < Math.max(y0, y1)) {
        const t = (yc - y0) / (y1 - y0);
        crossings.push([x0 + (x1 - x0) * t, dir]);
      }
    }
    if (crossings.length < 2) continue;
    crossings.sort((a, b) => a[0] - b[0]);
    let winding = 0;
    for (let i = 0; i < crossings.length - 1; i++) {
      winding += crossings[i][1];
      if (winding === 0) continue;
      const from = crossings[i][0];
      const to = crossings[i + 1][0];
      for (let px = Math.max(0, Math.floor(from)); px <= Math.min(W - 1, Math.ceil(to) - 1); px++) {
        const left = Math.max(from, px);
        const right = Math.min(to, px + 1);
        if (right > left) {
          coverage[Math.floor(py / factor) * size + Math.floor(px / factor)] +=
            (right - left) / (factor * factor);
        }
      }
    }
  }
  for (let i = 0; i < coverage.length; i++) coverage[i] = Math.min(1, coverage[i]);
  return coverage;
}

/**
 * Compose a strip: icons placed at absolute positions along one line.
 *
 * `renderSheet` lays icons out in a grid, which cannot answer a question about *layout* - "is the
 * play button on the card's centre line, and do the five fit?" So this places each icon by its
 * centre in the row's own coordinate system, which is what `tools/transport-layout.mjs` computes
 * from the stylesheet. The result is a picture of the arrangement, at whatever scale is legible,
 * without a browser.
 *
 * @param {{ subpaths: number[][][], fill: boolean, strokeWidth: number, centre: number, size: number }[]} items
 *   `centre` and `size` are in the row's units, and `unitPx` says how many pixels one is.
 */
export function composeStrip(items, { widthPx, unitPx, rowHeightPx, padding = 6, background = 255 }) {
  const height = rowHeightPx + padding * 2;
  const rgba = Buffer.alloc(widthPx * height * 4, background);
  for (let i = 3; i < rgba.length; i += 4) rgba[i] = 255;

  for (const item of items) {
    const size = Math.max(4, Math.round(item.size * unitPx));
    const alpha = rasterizeAlpha(styledSubpaths(item.subpaths, { fill: item.fill, strokeWidth: item.strokeWidth }), size);
    const originX = Math.round(item.centre * unitPx - size / 2);
    const originY = padding + Math.round((rowHeightPx - size) / 2);
    for (let y = 0; y < size; y++) {
      const targetY = originY + y;
      if (targetY < 0 || targetY >= height) continue;
      for (let x = 0; x < size; x++) {
        const targetX = originX + x;
        if (targetX < 0 || targetX >= widthPx) continue;
        const a = alpha[y * size + x];
        if (a <= 0) continue;
        const at = (targetY * widthPx + targetX) * 4;
        for (let channel = 0; channel < 3; channel++) {
          rgba[at + channel] = Math.round(rgba[at + channel] * (1 - a) + 20 * a);
        }
      }
    }
  }
  return { rgba, width: widthPx, height };
}

/** Render a set of icons (each `{ paths: [{ subpaths, fill, strokeWidth }] }`) onto a white sheet. */
export function renderSheet(icons, { size = 96, gap = 12, columns = 4 } = {}) {
  const cell = size + gap;
  const rows = Math.ceil(icons.length / columns);
  const width = columns * cell + gap;
  const height = rows * cell + gap;
  const rgba = Buffer.alloc(width * height * 4, 255);

  icons.forEach((icon, index) => {
    const col = index % columns;
    const row = Math.floor(index / columns);
    const originX = gap + col * cell;
    const originY = gap + row * cell;
    for (const { subpaths, fill = true, strokeWidth = 0 } of icon.paths) {
      const alpha = rasterizeAlpha(styledSubpaths(subpaths, { fill, strokeWidth }), size);
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          const a = alpha[y * size + x];
          if (a <= 0) continue;
          const at = ((originY + y) * width + originX + x) * 4;
          // Ink is deliberately near-black: the card draws these in `currentColor`, and the
          // question being asked is the shape, not the colour.
          for (let channel = 0; channel < 3; channel++) {
            rgba[at + channel] = Math.round(rgba[at + channel] * (1 - a) + 20 * a);
          }
          rgba[at + 3] = 255;
        }
      }
    }
  });
  return { rgba, width, height };
}

/* ------------------------------------------------------------------------ png */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

/** Encode RGBA pixels as a PNG. `zlib` does the only part that would otherwise be fiddly. */
export function encodePng(rgba, width, height) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * How the card paints one path: the fill and stroke the cascade resolves for it.
 *
 * Looked up in cascade order, last declaration winning, exactly as a browser would: the svg's own
 * rule first (`.ctrl svg` is `fill: currentColor`), then the owning button's
 * (`.ctrl--volume svg` is `fill: none; stroke: currentColor`), then the path's own class
 * (`.ctrl--volume .speaker` puts the fill back).
 *
 * Shared by the renderer and the check rather than written twice: two answers to "is this icon
 * filled or stroked" is one answer too many, and the difference is what made the mute cross a
 * hollow outline.
 */
export function iconStyle(css, owner, pathClass) {
  let fill = 'currentColor';
  let stroke = 'none';
  let strokeWidth = 0;

  const apply = (selector) => {
    const f = css.declaration(selector, 'fill');
    const s = css.declaration(selector, 'stroke');
    const w = css.declaration(selector, 'stroke-width');
    if (f !== null) fill = f;
    if (s !== null) stroke = s;
    if (w !== null) strokeWidth = Number.parseFloat(w) || 0;
  };

  apply('.ctrl svg');
  const ownerClass = owner.trim().split(/\s+/).find((name) => name.startsWith('ctrl--'));
  if (ownerClass) apply(`.${ownerClass} svg`);
  for (const token of pathClass.split(/\s+/).filter(Boolean)) {
    if (ownerClass) apply(`.${ownerClass} .${token}`);
    apply(`.${token}`);
  }

  return {
    fill: fill !== 'none' && fill !== 'transparent',
    // A dasharray would need real dash handling; nothing here uses one, and ignoring it would draw
    // a solid line where the card draws a dashed one.
    strokeWidth: stroke !== 'none' && strokeWidth > 0 ? strokeWidth : 0,
  };
}

/**
 * Whether the stylesheet shows this path in a given `data-level` state.
 *
 * Read from the stylesheet rather than restated: a tool that hardcodes what it thinks the sheet
 * says keeps agreeing with itself after the sheet changes, which is the failure this file exists to
 * avoid. Base rules first, then the state-specific ones, because that is the cascade's order.
 */
export function visibleAt(css, pathClass, state) {
  const tokens = pathClass.split(/\s+/).filter(Boolean);
  if (!tokens.length) return true;
  let display = null;
  for (const token of tokens) display = css.declaration(`.ctrl--volume .${token}`, 'display') ?? display;
  for (const token of tokens) {
    display = css.declaration(`.ctrl--volume[data-level='${state}'] .${token}`, 'display') ?? display;
  }
  return display !== 'none';
}

/**
 * Every `<svg>` in a document that carries paths, with the class of the element that owns it.
 *
 * The owner matters: the stylesheet decides fill versus stroke from the *button's* class
 * (`.ctrl--volume svg { fill: none }`) and from each path's own class, so an icon read without its
 * owner cannot be styled the way the card styles it - which is how a hollow cross shipped.
 */
export function extractIcons(html) {
  /*
   * A masked copy of the document, with every `<svg>` blanked out to spaces.
   *
   * The owner has to be the element that *encloses* the svg, and the nearest tag with a class is
   * not it: an icon whose own `<svg>` carries a class (`mode-icon--order`) becomes the "owner" of
   * the icon after it. Blanking the svgs first - same length, so the offsets still line up - leaves
   * only the surrounding markup to search.
   */
  const masked = html.replace(/<svg[\s\S]*?<\/svg>/g, (match) => ' '.repeat(match.length));

  const icons = [];
  const svgRe = /<svg([^>]*)>([\s\S]*?)<\/svg>/g;
  let match;
  while ((match = svgRe.exec(html)) !== null) {
    const attrs = match[1];
    const cls = /class="([^"]+)"/.exec(attrs)?.[1] ?? '';
    const owner =
      [...masked.slice(0, match.index).matchAll(/<(\w+)([^>]*)>/g)]
        .map((m) => /class="([^"]+)"/.exec(m[2])?.[1] ?? '')
        .filter(Boolean)
        .at(-1) ?? '';
    const viewBox = /viewBox="([^"]+)"/.exec(attrs)?.[1] ?? '0 0 24 24';
    const paths = [];
    const pathRe = /<path([^>]*)\/?>/g;
    let pathMatch;
    while ((pathMatch = pathRe.exec(match[2])) !== null) {
      const pathAttrs = pathMatch[1];
      const d = /d="([^"]+)"/.exec(pathAttrs)?.[1];
      if (!d) continue;
      paths.push({
        cls: /class="([^"]+)"/.exec(pathAttrs)?.[1] ?? '',
        d,
      });
    }
    if (paths.length) icons.push({ cls, owner, viewBox, paths, html: match[0] });
  }
  return icons;
}
