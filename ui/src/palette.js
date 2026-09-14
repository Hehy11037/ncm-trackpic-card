/**
 * Cover-art palette extraction.
 *
 * Approach mirrors the reference design: median-cut quantisation (MMCQ) over a
 * downsampled copy of the cover, then a dominant-hue filter to reject near-black,
 * near-white and washed-out buckets, ending with five colours.
 *
 * The image CDN sends `access-control-allow-origin: *` (verified), so the cover can
 * be drawn into a canvas and read back. Extraction is done once per cover URL and
 * memoised, because it costs a decode plus a few thousand pixel reads.
 *
 * The palette drives: the gradient glow, the progress bar, the five-swatch strip,
 * and the light/dark decision for text.
 */

const SAMPLE_SIZE = 64;
const PALETTE_SIZE = 5;
const CACHE_LIMIT = 24;

/** @type {Map<string, Promise<Palette>>} */
const cache = new Map();

/** @typedef {{ r: number, g: number, b: number }} Rgb */
/** @typedef {{ colors: Rgb[], dominant: Rgb, scheme: 'light'|'dark', glowTop: Rgb, glowBottom: Rgb }} Palette */

/**
 * Extract (or reuse) the palette for a cover URL.
 * @param {string | null | undefined} url
 * @returns {Promise<Palette | null>}
 */
export function paletteFor(url) {
  if (!url) return Promise.resolve(null);
  const existing = cache.get(url);
  if (existing) return existing;

  const task = extract(url).catch(() => null);
  cache.set(url, task);
  if (cache.size > CACHE_LIMIT) {
    // Drop the oldest entry; Map preserves insertion order.
    const oldest = cache.keys().next();
    if (!oldest.done) cache.delete(oldest.value);
  }
  return task;
}

/** @returns {Promise<Palette>} */
async function extract(url) {
  const image = await loadImage(url);
  const canvas = document.createElement('canvas');
  canvas.width = SAMPLE_SIZE;
  canvas.height = SAMPLE_SIZE;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('no 2d context');
  ctx.drawImage(image, 0, 0, SAMPLE_SIZE, SAMPLE_SIZE);
  const { data } = ctx.getImageData(0, 0, SAMPLE_SIZE, SAMPLE_SIZE);

  const pixels = [];
  for (let i = 0; i < data.length; i += 4) {
    const alpha = data[i + 3];
    if (alpha < 125) continue;
    pixels.push([data[i], data[i + 1], data[i + 2]]);
  }
  if (!pixels.length) throw new Error('empty cover');

  const buckets = medianCut(pixels, PALETTE_SIZE * 3);
  const filtered = buckets
    .map((bucket) => ({ color: bucket.mean, population: bucket.pixels.length }))
    .filter((entry) => isUsable(entry.color));

  const usable = filtered.length ? filtered : buckets.map((b) => ({ color: b.mean, population: b.pixels.length }));
  usable.sort((a, b) => b.population - a.population);

  /*
   * Pick the swatches by luminance band rather than by hue order.
   *
   * Five equal bands from dark to light, each contributing its most saturated candidate,
   * plus a saturation nudge. That guarantees an even light-to-dark ramp with visible
   * contrast between neighbours - which is what a palette strip is read as. Sorting by hue
   * (the earlier approach) produced adjacent swatches of similar depth and low contrast.
   */
  const colors = selectByLuminance(usable.map((entry) => entry.color), PALETTE_SIZE);
  const dominant = usable[0]?.color ?? { r: 128, g: 128, b: 128 };

  // Two anchor colours for the background wash: the most and least luminous of the
  // palette, which gives the glow depth instead of a flat tint.
  const sortedByLuma = [...colors].sort((a, b) => luminance(a) - luminance(b));
  const glowTop = sortedByLuma[sortedByLuma.length - 1] ?? dominant;
  const glowBottom = sortedByLuma[0] ?? dominant;

  // Decide text polarity from the *average* cover brightness: a bright cover behind
  // a translucent white panel needs dark text, a dark cover needs light text.
  const average = averageColor(pixels);
  const scheme = luminance(average) < 0.42 ? 'dark' : 'light';

  return { colors, dominant, scheme, glowTop, glowBottom };
}

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.crossOrigin = 'anonymous';
    image.decoding = 'async';
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(`cover load failed: ${url}`));
    image.src = url;
  });
}

/**
 * Median-cut quantisation.
 * Splits the colour box with the largest channel range until we have `target`
 * buckets, then averages each bucket.
 * @param {number[][]} pixels
 * @param {number} target
 */
