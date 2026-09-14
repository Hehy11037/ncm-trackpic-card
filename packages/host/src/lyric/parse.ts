/**
 * Lyric parsing and normalization.
 *
 * Three input dialects are supported, all of them observed on real data:
 *
 *  1. The client's own parsed lines: `{ time: 12.788, lyric: "..." }`.
 *     **`time` is in SECONDS here** — the same trap as `resourceDuration`.
 *  2. Standard LRC: `[02:12.79]text`. Times are `mm:ss.xx`.
 *  3. NetEase word-by-word `yrc`, in two syntaxes:
 *       - compact:  `[16960,3560](16960,240,0)一(17200,350,0)双`
 *       - JSON per line: `{"t":0,"c":[{"tx":"编曲: "},{"tx":"钱雷",...}]}`
 *     Times are milliseconds.
 *
 * Everything leaving this module is in milliseconds, with credit lines removed.
 */

import type { LyricLine, LyricWord } from '@ncm-trackpic-card/shared';

/** One entry as the client stores it: `{ time: seconds, lyric: text }`. */
export interface ClientLyricEntry {
  time?: number | null;
  lyric?: string | null;
  /** Some entries carry an extra translation field instead of a parallel array. */
  tlyric?: string | null;
  romalrc?: string | null;
}

/** A parsed line before merging with its translation. */
export interface ParsedLine {
  startMs: number;
  text: string;
  words: LyricWord[];
}

const CREDIT_KEYS =
  /^(作词|作曲|编曲|制作人|和声|混音|母带|录音|出品|监制|统筹|企划|封面|发行|词|曲|OP|SP|吉他|贝斯|鼓|钢琴|弦乐|合声|配唱|人声|器乐|录音室|录音师|母带工程师|混音师|制作|策划|视觉|设计|翻译|上传|校对)\s*[:：]/i;

const CREDIT_WINDOW_MS = 15000;

/**
 * Detect credit lines ("作词: …", "编曲: …") that the client mixes into the raw
 * lyric. Only lines near the very start are considered, so a real lyric that
 * happens to contain a colon later on is never dropped.
 */
export function isCreditLine(text: string, startMs: number): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (startMs > CREDIT_WINDOW_MS) return false;
  if (CREDIT_KEYS.test(trimmed)) return true;
  // Bare "词：xxx / 曲：xxx" style, and lines that are only a credit label.
  if (/^(词|曲)\s*[:：]/.test(trimmed)) return true;
  return false;
}

/** Client entries -> parsed lines (seconds -> milliseconds). */
export function parseClientLines(entries: ClientLyricEntry[] | null | undefined): ParsedLine[] {
  if (!Array.isArray(entries)) return [];
  const out: ParsedLine[] = [];
  for (const entry of entries) {
    if (!entry) continue;
    const seconds = typeof entry.time === 'number' ? entry.time : null;
    const text = typeof entry.lyric === 'string' ? entry.lyric : '';
    if (seconds === null) continue;
    out.push({ startMs: Math.round(seconds * 1000), text, words: [] });
  }
  return sortAndDedupe(out);
}

/** `[mm:ss.xx]` or `[mm:ss.xxx]` timestamps, possibly several per line. */
const LRC_TIME = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;

/** Parse standard LRC text into lines (milliseconds). */
export function parseLrc(text: string | null | undefined): ParsedLine[] {
  if (!text) return [];
  const out: ParsedLine[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const times: number[] = [];
    LRC_TIME.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = LRC_TIME.exec(rawLine)) !== null) {
      const minutes = Number(match[1] ?? 0);
      const seconds = Number(match[2] ?? 0);
      const fractionRaw = match[3] ?? '0';
      // Two digits = centiseconds, three = milliseconds.
      const fraction = fractionRaw.length === 3 ? Number(fractionRaw) : Number(fractionRaw) * 10;
      times.push(minutes * 60000 + seconds * 1000 + fraction);
    }
    if (!times.length) continue;
    const content = rawLine.replace(LRC_TIME, '').replace(/\s+$/, '');
    for (const startMs of times) out.push({ startMs, text: content, words: [] });
  }
  return sortAndDedupe(out);
}

/** `[16960,3560](16960,240,0)一(17200,350,0)双…` */
const COMPACT_YRC_HEAD = /^\[(\d+),(\d+)\]/;

