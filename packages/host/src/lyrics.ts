/**
 * Lyrics service: owns the fallback logic between the client's lyric document and
 * the public endpoint, plus the on-disk cache and request coalescing.
 *
 * Flow, per song:
 *
 *   1. `lyricsNeeded(songId)` fires on track change.
 *      - cache hit            -> emit immediately
 *      - otherwise            -> fetch the public endpoint (so the UI has
 *                                something even before the client resolves)
 *   2. `clientLyrics(slice)` arrives whenever the client's lyric slice changes.
 *      - if it has lines      -> it wins (client is authoritative and free); emit
 *      - if it is still empty -> keep whatever the public fetch produced, but do
 *                                not cache the empty client result as final
 *
 * The client result is preferred because it already reflects the client's cache,
 * session and - for account-gated tracks - data we cannot obtain ourselves.
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
}

export class LyricsService {
  private readonly session: ClientSession;
  private readonly fetchOptions: FetchOptions;
  private readonly log: (level: 'debug' | 'info' | 'warn', message: string) => void;
  private readonly onDoc: (doc: LyricDoc) => void;

  /** Documents by song id, so a repeat visit needs no work. */
  private readonly docs = new Map<number, LyricDoc>();
  /** In-flight fetches, to coalesce duplicate requests. */
  private readonly inFlight = new Map<number, Promise<LyricDoc | null>>();

  constructor(options: LyricsServiceOptions) {
    this.session = options.session;
    this.fetchOptions = options.fetchOptions ?? {};
    this.log = options.log ?? (() => {});
    this.onDoc = options.onDoc;
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

  /**
   * Force a public-API fetch, ignoring both caches. Used when the overlay asks
   * for lyrics explicitly (e.g. after a reconnect) so it never gets nothing back.
   * Client-sourced documents still win.
   */
  async refresh(songId: number): Promise<LyricDoc | null> {
    const existing = this.docs.get(songId) ?? readCachedLyrics(songId);
    if (existing && existing.source === 'client' && existing.lines.length > 0) {
      this.docs.set(songId, existing);
      return existing;
    }
    const doc = await this.fetchFromApi(songId);
    if (doc && doc.lines.length > 0) {
      this.remember(doc);
      return doc;
    }
    return this.docs.get(songId) ?? null;
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

  private async onTrackChange(songId: number): Promise<void> {
    const cached = this.get(songId);
    if (cached && cached.lines.length > 0) {
      this.log('debug', `歌词命中缓存: ${songId}（${cached.lines.length} 行）`);
      this.onDoc(cached);
      return;
    }

    const doc = await this.fetchFromApi(songId);
    if (!doc || doc.lines.length === 0) {
      this.log('debug', `公开接口暂无歌词: ${songId}（等待客户端）`);
      return;
    }

    // The client is authoritative. It may have answered while this fetch was in
    // flight (it is the faster path in practice), so never clobber a
    // client-sourced document with the fallback.
    const clientDoc = this.docs.get(songId);
    if (clientDoc && clientDoc.source === 'client' && clientDoc.lines.length > 0) {
      this.log('debug', `公开接口结果被客户端结果取代: ${songId}`);
      return;
    }

    this.remember(doc);
    this.log('info', `歌词来自公开接口: ${songId}（${doc.lines.length} 行，逐字=${doc.hasWordTiming}）`);
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

  private onClientLyrics(slice: ClientLyricSlice): void {
    if (slice.songId == null) return;
    const doc = docFromClientSlice(slice);
    if (!doc) {
      // Still loading, or the client could not fetch: leave any public result be.
      this.log('debug', `客户端歌词尚未就绪: ${slice.songId}`);
      return;
    }

    if (doc.lines.length === 0) {
      // The client is authoritative on "no lyrics" (instrumental, or gated).
      // Only trust it once it is not loading and not failed.
      if (slice.isLoading || slice.isLyricFetchFailed) return;
      const existing = this.docs.get(slice.songId);
      if (existing && existing.lines.length > 0) {
        this.log('debug', `客户端报告无歌词，但已有公开接口结果，保留之: ${slice.songId}`);
        return;
      }
      this.remember(doc);
      this.log('info', `客户端报告为纯音乐/无歌词: ${slice.songId}`);
      return;
    }

    const previous = this.docs.get(slice.songId);
    if (previous && previous.lines.length === doc.lines.length && previous.source === 'client') {
      // Same shape, nothing new to send.
      this.docs.set(slice.songId, doc);
      return;
    }

    this.remember(doc);
    this.log(
      'info',
      `歌词来自客户端: ${slice.songId}（${doc.lines.length} 行，逐字=${doc.hasWordTiming}，` +
        `用法=${slice.currentUsedLyric ?? '?'}）`,
    );
  }
}
