/**
 * Lyrics, part 2: turning raw payloads into a normalized `LyricDoc`.
 *
 * The preference order is deliberate:
 *
 *  - If the source has word timings (`yrc`), use them: they drive the karaoke
 *    sweep and are strictly more informative than line times.
 *  - Otherwise fall back to line-level `lrc`.
 *  - Apply the client's lyric offset (the client stores it in SECONDS).
 *  - Drop credit lines, which the client mixes into the raw lyric.
 */

import type { ClientLyricSlice, LyricDoc, LyricLine, LyricSource } from '@ncm-trackpic-card/shared';

import { emptyPayload, type RawLyricPayload } from './fetch.ts';
import {
  finalizeLines,
  parseClientLines,
  parseLrc,
  parseYrc,
  type ParsedLine,
} from './parse.ts';

/** Build a document from the client's own slice (preferred source). */
export function docFromClientSlice(slice: ClientLyricSlice): LyricDoc | null {
  if (slice.songId == null) return null;

  const main = parseClientLines(slice.lyricLines);
  const trans = parseClientLines(slice.tlyricLines);
  const roma = parseClientLines(slice.romaLyricLines);
  const offsetMs = typeof slice.offset === 'number' ? Math.round(slice.offset * 1000) : 0;

  const usable = main.filter((l) => l.text.trim().length > 0);
  if (usable.length === 0) {
    // The client is the authority on "this track has no lyrics": it knows about
    // instrumental flags and account-gated tracks we cannot resolve ourselves.
    if (slice.isLyricFetchFailed || slice.isLoading) return null;
    return buildDoc(slice.songId, [], offsetMs, true, false, 'none');
  }

  const lines = finalizeLines(usable, trans, roma, offsetMs);
  return buildDoc(slice.songId, lines, offsetMs, false, false, 'client');
}

/** Build a document from a public-API payload (fallback source). */
export function docFromRawPayload(songId: number, raw: RawLyricPayload, offsetMs = 0): LyricDoc {
  const worded = parseYrc(raw.yrc);
  const hasWordTiming = worded.some((l) => l.words.length > 0);
  const main: ParsedLine[] = hasWordTiming ? worded : parseLrc(raw.lrc);
  const trans = raw.ytlrc ? parseYrc(raw.ytlrc) : parseLrc(raw.tlyric);
  const roma = raw.yromalrc ? parseYrc(raw.yromalrc) : parseLrc(raw.romalrc);

  const usable = main.filter((l) => l.text.trim().length > 0);
  if (usable.length === 0) {
    const source: LyricSource = raw.noLyric ? 'none' : 'none';
    return buildDoc(songId, [], offsetMs, true, false, source);
  }

  const lines = finalizeLines(
    usable,
    trans.length ? trans : parseLrc(raw.tlyric),
    roma.length ? roma : parseLrc(raw.romalrc),
    offsetMs,
  );
  return buildDoc(songId, lines, offsetMs, false, hasWordTiming, raw.source);
}

/** Merge the two sources, preferring whichever actually has lines. */
export function buildDoc(
  songId: number,
  lines: LyricLine[],
  offsetMs: number,
  instrumental: boolean,
  hasWordTiming: boolean,
  source: LyricSource,
): LyricDoc {
  return {
    songId,
    source,
    instrumental,
    offsetMs,
    hasWordTiming,
    lines,
    fetchedAt: Date.now(),
  };
}

export function emptyDoc(songId: number, source: LyricSource = 'none'): LyricDoc {
  return buildDoc(songId, [], 0, false, false, source);
}

export { emptyPayload };
export type { RawLyricPayload };
