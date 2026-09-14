/**
 * UI entry point: wires the host link, the clock, the card and the lyrics together,
 * then drives everything from a single animation-frame loop.
 *
 * One loop, one place that advances time. Nothing else uses setInterval, so the
 * card cannot end up with competing timelines.
 */

import { CardView } from './card.js';
import { PlayClock, isSampleStale } from './clock.js';
import { applyLayoutUnit } from './layout.js';
import { LyricsView } from './lyrics.js';
import { HostLink } from './socket.js';

const DEFAULT_HOST_PORT = 8787;
/** If the client stops reporting for this long, stop extrapolating. */
const STALE_FREEZE_MS = 2500;

/*
 * Construction order matters: the lyrics view is referenced by the card view's palette
 * callback, so it must exist before the callback can fire. The card is built after it, and
 * declared first so the module-level bindings are initialised in the right order.
 */
const lyrics = new LyricsView(document.getElementById('lyrics'));
const view = new CardView({
  // Hand the palette and the current background to the lyrics view, which picks text
  // colours by contrast against that background.
  onPalette: (colors, background) => lyrics.setPalette(colors, background),
});
const clock = new PlayClock();

// Size the composition to the stage before the first paint.
applyLayoutUnit(document.getElementById('stage'));

let link = null;
let connected = false;
let lastSnapshot = null;
let lastLyricsDoc = null;
let lastFrameAt = performance.now();
let hidden = false;
let staleSince = 0;

/* ------------------------------------------------------------------ messages */

function handleMessage(message) {
  switch (message?.kind) {
    case 'hello':
      console.info(`[overlay] 宿主协议 v${message.protocol}（宿主 ${message.hostVersion}）`);
      break;

    case 'snapshot': {
      lastSnapshot = message.snapshot;
      const songId = message.snapshot.song?.id ?? null;
      const trackChanged = view.setSnapshot(message.snapshot);
      clock.onPlayback(message.snapshot.playback ?? {}, message.snapshot.song?.durationMs ?? 0);

      // Keep the lyrics header (title/artist) in step with the current track.
      lyrics.setSongInfo(
        message.snapshot.song?.name ?? '',
        (message.snapshot.song?.artists ?? []).map((a) => a.name).join(' / '),
      );

      if (trackChanged) {
        staleSince = 0;
        /*
         * Clear immediately rather than leaving the previous document on screen: when a new
         * track's lyrics have not arrived yet, the old ones would otherwise render, which is
         * how a song appeared to show the previous song's lyrics.
         */
        lastLyricsDoc = null;
        lyrics.clear('歌词加载中…');
        // The host answers from its cache when it has them, so this is cheap.
        link.send({ kind: 'requestLyrics', songId: songId ?? undefined });
      }
      break;
    }

    case 'playhead':
      clock.onPlayhead(message.playhead, message.songId ?? lastSnapshot?.song?.id ?? null);
      staleSince = 0;
      break;

    case 'lyrics': {
      /*
       * Discard a document that does not belong to the current track.
       *
       * The host can have a request in flight for the previous song when a track change
       * happens; without this check that stale document renders for the new song.
       */
      const currentSongId = lastSnapshot?.song?.id ?? null;
      if (currentSongId != null && message.doc?.songId != null && message.doc.songId !== currentSongId) {
        console.debug('[overlay] 忽略过期歌词', message.doc.songId, '当前', currentSongId);
        break;
      }
      lastLyricsDoc = message.doc;
      lyrics.setDocument(message.doc);
      break;
    }

    case 'connection':
      view.setConnection(message.connection);
      connected = message.connection?.state === 'ready';
      break;

    case 'error':
      console.warn('[overlay]', message.message);
      break;

    default:
      break;
  }
}

/* -------------------------------------------------------------------- input */

