/**
 * UI entry point: wires the host link, the clock, the card and the lyrics together,
 * then drives everything from a single animation-frame loop.
 *
 * One loop, one place that advances time. Nothing else uses setInterval, so the
 * card cannot end up with competing timelines.
 */

import { CardView } from './card.js';
import { PlayClock, isSampleStale } from './clock.js';
import { LyricsView } from './lyrics.js';
import { HostLink } from './socket.js';

const DEFAULT_HOST_PORT = 8787;
/** If the client stops reporting for this long, stop extrapolating. */
const STALE_FREEZE_MS = 2500;

const view = new CardView();
const clock = new PlayClock();
const lyrics = new LyricsView(document.getElementById('lyrics'));

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

      if (trackChanged) {
        staleSince = 0;
        // Drop the previous track's lyrics so we never show them against the new
        // song while the new document is in flight.
        if (lastLyricsDoc && lastLyricsDoc.songId !== songId) {
          lastLyricsDoc = null;
          lyrics.setDocument({ songId, lines: [], hasWordTiming: false, instrumental: false });
        }
      }
      break;
    }

    case 'playhead':
      clock.onPlayhead(message.playhead, message.songId ?? lastSnapshot?.song?.id ?? null);
      staleSince = 0;
      break;

    case 'lyrics':
      lastLyricsDoc = message.doc;
      lyrics.setDocument(message.doc);
      break;

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
      if (!connected) view.setConnection({ state: 'disconnected', detail: '正在连接宿主…' });
    },
  });

  bindInput();
  view.setFace(hidden ? 'front' : 'front');
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
}

void boot();