/** Parse the compact yrc syntax into word-timed lines (milliseconds). */
export function parseCompactYrc(text: string | null | undefined): ParsedLine[] {
  if (!text) return [];
  const out: ParsedLine[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const head = COMPACT_YRC_HEAD.exec(line);
    if (!head) continue;
    const lineStart = Number(head[1]);
    const body = line.slice(head[0].length);

    const words: LyricWord[] = [];
    const token = /\((\d+),(\d+)(?:,\d+)?\)([^()]*)/g;
    let match: RegExpExecArray | null;
    let plain = '';
    while ((match = token.exec(body)) !== null) {
      const startMs = Number(match[1]);
      const durationMs = Number(match[2]);
      const chunk = match[3] ?? '';
      plain += chunk;
      if (chunk) words.push({ startMs, durationMs, text: chunk });
    }
    if (!plain) continue;
    out.push({ startMs: Number.isFinite(lineStart) ? lineStart : words[0]?.startMs ?? 0, text: plain, words });
  }
  return sortAndDedupe(out);
}

/** `{"t":0,"c":[{"tx":"编曲: "},{"tx":"钱雷",...}]}` */
export function parseJsonYrc(text: string | null | undefined): ParsedLine[] {
  if (!text) return [];
  const out: ParsedLine[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.startsWith('{')) continue;
    let parsed: { t?: number; c?: { tx?: string; li?: string; or?: string }[] };
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const chunks = Array.isArray(parsed.c) ? parsed.c : [];
    const text2 = chunks.map((c) => c?.tx ?? '').join('');
    if (!text2) continue;
    // This dialect carries no per-character durations; keep it line-level but
    // preserve any character offsets we can infer (none here), so `words` stays
    // empty and the UI falls back to a line sweep.
    out.push({ startMs: Number(parsed.t ?? 0), text: text2, words: [] });
  }
  return sortAndDedupe(out);
}

/**
 * Pick the best line set from a yrc payload: prefer the syntax that actually
 * produced word timings.
 */
export function parseYrc(text: string | null | undefined): ParsedLine[] {
  const json = parseJsonYrc(text);
  const compact = parseCompactYrc(text);
  const wordy = compact.some((l) => l.words.length > 0);
  if (wordy) return compact;
  if (json.length) return json;
  return compact;
}

/**
 * Sort by start time and drop *duplicates*.
 *
 * A duplicate means the same text at the same timestamp, which happens when an LRC line carries
 * several timestamps. Two different lines may legitimately share a timestamp - the client emits
 * "作词: …" and "作曲: …" both at time -0.001 - and an earlier version dropped one of them by
 * de-duplicating on the timestamp alone.
 *
 * Lines with no timing at all (a negative time, which is how the client marks credits) keep their
 * original order rather than being sorted, since their order is meaningful and their timestamps
 * are not.
 */
function sortAndDedupe(lines: ParsedLine[]): ParsedLine[] {
  const timed = lines.filter((line) => line.startMs >= 0);
  const untimed = lines.filter((line) => line.startMs < 0);
  const sorted = [...timed].sort((a, b) => a.startMs - b.startMs);

  const out: ParsedLine[] = [];
  for (const line of sorted) {
    const previous = out[out.length - 1];
    if (previous && previous.startMs === line.startMs && previous.text === line.text) {
      // Same text at the same time: the richer entry wins.
      if (line.words.length > previous.words.length) out[out.length - 1] = line;
      continue;
    }
    out.push(line);
  }
  return [...untimed, ...out];
}

/**
 * Fill in end times, attach translations, and optionally drop credit lines.
 *
 * `keepCredits` exists because NetEase's own lyric view shows "作词: …" / "作曲: …" for a track
 * with no singable lyrics, and the overlay mirrors the client. Those lines carry no timing, so
 * the caller renders them as static text instead of a scroll.
 */
export function finalizeLines(
  lines: ParsedLine[],
  translations?: ParsedLine[],
  romas?: ParsedLine[],
  offsetMs = 0,
  keepCredits = false,
): LyricLine[] {
  const kept = lines.filter(
    (l) => (keepCredits || !isCreditLine(l.text, l.startMs)) && l.text.trim().length > 0,
  );
  const byTime = new Map<number, string>();
  for (const t of translations ?? []) {
    if (t.text.trim()) byTime.set(t.startMs, t.text);
  }
  const romaByTime = new Map<number, string>();
  for (const r of romas ?? []) {
    if (r.text.trim()) romaByTime.set(r.startMs, r.text);
  }

  return kept.map((line, index) => {
    const next = kept[index + 1];
    const startMs = line.startMs + offsetMs;
    const endMs = next ? next.startMs + offsetMs : startMs + 8000;
    return {
      startMs,
      endMs,
      text: line.text,
      words: line.words.map((w) => ({ ...w, startMs: w.startMs + offsetMs })),
      translation: byTime.get(line.startMs) ?? null,
      roma: romaByTime.get(line.startMs) ?? null,
    };
  });
}
