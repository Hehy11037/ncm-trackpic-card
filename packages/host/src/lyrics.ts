/**
 * Lyrics service: owns source selection, the on-disk cache and request coalescing.
 *
 * ## Source order, and why the public endpoint comes first
 *
 * The client's lyric store looked like the better source - no network, and it already reflects
 * the client's own cache and account - but it **cannot be trusted across a track change**.
 * Measured:
 *
 *   t+0s   playing song id 2650440016, the client's lyric slice still holds the previous
 *          track's lines, and its `version` does not change until the fetch completes
 *   t+2s   playing song id 2650440015, slice = 79 lines starting "作词: KikKuU"
 *
 * The store's song id changes immediately while its lyric slice lags behind, so for a few
 * hundred milliseconds the client reports the *new* id with the *old* lyrics. Real lyrics
 * cannot be told apart from stale ones by inspection, and a credit-only set (what an unloaded
 * track looks like) is not the only bad shape - the stale set can be full lyrics too. So the
 * client is a fallback only.
 *
 * The public endpoint is keyed by song id and therefore cannot be wrong about which track it
 * describes. It also returns word-by-word `yrc` when one exists.
 *
 * Flow per track:
 *   1. `lyricsNeeded(songId)` -> cache, else the public endpoint; if that yields nothing
 *      usable, the client slice fills in later via step 2.
 *   2. `clientLyrics(slice)`  -> used only while the public result for that song is missing.
 */

import type { ClientLyricSlice, LyricDoc } from '@ncm-trackpic-card/shared';

import { docFromClientSlice, docFromRawPayload } from './lyric/build.ts';
import { readCachedLyrics, pruneLyricCache, writeCachedLyrics } from './lyric/cache.ts';
import { fetchPublicLyrics, type FetchOptions } from './lyric/fetch.ts';
import type { ClientSession } from './session.ts';

export interface LyricsServiceOptions {
  session: ClientSession;
  fetchOptions?: FetchOptions;
  log?: (level: 'debug' | 'info' | 'warn', message: string) => void;
  onDoc: (doc: LyricDoc) => void;
  /**
   * How long to wait for the public endpoint before accepting the client's lyrics.
   *
   * The client's store lags a track change by a few hundred milliseconds, which is what made
   * it report the previous track's lyrics under the new id. Waiting this long guarantees the
   * store has caught up, so a client fallback is safe by then. Short enough that a track whose
   * lyrics only the client has still shows them quickly.
   */
  clientFallbackDelayMs?: number;
}

/** Default grace period before the client slice is trusted; see the option's doc comment. */
const CLIENT_FALLBACK_DELAY_MS = 4000;

export class LyricsService {
  private readonly session: ClientSession;
  private readonly fetchOptions: FetchOptions;
  private readonly log: (level: 'debug' | 'info' | 'warn', message: string) => void;
  private readonly onDoc: (doc: LyricDoc) => void;
  private readonly fallbackDelayMs: number;

  /** Documents by song id, so a repeat visit needs no work. */
  private readonly docs = new Map<number, LyricDoc>();
  /** In-flight fetches, to coalesce duplicate requests. */
  private readonly inFlight = new Map<number, Promise<LyricDoc | null>>();
  /** The track the service is currently answering for. */
  private currentSongId: number | null = null;
  /** The most recent client slice for the current track, held for the fallback. */
  private pendingClientSlice: ClientLyricSlice | null = null;
  private fallbackTimer: NodeJS.Timeout | null = null;

  constructor(options: LyricsServiceOptions) {
    this.session = options.session;
    this.fetchOptions = options.fetchOptions ?? {};
    this.log = options.log ?? (() => {});
    this.onDoc = options.onDoc;
    this.fallbackDelayMs = options.clientFallbackDelayMs ?? CLIENT_FALLBACK_DELAY_MS;
  }

