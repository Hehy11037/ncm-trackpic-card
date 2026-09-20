/**
 * Lyrics service: source selection, the on-disk cache and request coalescing.
 *
 * ## Source order, and the evidence behind it
 *
 * The client's own lyric document is preferred because the brief is to mirror what NetEase
 * displays - including "作词: …" / "作曲: …" for a track that has no singable lyrics. It also
 * needs no network and reflects the account's gated tracks.
 *
 * But the client's store **lags a track change**, measured:
 *
 *   t+0s   playing song id 2650440016, the lyric slice still holds the previous track's lines
 *   t+2s   playing song id 2650440015, slice = 79 lines starting "作词: KikKuU"
 *
 * So for a few hundred milliseconds the client reports the *new* id with the *old* lyrics, and
 * stale full lyrics are indistinguishable from real ones by inspection. A delay was tried and
 * removed: for a track with no lyrics of its own the stale data is all the client ever offers,
 * so waiting simply delivered the wrong song a few seconds later.
 *
 * What works instead is **verification**: accept a client set only when the track's own name or
 * artist appears in it. Real lyrics carry the artist; the credits do too ("作词: FAIZ"). A stale
 * set from a different track does not mention this track, so it is rejected outright.
 *
 * If the client has nothing that verifies, the public endpoint answers - it is keyed by song id
 * and so cannot be wrong about which track it describes.
 */

import type { ClientLyricSlice, LyricDoc } from '../../shared/src/index.ts';

import {
  docFromClientSlice,
  docFromRawPayload,
  isCreditOnlySet,
  lyricsMentionTrack,
} from './lyric/build.ts';
import { readCachedLyrics, pruneLyricCache, writeCachedLyrics } from './lyric/cache.ts';
import { fetchPublicLyrics, type FetchOptions } from './lyric/fetch.ts';
import type { ClientSession } from './session.ts';

export interface LyricsServiceOptions {
  session: ClientSession;
  fetchOptions?: FetchOptions;
  log?: (level: 'debug' | 'info' | 'warn', message: string) => void;
  onDoc: (doc: LyricDoc) => void;
  /** Pause before retrying a failed public-endpoint fetch. Injectable so tests stay fast. */
  retryDelayMs?: number;
}

/**
 * How long to wait before retrying a failed public-endpoint fetch.
 *
 * Long enough not to hammer an endpoint that just rate-limited us, short enough that the lyrics
 * still arrive while the track is playing.
 */
const FETCH_RETRY_DELAY_MS = 1500;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** A public-endpoint attempt: the document, and whether the request itself failed. */
interface FetchOutcome {
  doc: LyricDoc | null;
  failed: boolean;
}

export class LyricsService {
  private readonly session: ClientSession;
  private readonly fetchOptions: FetchOptions;
  private readonly log: (level: 'debug' | 'info' | 'warn', message: string) => void;
  private readonly onDoc: (doc: LyricDoc) => void;
  private readonly retryDelayMs: number;

  /** Documents by song id, so a repeat visit needs no work. */
  private readonly docs = new Map<number, LyricDoc>();
  /** In-flight fetches, to coalesce duplicate requests. */
  private readonly inFlight = new Map<number, Promise<FetchOutcome>>();
  /** The track the service is currently answering for. */
  private currentSongId: number | null = null;
  /** The latest client slice for the current track, tried again on each update. */
  private pendingClientSlice: ClientLyricSlice | null = null;

  constructor(options: LyricsServiceOptions) {
    this.session = options.session;
    this.fetchOptions = options.fetchOptions ?? {};
    this.log = options.log ?? (() => {});
    this.onDoc = options.onDoc;
    this.retryDelayMs = options.retryDelayMs ?? FETCH_RETRY_DELAY_MS;
  }

  start(): void {
    this.session.on('lyricsNeeded', (songId: number) => {
      void this.onTrackChange(songId);
    });
    this.session.on('clientLyrics', (slice: ClientLyricSlice) => {
      this.onClientLyrics(slice);
    });
  }

  /** Release timers. Called on host shutdown so the process can exit. */
  stop(): void {
    /*
     * The only timer this service can hold is the pause before retrying a failed fetch, which is
     * at most `retryDelayMs` long. Interrupting it would need an abort signal threaded through
     * the sleep, which is not worth the machinery: a shutdown waits at most 1.5 seconds, and the
     * shell kills the host anyway.
     */
  }

  /** Latest known document for a song, from memory or the disk cache. */
  get(songId: number): LyricDoc | null {
    const cached = this.docs.get(songId);
    if (cached) return cached;
    const onDisk = readCachedLyrics(songId);
    if (onDisk) this.docs.set(songId, onDisk);
    return onDisk;
  }

  /** Drop expired cache entries. Called once on start. */
  prune(): { removed: number; kept: number } {
    return pruneLyricCache();
  }

  private remember(doc: LyricDoc): void {
    this.docs.set(doc.songId, doc);
    writeCachedLyrics(doc);
    this.onDoc(doc);
  }

  /** Track name and artist for the current song, used to verify client data. */
  private currentTrackNames(): { name: string; artist: string } {
    const song = this.session.currentSnapshot?.song;
    return {
      name: song?.name ?? '',
      artist: (song?.artists ?? []).map((a) => a.name).join(' / '),
    };
  }

