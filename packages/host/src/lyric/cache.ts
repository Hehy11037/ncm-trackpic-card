/**
 * Lyrics, part 3: on-disk cache.
 *
 * Lyrics are immutable per song for practical purposes but change rarely, so a
 * long TTL with no revalidation is fine. Instrumental / no-lyric results get a
 * much shorter TTL, because a track can gain lyrics later (or the client may not
 * have been able to fetch them while offline).
 *
 * The public-API fallback is cached too, so a track played twice while the client
 * has no lyrics does not hit the network twice.
 */

import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { LyricDoc } from '@ncm-trackpic-card/shared';

const NORMAL_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const NO_LYRIC_TTL_MS = 24 * 60 * 60 * 1000;

export function cacheDir(): string {
  const base = process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local');
  return join(base, 'ncm-trackpic-card', 'lyrics');
}

function fileFor(songId: number): string {
  return join(cacheDir(), `${songId}.json`);
}

function ttlFor(doc: LyricDoc): number {
  return doc.lines.length === 0 ? NO_LYRIC_TTL_MS : NORMAL_TTL_MS;
}

export function readCachedLyrics(songId: number, now = Date.now()): LyricDoc | null {
  const file = fileFor(songId);
  try {
    const stat = statSync(file);
    const doc = JSON.parse(readFileSync(file, 'utf8')) as LyricDoc;
    if (now - stat.mtimeMs > ttlFor(doc)) return null;
    return doc;
  } catch {
    return null;
  }
}

export function writeCachedLyrics(doc: LyricDoc): void {
  try {
    mkdirSync(cacheDir(), { recursive: true });
    writeFileSync(fileFor(doc.songId), JSON.stringify(doc), 'utf8');
  } catch {
    // A cache write failure only costs a re-fetch later.
  }
}

/**
 * Drop cache entries older than the TTL. Called opportunistically on start so the
 * directory cannot grow without bound.
 */
export function pruneLyricCache(now = Date.now()): { removed: number; kept: number } {
  const dir = cacheDir();
  let removed = 0;
  let kept = 0;
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return { removed: 0, kept: 0 };
  }

  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const file = join(dir, name);
    try {
      const stat = statSync(file);
      const doc = JSON.parse(readFileSync(file, 'utf8')) as LyricDoc;
      if (now - stat.mtimeMs > ttlFor(doc)) {
        rmSync(file, { force: true });
        removed++;
      } else {
        kept++;
      }
    } catch {
      try {
        rmSync(file, { force: true });
        removed++;
      } catch {
        /* ignore */
      }
    }
  }
  return { removed, kept };
}