  start(): void {
    this.session.on('lyricsNeeded', (songId: number) => {
      void this.onTrackChange(songId);
    });
    this.session.on('clientLyrics', (slice: ClientLyricSlice) => {
      this.onClientLyrics(slice);
    });
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

  /** Release timers. Called on host shutdown so the process can exit. */
  stop(): void {
    this.clearFallbackTimer();
  }

  private remember(doc: LyricDoc): void {
    this.docs.set(doc.songId, doc);
    writeCachedLyrics(doc);
    this.onDoc(doc);
  }

  private async onTrackChange(songId: number): Promise<void> {
    this.currentSongId = songId;
    this.pendingClientSlice = null;
    this.clearFallbackTimer();

    const cached = this.get(songId);
    if (cached && cached.lines.length > 0) {
      this.log('debug', `歌词命中缓存: ${songId}（${cached.lines.length} 行）`);
      this.onDoc(cached);
      return;
    }

    const doc = await this.fetchFromApi(songId);

    // The track can change while this is in flight; the newer request owns the answer.
    if (this.currentSongId !== songId) {
      this.log('debug', `丢弃过期歌词结果: ${songId}`);
      return;
    }

    /*
     * Only a document *with lines* is stored.
     *
     * A result with no lines is not kept: it would occupy the slot for this song and block the
     * client slice from filling it in. That matters because the endpoint returns a credit-only
     * stub - which parses to zero lines - for tracks whose lyrics the client does have.
     */
    if (doc && doc.lines.length > 0) {
      this.remember(doc);
      this.log(
        'info',
        `歌词来自公开接口: ${songId}（${doc.lines.length} 行，逐字=${doc.hasWordTiming}）`,
      );
      return;
    }

    this.log('debug', `公开接口暂无歌词: ${songId}（等待客户端）`);
    this.scheduleClientFallback(songId);
  }

  /**
   * Accept the client's lyrics if the public endpoint has produced nothing in time.
   *
   * By the time this fires the client's store has long since caught up with the track change,
   * so its lyrics belong to this song. Without the delay the store may still hold the previous
   * track's lines, which is the bug this ordering exists to prevent.
   */
  private scheduleClientFallback(songId: number): void {
    this.clearFallbackTimer();
    this.fallbackTimer = setTimeout(() => {
      this.fallbackTimer = null;
      if (this.currentSongId !== songId) return;
      if (this.docs.get(songId)?.lines.length) return;

      if (this.pendingClientSlice?.songId === songId) {
        this.onClientLyrics(this.pendingClientSlice, { force: true });
      } else {
        this.log('debug', `宽限期结束，仍无歌词可用: ${songId}`);
      }
    }, this.fallbackDelayMs);
  }

  private clearFallbackTimer(): void {
    if (this.fallbackTimer) {
      clearTimeout(this.fallbackTimer);
      this.fallbackTimer = null;
    }
  }

  private fetchFromApi(songId: number): Promise<LyricDoc | null> {
    const existing = this.inFlight.get(songId);
    if (existing) return existing;
    const task = (async () => {
      const payload = await fetchPublicLyrics(songId, this.fetchOptions);
      if (payload.fetchFailed) return null;
      return docFromRawPayload(songId, payload);
    })();
    this.inFlight.set(songId, task);
    void task.finally(() => this.inFlight.delete(songId));
    return task;
  }

  /**
   * Handle a lyric slice from the client.
   *
   * Used only to fill a gap: when there is no usable public result for this song. A slice that
   * does not match the current track, or that carries nothing but credits, is ignored - which
   * is what stops the previous track's lyrics appearing under the new one.
   *
   * The slice is also remembered, so the delayed fallback can use it once the store has had
   * time to catch up with the track change.
   *
   * @param options.force set by the fallback timer, which runs after the grace period
   */
  private onClientLyrics(slice: ClientLyricSlice, options: { force?: boolean } = {}): void {
    if (slice.songId == null) return;

    if (this.currentSongId != null && slice.songId !== this.currentSongId) {
      this.log('debug', `忽略非当前歌曲的客户端歌词: ${slice.songId}（当前 ${this.currentSongId}）`);
      return;
    }

    this.pendingClientSlice = slice;

    const existing = this.docs.get(slice.songId);
    if (existing && existing.lines.length > 0) {
      // The public result already answered for this song; nothing to fill in.
      return;
    }

    /*
     * Before the grace period expires the client slice is only remembered, not used: the store
     * can still be holding the previous track's lines under this song's id.
     */
    if (!options.force && this.fallbackTimer) {
      return;
    }

    const doc = docFromClientSlice(slice);
    if (!doc) {
      // Credit-only, empty while loading, or a failed fetch: not usable as lyrics.
      this.log('debug', `客户端歌词不可用: ${slice.songId}`);
      return;
    }

    this.remember(doc);
    if (doc.lines.length === 0) {
      this.log('info', `客户端报告为纯音乐/无歌词: ${slice.songId}`);
    } else {
      this.log(
        'info',
        `歌词来自客户端（公开接口无结果）: ${slice.songId}（${doc.lines.length} 行，` +
          `逐字=${doc.hasWordTiming}）`,
      );
    }
  }

  /**
   * Force a fetch, ignoring the caches. Used when the overlay asks explicitly.
   *
   * Always the public endpoint: unlike the client's store it is keyed by song id, so a stale
   * answer for a different track is impossible.
   */
  async refresh(songId: number): Promise<LyricDoc | null> {
    const doc = await this.fetchFromApi(songId);
    if (doc && doc.lines.length > 0) {
      this.remember(doc);
      return doc;
    }
    return this.docs.get(songId) ?? null;
  }
}
