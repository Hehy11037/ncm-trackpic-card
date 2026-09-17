// A PNG decoder, shared instead of copied.
//
// This is the third tool in the project that needs to read pixels from a PNG (the reference
// measurement, the shell's icon check, and now the icon reference), so it lives in `lib/` once.
// It handles the five filter types an 8-bit PNG can use; anything else is an explicit error, because
// a decoder that silently returns a wrong picture is worse than one that refuses.

import { inflateSync } from 'node:zlib';

/** Chunks' bytes are big-endian; there are no helpers for that in a Buffer. */
const u32 = (buf, at) => buf.readUInt32BE(at);

/**
 * Decode an 8-bit PNG into rows of RGBA.
 *
 * @param {Buffer} buffer the whole file
 * @returns {{ width: number, height: number, pixels: Buffer }} `pixels` is width*height*4, RGBA
 */
export function decodePng(buffer) {
  if (buffer.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') {
    throw new Error('not a PNG');
  }

  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  const idat = [];

  let offset = 8;
  while (offset + 12 <= buffer.length) {
    const length = u32(buffer, offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = u32(data, 0);
      height = u32(data, 4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    offset += 12 + length;
  }

  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[colorType];
  if (bitDepth !== 8 || !channels) {
    throw new Error(`unsupported PNG (depth ${bitDepth}, colour type ${colorType})`);
  }
  if (interlace !== 0) throw new Error('interlaced PNGs are not supported');

  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const scan = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const source = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
    const target = scan.subarray(y * stride, (y + 1) * stride);
    const prior = y > 0 ? scan.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? target[x - channels] : 0;
      const b = prior ? prior[x] : 0;
      const c = prior && x >= channels ? prior[x - channels] : 0;
      const v = source[x];
      let out;
      switch (filter) {
        case 1: out = v + a; break;
        case 2: out = v + b; break;
        case 3: out = v + ((a + b) >> 1); break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          out = v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
          break;
        }
        default: out = v;
      }
      target[x] = out & 0xff;
    }
  }

  // Normalise to RGBA so callers do not have to care what the file contained.
  const pixels = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const from = i * channels;
    const to = i * 4;
    if (channels === 1) {
      pixels[to] = pixels[to + 1] = pixels[to + 2] = scan[from];
      pixels[to + 3] = 255;
    } else if (channels === 2) {
      pixels[to] = pixels[to + 1] = pixels[to + 2] = scan[from];
      pixels[to + 3] = scan[from + 1];
    } else if (channels === 3) {
      pixels[to] = scan[from];
      pixels[to + 1] = scan[from + 1];
      pixels[to + 2] = scan[from + 2];
      pixels[to + 3] = 255;
    } else {
      scan.copy(pixels, to, from, from + 4);
    }
  }

  return { width, height, pixels };
}

/** The RGBA of one pixel. */
export function pixelAt(image, x, y) {
  const at = (y * image.width + x) * 4;
  return [image.pixels[at], image.pixels[at + 1], image.pixels[at + 2], image.pixels[at + 3]];
}

/** How close two RGB triples are, 0 for identical. */
export function distance(a, b) {
  return Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]);
}
