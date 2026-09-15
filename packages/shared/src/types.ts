/**
 * Shared contracts between the host (which talks to NetEase Cloud Music over the
 * client's local CDP channel) and the overlay UI.
 *
 * Every field name here was measured against the real client (3.1.39.205426).
 * See docs/contracts.md for the evidence behind each one. Two traps are encoded
 * deliberately:
 *
 *   - The client reports duration in SECONDS in `resourceDuration`, but in
 *     MILLISECONDS in `curTrack.duration` and in the chorus map. All wire-format
 *     durations here are milliseconds; convert at the boundary (see
 *     `secondsToMs`).
 *   - The client's song id is a STRING in `resourceTrackId` but a NUMBER in queue
 *     entries. Normalize to number on the wire.
 */

/** Milliseconds since epoch. */
export type EpochMs = number;

/** `playing.playingState` — measured: 1 = paused/stopped, 2 = playing. */
export const PLAYING_STATE = {
  PAUSED: 1,
  PLAYING: 2,
} as const;

export type PlayingStateValue = (typeof PLAYING_STATE)[keyof typeof PLAYING_STATE];

/** Normalized transport state used by the UI. */
export type PlaybackStatus = 'playing' | 'paused' | 'stopped' | 'unknown';

/** `playing.playingMode` values seen so far; the union is open on purpose. */
export type PlayMode =
  | 'playOrder'
  | 'playCycle'
  | 'playOneCycle'
  | 'playRandom'
  | 'playOneRandom'
  | (string & {});

export interface Artist {
  id: number | null;
  name: string;
}

export interface Song {
  /** Client `resourceTrackId`, normalized from string to number. */
  id: number | null;
  name: string;
  artists: Artist[];
  albumName: string | null;
  coverUrl: string | null;
  /** Track length in milliseconds, normalized. Null when unknown. */
  durationMs: number | null;
  resourceType: string | null;
}

export interface Playback {
  status: PlaybackStatus;
  /** Raw client value, kept for diagnostics. */
  rawPlayingState: number | null;
  mode: PlayMode | null;
  /** 0..1 float, as the client stores it. */
  volume: number | null;
  muted: boolean | null;
  /** Playback rate; 1 is normal. */
  speed: number | null;
}

export interface Playhead {
  /** Position in milliseconds. */
  positionMs: number;
  /**
   * Client-provided opaque playback id from the progress tuple, e.g.
   * "2102424489_1COWG4" (songId_randomSuffix). Changes when the song changes and
   * sometimes when a fresh playback session starts.
   */
  playId: string | null;
  /** When the host received this sample (its own clock, not the client's). */
  at: EpochMs;
  /**
   * Number of progress events seen since the last track change; lets the UI tell
   * a live stream from a single late snapshot.
   */
  sampleCount: number;
}

export interface ChorusRange {
  startMs: number;
  endMs: number;
}

/** An sRGB colour with 0-255 channels. */
export interface Rgb {
  r: number;
  g: number;
  b: number;
}

/**
 * Colour palette for the current track.
 *
 * The client already extracts this from the cover art
 * (`page:vinylPage/setColor`), so the overlay can usually skip decoding the image
 * entirely. `source` says where it came from, so the UI can decide whether to
 * compute its own palette instead.
 */
export interface CoverPalette {
  dominant: Rgb | null;
  top: Rgb | null;
  bottom: Rgb | null;
  source: 'client' | 'computed';
}

export interface QueueInfo {
  length: number;
  /** Ids of the upcoming/known entries, in client order (capped). */
  ids: number[];
  index: number | null;
}

/**
 * A full, self-consistent picture of what the client is doing. The host emits one
 * of these on every meaningful change (track, status, mode, volume) and the UI
 * renders straight from it.
 */
export interface PlaybackSnapshot {
  song: Song | null;
  playback: Playback;
  /** Latest known position; may be missing before the first progress event. */
  playhead: Playhead | null;
  queue: QueueInfo;
  /** Chorus range for the current track, when the client knows it. */
  chorus: ChorusRange | null;
  /** Cover-derived colours, when known. */
  palette: CoverPalette | null;
  lyricLine: number | null;
}

/** Connection lifecycle as surfaced to the UI. */
export type ConnectionState =
  | 'connecting'
  | 'ready'
  | 'client-not-running'
  | 'needs-relaunch'
  | 'no-target'
  | 'disconnected';

export interface ConnectionInfo {
  state: ConnectionState;
  port: number;
  clientProcessCount: number;
  /** Human-readable, already localized detail for the status pill. */
  detail: string;
  lastError: string | null;
  since: EpochMs;
}

/* ------------------------------------------------------------------ lyrics */

export interface LyricWord {
  /** Offset from the start of the line, in milliseconds. */
  startMs: number;
  durationMs: number;
  text: string;
}

export interface LyricLine {
  startMs: number;
  /** End of the line; for line-level lyrics this is the next line's start. */
  endMs: number;
  text: string;
  /** Per-character/word timings for karaoke highlighting. Empty for plain LRC. */
  words: LyricWord[];
  /** Translation line, when available and enabled. */
  translation: string | null;
  /** Romanization line, when available and enabled. */
  roma: string | null;
}

export type LyricSource = 'client' | 'public-api' | 'none';

/** One line exactly as the client stores it (`time` is in SECONDS there). */
export interface ClientLyricEntry {
  time?: number | null;
  lyric?: string | null;
}