function bindInput() {
  document.getElementById('flip').addEventListener('click', () => view.flip());

  for (const button of document.querySelectorAll('.ctrl[data-action]')) {
    button.addEventListener('click', () => {
      const action = button.dataset.action;
      if (action === 'playPause') {
        // Optimistic: flip locally so the button feels instant, and let the next
        // snapshot correct us if the client disagrees.
        const status = lastSnapshot?.playback?.status;
        clock.onPlayback(
          { ...(lastSnapshot?.playback ?? {}), status: status === 'playing' ? 'paused' : 'playing' },
          clock.durationMs,
        );
        link.control({ type: 'playPause' });
        return;
      }
      if (action === 'next' || action === 'previous') link.control({ type: action });
    });
  }

  document.addEventListener('keydown', (event) => {
    if (event.code === 'Space') {
      event.preventDefault();
      link.control({ type: 'playPause' });
    } else if (event.key === 'ArrowRight') {
      link.control({ type: 'next' });
    } else if (event.key === 'ArrowLeft') {
      link.control({ type: 'previous' });
    } else if (event.key === 'f' || event.key === 'F') {
      view.flip();
    } else if (event.key === 't' || event.key === 'T') {
      // Toggle lyric translations. Off is often preferred: a translation on every entry
      // makes them uneven heights and crowds the page.
      lyrics.setTranslationVisible(document.documentElement.dataset.lyricTranslation === 'off');
    }
  });

  document.addEventListener('visibilitychange', () => {
    hidden = document.hidden;
  });

  // Pause the sweep while the mouse is away from the window (cheap CPU win).
  window.addEventListener('blur', () => {
    hidden = true;
  });
  window.addEventListener('focus', () => {
    hidden = document.hidden;
  });
}

/* --------------------------------------------------------------------- loop */

function frame() {
  const now = performance.now();
  const dt = Math.min(now - lastFrameAt, 120);
  lastFrameAt = now;

  // If the client stopped reporting (paused in the client, or the channel dropped),
  // freeze rather than extrapolating into fiction.
  const stale = lastSnapshot ? isSampleStale(lastSnapshot.playhead) : false;
  if (stale) staleSince = staleSince || now;
  else staleSince = 0;
  const frozen = stale && now - staleSince > STALE_FREEZE_MS;

  if (!frozen) clock.tick(now);

  view.tick(clock.positionMs, clock.fraction);
  // Lyrics stay in sync even while the front face shows, so flipping is instant.
  lyrics.tick(clock.positionMs, dt, !hidden);

  requestAnimationFrame(frame);
}

/* --------------------------------------------------------------------- boot */

async function loadConfig() {
  try {
    const res = await fetch('./config.json', { cache: 'no-store' });
    if (!res.ok) return;
    const json = await res.json();
    if (typeof json.hostPort === 'number') config.port = json.hostPort;
  } catch {
    // The host may not be up yet; defaults are fine.
  }
}

const config = { port: DEFAULT_HOST_PORT };

async function boot() {
  await loadConfig();

  link = new HostLink({
    port: config.port,
    onMessage: handleMessage,
    onStatus: (state) => {
      connected = state === 'connected';
      if (connected) return;
      // A silent disconnection previously looked identical to "nothing playing", so
      // the card states which one it is.
      view.setConnection({ state: 'disconnected', detail: `未连接宿主 (${link.url})` });
      view.setIdle(`未连接宿主 ${config.port}`);
    },
  });

  bindInput();
  link.connect();
  requestAnimationFrame(frame);

  globalThis.__overlay = {
    view,
    clock,
    lyrics,
    link,
    get snapshot() {
      return lastSnapshot;
    },
  };

  // Tell the page-level watchdog that rendering succeeded, which hides the banner.
  globalThis.__booted = true;
  const bootError = document.getElementById('boot-error');
  if (bootError) bootError.hidden = true;
  console.info(`[overlay] 已启动，宿主 ws://127.0.0.1:${config.port}`);
}

void boot().catch((error) => {
  // Surface startup failures in the page, not just the console.
  const message = error instanceof Error ? `${error.message}` : String(error);
  if (typeof globalThis.__bootFail === 'function') globalThis.__bootFail(message);
  console.error('[overlay] 启动失败', error);
});
