// Read a Windows executable's own icon, out of its PE resources.
//
// Why: `electron-builder.yml` says `icon: assets/icon.ico`, and the installer, the desktop shortcut and
// the taskbar all take their icon from the *executable*. Nothing else in this project looks at the
// built exe, so "it shipped with Electron's default icon" would only be noticed by eye, after an
// install. This walks the PE resource directory to the icon group with the lowest id - the one Windows
// uses - and reports the sizes it contains plus the dominant red, which is the colour the icon is
// supposed to have.
//
// References: PE format (DOS header, COFF header, optional header data directories, section table) and
// the icon resource layout (RT_GROUP_ICON 14, RT_ICON 3, a GRPICONDIR of entries pointing at them).

import { decodePng, pixelAt } from './png.mjs';

export function readExeIcon(buffer) {
  const u16 = (at) => buffer.readUInt16LE(at);
  const u32 = (at) => buffer.readUInt32LE(at);

  if (u16(0) !== 0x5a4d) throw new Error('not an MZ executable');
  const peAt = u32(0x3c);
  if (buffer.toString('ascii', peAt, peAt + 4) !== 'PE\0\0') throw new Error('no PE signature');
  const coffAt = peAt + 4;
  const sectionCount = u16(coffAt + 2);
  const optionalSize = u16(coffAt + 16);
  const optionalAt = coffAt + 20;
  const is64 = u16(optionalAt) === 0x20b;
  // Data directories start at offset 96 (PE32) or 112 (PE32+) into the optional header; resources are
  // index 2.
  const resourceRva = u32(optionalAt + (is64 ? 112 : 96) + 16);
  const resourceSize = u32(optionalAt + (is64 ? 112 : 96) + 20);
  if (!resourceRva || !resourceSize) throw new Error('no resource directory');

  const sections = [];
  const sectionAt = optionalAt + optionalSize;
  for (let i = 0; i < sectionCount; i++) {
    const at = sectionAt + i * 40;
    sections.push({
      virtualSize: u32(at + 8),
      virtualAddress: u32(at + 12),
      rawSize: u32(at + 16),
      rawPointer: u32(at + 20),
    });
  }
  const fileOffset = (rva) => {
    for (const section of sections) {
      const span = Math.max(section.virtualSize, section.rawSize);
      if (rva >= section.virtualAddress && rva < section.virtualAddress + span) {
        return section.rawPointer + (rva - section.virtualAddress);
      }
    }
    throw new Error(`RVA ${rva} is in no section`);
  };

  /* ---------------------------------------------------------- resource walk */

  /**
   * One level of the resource tree.
   *
   * **The offsets are relative to the start of the resource directory, not to the parent level.**
   * Nested walking that adds the parent's offset produces a tree that looks almost right - every other
   * entry decodes and the rest are garbage - which is exactly what the first version of this did. So
   * each entry is returned raw and the caller resolves it against the root.
   */
  const directoryEntries = (root, relative) => {
    const base = root + relative;
    const named = u16(base + 12);
    const ids = u16(base + 14);
    const entries = [];
    for (let i = 0; i < named + ids; i++) {
      const at = base + 16 + i * 8;
      const nameOrId = u32(at);
      const offset = u32(at + 4);
      entries.push({
        id: nameOrId & 0x80000000 ? null : nameOrId,
        dir: (offset & 0x80000000) !== 0,
        offset: offset & 0x7fffffff,
      });
    }
    return entries;
  };

  const resourceBase = fileOffset(resourceRva);
  const groups = new Map();
  const images = new Map();
  for (const type of directoryEntries(resourceBase, 0)) {
    if (type.id !== 14 && type.id !== 3) continue;
    if (!type.dir) continue;
    for (const name of directoryEntries(resourceBase, type.offset)) {
      if (!name.dir) continue;
      for (const language of directoryEntries(resourceBase, name.offset)) {
        if (language.dir) continue;
        // IMAGE_RESOURCE_DATA_ENTRY: OffsetToData, Size, CodePage, Reserved.
        const dataEntry = resourceBase + language.offset;
        const dataRva = u32(dataEntry);
        const dataSize = u32(dataEntry + 4);
        if (!dataRva || !dataSize || dataSize > buffer.length) continue;
        const at = fileOffset(dataRva);
        const bytes = buffer.subarray(at, at + dataSize);
        if (type.id === 14) groups.set(name.id, bytes);
        else images.set(name.id, bytes);
      }
    }
  }
  if (groups.size === 0) throw new Error('this executable has no icon resources');

  /* ------------------------------------------------------------- the icon */

  // The group with the lowest id is the one Explorer, the shortcut and the installer use.
  const groupId = Math.min(...groups.keys());
  const group = groups.get(groupId);
  const count = group.readUInt16LE(4);
  const entries = [];
  for (let i = 0; i < count; i++) {
    const at = 6 + i * 14;
    entries.push({
      width: group[at] === 0 ? 256 : group[at],
      height: group[at + 1] === 0 ? 256 : group[at + 1],
      id: group.readUInt16LE(at + 12),
    });
  }

  const largest = entries.reduce((best, entry) => (entry.width > best.width ? entry : best), entries[0]);
  const payload = images.get(largest.id) ?? null;
  const png = payload ? payload.subarray(0, 8).toString('hex') === '89504e470d0a1a0a' : false;

  const dominant = [];
  if (payload && png) {
    const image = decodePng(payload);
    const tally = new Map();
    for (let y = 0; y < image.height; y++) {
      for (let x = 0; x < image.width; x++) {
        const pixel = pixelAt(image, x, y);
        if (pixel[3] < 250) continue;
        const key = `${pixel[0]},${pixel[1]},${pixel[2]}`;
        tally.set(key, (tally.get(key) ?? 0) + 1);
      }
    }
    for (const [key, value] of [...tally.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4)) {
      dominant.push({
        colour: `#${key
          .split(',')
          .map((v) => Number(v).toString(16).padStart(2, '0'))
          .join('')}`,
        count: value,
      });
    }
  }

  return {
    groupId,
    is64,
    sizes: entries.map((entry) => entry.width),
    largest: { width: largest.width, height: largest.height, payload, png },
    dominant,
  };
}