/** The client's parsed lyric slice, forwarded verbatim by the bridge. */
export interface ClientLyricSlice {
  /** Song these lines belong to, so the host can discard stale payloads. */
  songId: number | null;
  /** `lrc`, `yrc`, `none`, ... as reported by the client. */
  currentUsedLyric: string | null;
  currentUsedLyricVersion: number | null;
  isLoading: boolean;
  isLyricFetchFailed: boolean;
  /** User-configured offset. The client stores it in SECONDS. */
  offset: number | null;
  lyricLines: ClientLyricEntry[];
  tlyricLines: ClientLyricEntry[];
  romaLyricLines: ClientLyricEntry[];
  at: EpochMs;
}

export interface LyricDoc {
  songId: number;
  /** 'none' means the track is instrumental or has no lyrics. */
  source: LyricSource;
  /** True when the client says the track has no lyrics at all. */
  instrumental: boolean;
  /** Lyric offset the user configured in the client, in milliseconds. */
  offsetMs: number;
  hasWordTiming: boolean;
  lines: LyricLine[];
  fetchedAt: EpochMs;
}

/* --------------------------------------------------------------- transport */

/**
 * The four play modes the card offers, in the order the client's own button cycles
 * them (measured by clicking it four times and reading `playing.playingMode`).
 *
 * `playAi` and `playFm` exist in the client's enum but are not user-selectable modes
 * in the same sense - the client treats switching into them as a different kind of
 * change (it rewrites the play queue) - so the card does not offer them.
 */
export const PLAY_MODES = ['playOrder', 'playCycle', 'playOneCycle', 'playRandom'] as const;

export type PlayModeValue = (typeof PLAY_MODES)[number];

/**
 * Commands the overlay may send.
 *
 * `seek` carries MILLISECONDS, like every other duration on this wire, and is
 * converted to the client's unit at the boundary (`msToSeekSeconds`) rather than at
 * the call site - the client's `audioplayer.seek` takes whole seconds, and getting
 * that wrong seeks a track to the wrong place rather than failing.
 */
export type ControlCommand =
  | { type: 'playPause' }
  | { type: 'play' }
  | { type: 'pause' }
  | { type: 'next' }
  | { type: 'previous' }
  | { type: 'seek'; positionMs: number }
  | { type: 'setVolume'; volume: number }
  | { type: 'toggleMute' }
  | { type: 'setMode'; mode: PlayMode }
  /**
   * Diagnostics only: report what the client's transport surfaces look like, so a control that
   * runs without effect can be explained instead of guessed at. Sent by the host itself, never by
   * the overlay.
   */
  | { type: 'diagnoseTransport' };

export interface ControlResult {
  ok: boolean;
  command: ControlCommand;
  /** How the command was applied, for diagnostics. */
  via: 'dispatch' | 'pipeline' | 'media-key' | 'none';
  message?: string;
  /**
   * Whether the *client* was then observed in the state the command asked for.
   *
   * `ok` only means the command reached the page and ran without throwing - which is not the same
   * as the client reacting. The two are worth distinguishing, because "the button did nothing" and
   * "the button worked" are otherwise indistinguishable from the outside. `undefined` when it
   * cannot be judged: no track loaded, or no snapshot to compare against.
   */
  confirmed?: boolean;
  /** The client's `playingState` before and after, when it was readable. */
  playingState?: { before: number | null; after: number | null };
  /** Where the client says it actually is after a seek, in milliseconds. */
  positionMs?: number | null;
}

/** Messages the host pushes to overlay clients. */
export type HostMessage =
  | { kind: 'hello'; protocol: 1; hostVersion: string; at: EpochMs }
  | { kind: 'snapshot'; snapshot: PlaybackSnapshot }
  | { kind: 'playhead'; playhead: Playhead; songId: number | null }
  | { kind: 'lyrics'; doc: LyricDoc }
  | { kind: 'connection'; connection: ConnectionInfo }
  | { kind: 'controlResult'; result: ControlResult }
  | { kind: 'error'; message: string; at: EpochMs };

/** Messages an overlay client may send to the host. */
export type ClientMessage =
  | { kind: 'control'; command: ControlCommand; requestId?: string }
  | { kind: 'requestSnapshot' }
  | { kind: 'requestLyrics'; songId?: number };

/* -------------------------------------------------------------- utilities */

/** Client `resourceDuration` is seconds; the wire format is milliseconds. */
export function secondsToMs(seconds: number | null | undefined): number | null {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return null;
  return Math.round(seconds * 1000);
}

/**
 * Milliseconds to the whole seconds the client's `audioplayer.seek` expects.
 *
 * Measured, not assumed: the client's own progress bar called
 * `seek({playId, seekId, value: 109})` for a target of 109 seconds, and the reply
 * echoed `position: 109`. Whole seconds it is - and rounding rather than flooring
 * matters at the end of a track, where flooring a 0.6s remainder would seek a
 * fraction of a second short of the point the user released the pointer.
 */
export function msToSeekSeconds(positionMs: number | null | undefined): number | null {
  if (positionMs === null || positionMs === undefined || !Number.isFinite(positionMs)) return null;
  return Math.max(0, Math.round(positionMs / 1000));
}

/**
 * The client's `seekId`: a fresh, unique string per seek.
 *
 * Taken from what the client itself sends - `"<songId>|seek|<random>"` - because the
 * reply is matched by this id, so two seeks racing each other must not share one.
 */
export function makeSeekId(songId: number | string | null | undefined, random: string): string {
  return `${songId == null ? '' : songId}|seek|${random}`;
}

/** Client song ids arrive as strings in some fields and numbers in others. */
export function toSongId(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return null;
}

export function rawPlayingStateToStatus(raw: number | null | undefined): PlaybackStatus {
  if (raw === PLAYING_STATE.PLAYING) return 'playing';
  if (raw === PLAYING_STATE.PAUSED) return 'paused';
  if (raw === null || raw === undefined) return 'unknown';
  return 'unknown';
}
