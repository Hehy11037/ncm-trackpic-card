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

import type {
  ClientLyricEntry,
  ClientLyricSlice,
  LyricDoc,
  LyricLine,
  LyricSource,
} from '@ncm-trackpic-card/shared';

import { emptyPayload, type RawLyricPayload } from './fetch.ts';
import {
  finalizeLines,
  isCreditLine,
  parseClientLines,
  parseLrc,
  parseYrc,
  type ParsedLine,
} from './parse.ts';

/**
 * True when a line set has content, but that content is nothing but production credits.
 *
 * This matters more than it looks. Measured on a real track change:
 *
 *   t+0s   song id 2650440016   lyricLines = 2, both credits ("作词: FAIZ"), version 1
 *   t+2s   song id 2650440015   lyricLines = 79, first line "作词: KikKuU"
 *
 * The store's song id changes immediately but its *lyric slice* lags behind, so for a few
 * hundred milliseconds the bridge reads the previous track's lines while reporting the new
 * track's id - which put the previous song's lyrics on screen under the new song. A
 * credit-only set is also what the client holds for a track whose lyrics never loaded.
 *
 * An **empty** set is deliberately not credit-only: that is a different state (the fetch
 * completed and there is no lyric content), and the caller reports it as instrumental.
 */
export function hasOnlyCredits(entries: ClientLyricEntry[] | null | undefined): boolean {
  if (!Array.isArray(entries) || entries.length === 0) return false;
  let sawText = false;
  for (const entry of entries) {
    const text = typeof entry?.lyric === 'string' ? entry.lyric.trim() : '';
    if (!text) continue;
    sawText = true;
    const seconds = typeof entry?.time === 'number' ? entry.time : 0;
    if (!isCreditLine(text, seconds * 1000)) return false;
  }
  // Only blanks is not "credits"; it is simply empty, which the caller handles separately.
  return sawText;
}

/** Build a document from the client's own slice (preferred when it is complete). */
export function docFromClientSlice(slice: ClientLyricSlice): LyricDoc | null {
  if (slice.songId == null) return null;

  const main = parseClientLines(slice.lyricLines);
  const trans = parseClientLines(slice.tlyricLines);
  const roma = parseClientLines(slice.romaLyricLines);
  const offsetMs = typeof slice.offset === 'number' ? Math.round(slice.offset * 1000) : 0;

  const usable = main.filter((l) => l.text.trim().length > 0);

  /*
   * Credit-only and empty sets are checked BEFORE anything else.
   *
   * Order matters: a credit-only set produces `usable.length === 0` once credit lines are
   * dropped, so an empty-check placed first would treat the previous track's credit lines as
   * "this track has no lyrics" and return an authoritative empty document - losing the chance
   * to fall back to the public endpoint for a track that does have lyrics. Returning null
   * instead tells the caller "not from me", which keeps the public result.
   */
  if (hasOnlyCredits(slice.lyricLines)) return null;

  if (usable.length === 0) {
    // Genuinely empty: the client is the authority on instrumentals and account-gated tracks
    // we cannot resolve ourselves.
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