  private async onTrackChange(songId: number): Promise<void> {
    this.currentSongId = songId;
    this.pendingClientSlice = null;

    const cached = this.get(songId);
    if (cached && cached.lines.length > 0) {
      this.log('debug', `歌词命中缓存: ${songId}（${cached.lines.length} 行）`);
      this.onDoc(cached);
      return;
    }

    /*
     * Only the public endpoint here. The client's slice arrives on its own schedule and is
     * handled by onClientLyrics, which can verify it; asking for it at this instant would very
     * likely return the previous track's lines.
     */
    let outcome = await this.fetchFromApi(songId);
    if (this.currentSongId !== songId) {
      this.log('debug', `丢弃过期歌词结果: ${songId}`);
      return;
    }

    if (outcome.failed) {
      /*
       * Retry a failed request once.
       *
       * "The request failed" and "this track has no lyrics" used to be indistinguishable here:
       * both fell through to the same log line, and nothing ever tried again. One timeout or one
       * transient rate limit therefore left the track showing only its credits for the rest of
       * the session - which reads exactly like a song that has no lyrics.
       */
      this.log('warn', `公开接口请求失败: ${songId}，${this.retryDelayMs}ms 后重试一次`);
      await sleep(this.retryDelayMs);
      if (this.currentSongId !== songId) {
        this.log('debug', `放弃重试（已切歌）: ${songId}`);
        return;
      }
      outcome = await this.fetchFromApi(songId);
      if (this.currentSongId !== songId) {
        this.log('debug', `丢弃过期歌词结果: ${songId}`);
        return;
      }
    }

    const { doc, failed } = outcome;
    if (doc && doc.lines.length > 0 && !this.docs.get(songId)?.lines.length) {
      this.remember(doc);
      this.log(
        'info',
        `歌词来自公开接口: ${songId}（${doc.lines.length} 行，逐字=${doc.hasWordTiming}）`,
      );
      return;
    }
    if (failed) {
      // Not cached: a network failure says nothing about whether the track has lyrics.
      this.log('warn', `公开接口两次请求都失败: ${songId}（仅等待客户端，不写入缓存）`);
      return;
    }
    this.log('debug', `公开接口无可显示歌词: ${songId}（等待客户端）`);
  }

  private fetchFromApi(songId: number): Promise<FetchOutcome> {
    const existing = this.inFlight.get(songId);
    if (existing) return existing;
    const task = (async (): Promise<FetchOutcome> => {
      const payload = await fetchPublicLyrics(songId, this.fetchOptions);
      if (payload.fetchFailed) return { doc: null, failed: true };
      return { doc: docFromRawPayload(songId, payload), failed: false };
    })();
    this.inFlight.set(songId, task);
    void task.finally(() => this.inFlight.delete(songId));
    return task;
  }

  /**
   * Handle a lyric slice from the client.
   *
   * Accepted when it verifies against the current track (its name or artist appears in the
   * set). That is what separates this track's lyrics from the previous track's, which the store
   * briefly reports under the new song id. A public result never overwrites an accepted client
   * document, because the client is what the brief asks us to mirror.
   */
  private onClientLyrics(slice: ClientLyricSlice): void {
    if (slice.songId == null) return;

    if (this.currentSongId != null && slice.songId !== this.currentSongId) {
      this.log('debug', `忽略非当前歌曲的客户端歌词: ${slice.songId}（当前 ${this.currentSongId}）`);
      return;
    }

    this.pendingClientSlice = slice;

    const existing = this.docs.get(slice.songId);
    if (existing && existing.lines.length > 0 && existing.source === 'client') {
      return; // already showing verified client lyrics for this track
    }

    const { name, artist } = this.currentTrackNames();
    const verified = lyricsMentionTrack(slice.lyricLines, name, artist);
    const creditsOnly = isCreditOnlySet(slice.lyricLines);

    /*
     * Progress reporting matters for the UI: until this track's own lyric content shows up the
     * overlay should say "loading", not "no lyrics".
     */
    const doc = docFromClientSlice(slice);
    if (!doc) {
      this.log('debug', `客户端歌词尚未就绪: ${slice.songId}`);
      return;
    }

    if (doc.lines.length === 0) {
      if (slice.isLoading || slice.isLyricFetchFailed) return;
      const publicDoc = this.docs.get(slice.songId);
      if (publicDoc && publicDoc.lines.length > 0) {
        this.log('debug', `客户端报告无歌词，保留公开接口结果: ${slice.songId}`);
        return;
      }
      this.remember(doc);
      this.log('info', `客户端报告为纯音乐/无歌词: ${slice.songId}`);
      return;
    }

    /*
     * Unverified data is rejected unless it is the credits-only shape, which is what a track
     * with no singable lyrics legitimately shows. The name check cannot verify that case - a
     * lyric-less track's credits may name only the composer - so it is allowed through, and the
     * cost of being wrong is showing two credit lines instead of the previous song's lyrics.
     */
    if (!verified && !creditsOnly) {
      this.log(
        'debug',
        `客户端歌词未通过校验，判定为其他歌曲的数据: ${slice.songId}` +
          `（未提及「${name || '?'}」或「${artist || '?'}」）`,
      );
      return;
    }

    this.remember(doc);
    this.log(
      'info',
      `歌词来自客户端${verified ? '（已校验）' : '（仅制作人员信息）'}: ${slice.songId}` +
        `（${doc.lines.length} 行，逐字=${doc.hasWordTiming}）`,
    );
  }

  /**
   * Force a fetch, ignoring the caches. Used when the overlay asks explicitly.
   *
   * Public endpoint first: it is keyed by song id, so it cannot answer for a different track.
   */
  async refresh(songId: number): Promise<LyricDoc | null> {
    const { doc } = await this.fetchFromApi(songId);
    if (doc && doc.lines.length > 0) {
      this.remember(doc);
      return doc;
    }
    return this.docs.get(songId) ?? null;
  }
}