function medianCut(pixels, target) {
  /** @type {{pixels: number[][]}[]} */
  let boxes = [{ pixels }];

  while (boxes.length < target) {
    let bestIndex = -1;
    let bestRange = -1;
    let bestChannel = 0;

    boxes.forEach((box, index) => {
      if (box.pixels.length < 2) return;
      const { channel, range } = widestChannel(box.pixels);
      if (range > bestRange) {
        bestRange = range;
        bestIndex = index;
        bestChannel = channel;
      }
    });

    if (bestIndex < 0 || bestRange <= 0) break;

    const box = boxes[bestIndex];
    const sorted = [...box.pixels].sort((a, b) => a[bestChannel] - b[bestChannel]);
    const middle = Math.floor(sorted.length / 2);
    const left = sorted.slice(0, middle);
    const right = sorted.slice(middle);
    if (!left.length || !right.length) break;

    boxes.splice(bestIndex, 1, { pixels: left }, { pixels: right });
  }

  return boxes
    .filter((box) => box.pixels.length)
    .map((box) => ({ pixels: box.pixels, mean: averageColor(box.pixels) }));
}

function widestChannel(pixels) {
  let bestChannel = 0;
  let bestRange = -1;
  for (let channel = 0; channel < 3; channel++) {
    let min = 255;
    let max = 0;
    for (const pixel of pixels) {
      const value = pixel[channel];
      if (value < min) min = value;
      if (value > max) max = value;
    }
    const range = max - min;
    if (range > bestRange) {
      bestRange = range;
      bestChannel = channel;
    }
  }
  return { channel: bestChannel, range: bestRange };
}

function averageColor(pixels) {
  let r = 0;
  let g = 0;
  let b = 0;
  for (const pixel of pixels) {
    r += pixel[0];
    g += pixel[1];
    b += pixel[2];
  }
  const n = pixels.length || 1;
  return { r: Math.round(r / n), g: Math.round(g / n), b: Math.round(b / n) };
}

/** Reject extremes and greys; they make a palette look muddy. */
function isUsable({ r, g, b }) {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const luma = luminance({ r, g, b });
  if (luma < 0.06 || luma > 0.95) return false;
  const saturation = max === 0 ? 0 : (max - min) / max;
  // Keep strongly coloured swatches, plus mid greys (they read as neutral accents).
  return saturation > 0.12 || (luma > 0.2 && luma < 0.8);
}

/**
 * Choose `count` colours spread across the luminance range, darkest first.
 *
 * Each of `count` equal luminance bands contributes its most saturated candidate. When a
 * band is empty the nearest candidate is reused, so the result always has `count` entries.
 * Saturation is nudged up slightly so the swatches carry some colour on muted covers.
 */
function selectByLuminance(candidates, count = 5) {
  if (!candidates.length) return [];
  if (candidates.length <= count) {
    return [...candidates].sort((a, b) => luminance(a) - luminance(b));
  }

  const withLuma = candidates.map((color) => ({ color, luma: luminance(color) }));
  const min = Math.min(...withLuma.map((c) => c.luma));
  const max = Math.max(...withLuma.map((c) => c.luma));
  const span = Math.max(max - min, 0.0001);

  const bins = Array.from({ length: count }, () => []);
  for (const entry of withLuma) {
    const index = Math.min(count - 1, Math.floor(((entry.luma - min) / span) * count));
    bins[index].push(entry);
  }

  const chosen = [];
  for (let i = 0; i < count; i++) {
    const bin = bins[i];
    if (bin.length) {
      // Most saturated wins, with population as the tie-breaker.
      bin.sort((a, b) => saturation(b.color) - saturation(a.color));
      chosen.push(bin[0].color);
    } else {
      // Empty band: borrow the candidate nearest this band's midpoint.
      const midpoint = min + ((i + 0.5) / count) * span;
      const nearest = [...withLuma].sort(
        (a, b) => Math.abs(a.luma - midpoint) - Math.abs(b.luma - midpoint),
      )[0];
      chosen.push(nearest.color);
    }
  }

  return chosen.map(boostSaturation);
}

/** HSL saturation of a colour, 0..1. */
function saturation({ r, g, b }) {
  const max = Math.max(r, g, b) / 255;
  const min = Math.min(r, g, b) / 255;
  const lightness = (max + min) / 2;
  if (max === min) return 0;
  return lightness > 0.5 ? (max - min) / (2 - max - min) : (max - min) / (max + min);
}

/** Push saturation up a little so muted covers still yield readable swatches. */
function boostSaturation(color, factor = 1.22) {
  const max = Math.max(color.r, color.g, color.b);
  const min = Math.min(color.r, color.g, color.b);
  const mid = (max + min) / 2;
  const boost = (value) => {
    const next = mid + (value - mid) * factor;
    return Math.max(0, Math.min(255, Math.round(next)));
  };
  return { r: boost(color.r), g: boost(color.g), b: boost(color.b) };
}

/** Relative luminance (WCAG), 0..1. */
export function luminance({ r, g, b }) {
  const channel = (value) => {
    const v = value / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

export function hue({ r, g, b }) {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max === min) return 0;
  const d = max - min;
  let h;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  h *= 60;
  return h < 0 ? h + 360 : h;
}

export function css({ r, g, b }, alpha = 1) {
  if (alpha >= 1) return `rgb(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)})`;
  return `rgba(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)}, ${alpha})`;
}

/** Contrast ratio between two luminances (WCAG), 1..21. */
export function contrastRatio(a, b) {
  const high = Math.max(a, b);
  const low = Math.min(a, b);
  return (high + 0.05) / (low + 0.05);
}
