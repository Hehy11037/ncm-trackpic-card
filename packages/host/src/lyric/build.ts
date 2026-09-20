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
} from '../../../shared/src/index.ts';

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
 * Does a lyric set include the credits but no timed lyric lines?
 *
 * Exactly what NetEase shows for a track that has no singable lyrics: it renders
 * "作词: …" / "作曲: …". This is a legitimate state, not an error, and it is what the overlay
 * should display too.
 */
export function isCreditOnlySet(entries: ClientLyricEntry[] | null | undefined): boolean {
  if (!Array.isArray(entries) || entries.length === 0) return false;
  let sawCredit = false;
  for (const entry of entries) {
    const text = typeof entry?.lyric === 'string' ? entry.lyric.trim() : '';
    if (!text) continue;
    // A timed line means there is something to scroll, so this is not credit-only.
    if (typeof entry?.time === 'number' && entry.time > 0.01) return false;
    const seconds = typeof entry?.time === 'number' ? entry.time : 0;
    if (!isCreditLine(text, seconds * 1000)) return false;
    sawCredit = true;
  }
  return sawCredit;
}

/**
 * Does this lyric set plausibly belong to the given track?
 *
 * Needed because the client's store lags a track change: for a few hundred milliseconds it
 * reports the *new* song id with the *previous* track's lines, and stale full lyrics are
 * indistinguishable from real ones by inspection. Measured evidence for the lag:
 *
 *   t+0s   song id 2650440016, slice = 2 credit lines, version 1 (previous track's lyrics)
 *   t+2s   song id 2650440015, slice = 79 lines starting "作词: KikKuU"
 *
 * The track's own name or artist appearing in the set is direct evidence the set describes this
 * track. "芥" by FAIZ, for example, matches on "FAIZ" in its credit lines.
 */
export function lyricsMentionTrack(
  entries: ClientLyricEntry[] | null | undefined,
  trackName: string | null | undefined,
  artistName: string | null | undefined,
): boolean {
  if (!Array.isArray(entries) || !entries.length) return false;

  const needles: string[] = [];
  if (trackName?.trim()) needles.push(trackName.trim().toLowerCase());
  // Split a multi-artist string so "A / B" matches either name.
  for (const part of (artistName ?? '').split(/[/、,]/)) {
    const trimmed = part.trim().toLowerCase();
    if (trimmed.length >= 2) needles.push(trimmed);
  }
  if (!needles.length) return false;

  for (const entry of entries) {
    const text = typeof entry?.lyric === 'string' ? entry.lyric.toLowerCase() : '';
    if (!text) continue;
    for (const needle of needles) {
      if (text.includes(needle)) return true;
    }
  }
  return false;
}

/** Build a document from the client's own slice (preferred when it is complete). */
export function docFromClientSlice(slice: ClientLyricSlice): LyricDoc | null {
  if (slice.songId == null) return null;

  const main = parseClientLines(slice.lyricLines);
  const trans = parseClientLines(slice.tlyricLines);
  const roma = parseClientLines(slice.romaLyricLines);
  const offsetMs = typeof slice.offset === 'number' ? Math.round(slice.offset * 1000) : 0;

  const usable = main.filter((l) => l.text.trim().length > 0);

  if (usable.length === 0) {
    // Nothing to show yet; the caller keeps waiting or reports plain "no lyrics".
    if (slice.isLyricFetchFailed || slice.isLoading) return null;
    return buildDoc(slice.songId, [], offsetMs, true, false, 'none');
  }

  /*
   * Credit lines are kept, not filtered.
   *
   * NetEase's own lyrics view displays "作词: …" / "作曲: …" for a track that has no singable
   * lyrics, and the brief is to mirror what the client shows. They carry no timings, so the
   * overlay renders them as static text rather than a scroll.
   */
  const lines = finalizeLines(usable, trans, roma, offsetMs, true);
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
