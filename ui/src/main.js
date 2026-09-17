/**
 * UI entry point: wires the host link, the clock, the card and the lyrics together,
 * then drives everything from a single animation-frame loop.
 *
 * One loop, one place that advances time. Nothing else uses setInterval, so the
 * card cannot end up with competing timelines.
 */

import { CardView, MODE_CYCLE } from './card.js';
import { PlayClock, isSampleStale } from './clock.js';
import { chooseCover, coverButtonState, coverButtonTitle, shouldRefetchCover } from './cover-choice.js';
import { installDragToMove } from './drag.js';
import { relayout } from './layout.js';
import { LyricsView } from './lyrics.js';
import { createOptimisticHold } from './optimistic.js';
import { installResizeClock } from './resize-clock.js';
import { installScrub } from './scrub.js';
import { HostLink } from './socket.js';

const DEFAULT_HOST_PORT = 8787;
/** If the client stops reporting for this long, stop extrapolating. */
const STALE_FREEZE_MS = 2500;

/**
 * The Electron shell's bridge, or null in a plain browser.
 *
 * Everything here is optional: the page must run identically when served to a browser for
 * development, where there is no window to resize or close. See apps/overlay/preload.cjs.
 */
const shell = () => globalThis.overlayShell ?? null;

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
relayout(document.getElementById('stage'));

let link = null;let connected = false;
let lastSnapshot = null;
let lastLyricsDoc = null;
let lastFrameAt = performance.now();
let hidden = false;
let staleSince = 0;
/** "Do not auto-collapse". Owned by the shell; this is only the copy the button renders. */
let locked = true;

/* ------------------------------------------------------------------- lock */

/**
 * Reflect the shell's lock state. The shell owns the value, persists it, and offers the same
 * toggle in its tray menu, so the button here is a view rather than a second source of truth.
 *
 * In a plain browser there is no shell and therefore no roll-up, so the button has nothing to
 * control; it still renders, showing whatever the shell last said (locked, by default).
 */
function applyLocked(next) {
  locked = next === true;
  view.setLocked(locked);
}

/** Toggle via the shell. The shell answers with the new state, which is what updates the view. */
function toggleLock() {
  const bridge = shell();
  if (!bridge?.toggleLock) {
    // No bridge: flip locally so the button still responds, even though nothing will roll up.
    applyLocked(!locked);
    return;
  }
  bridge.toggleLock();
}

/* ------------------------------------------------------------ custom cover */

/*
 * A cover of the user's own, which temporarily stands in for the song's.
 *
 * The shell owns it: it holds the file dialog, keeps the image, and persists whether it is switched on,
 * so the choice survives a restart and there is one source of truth. What arrives here is only
 * `{ has, enabled }` - the image itself is fetched once, because it is a data URL and re-sending it on
 * every state broadcast would be silly. `chooseCover` decides which URL the card draws.
 */
let customCover = { has: false, enabled: false, url: null, rev: 0 };

/** Draw whatever the state says should be drawn, and match the button to it. */
function applyCoverChoice() {
  const trackUrl = lastSnapshot?.song?.coverUrl ?? null;
  const state = coverButtonState(customCover);
  view.setCoverState(state, coverButtonTitle(state));
  // `applyCover` returns early when the URL has not changed, so this is cheap to call often.
  view.applyCover(chooseCover({ trackUrl, custom: customCover }));
}

/** Pull the image itself, once per change, and then draw. */
async function refreshCustomCoverImage() {
  const bridge = shell();
  if (!customCover.has || !bridge?.coverUrl) {
    applyCoverChoice();
    return;
  }
  try {
    const url = await bridge.coverUrl();
    customCover = { ...customCover, url: typeof url === 'string' && url ? url : null };
  } catch {
    // A failed fetch just means no custom cover; the song's own is still drawn.
  }
  applyCoverChoice();
}

/**
 * The button's three jobs, from its own state: pick a file, switch the cover on, or switch it off.
 *
 * A right-click clears it - which is the only way back to the song's own cover once an image is
 * chosen, so it is named in the tooltip rather than hidden.
 */
function onCoverButton(event) {
  const bridge = shell();
  if (event.type === 'contextmenu') {
    event.preventDefault();
    if (customCover.has) bridge?.clearCover?.();
    return;
  }
  if (!customCover.has) {
    bridge?.pickCover?.();
    return;
  }
  bridge?.toggleCover?.();
}

/* ---------------------------------------------------------------- transport */

/** How long an optimistic value is held before a snapshot may overwrite it. */
const PLAY_PAUSE_OPTIMISM_MS = 1200;

/*
 * The three values the card draws ahead of the client. See ui/src/optimistic.js for the rule and
 * why it exists; the timeout is shared so a hold is never longer than the host's own confirmation
 * window by much.
 */
const playPauseHold = createOptimisticHold({ timeoutMs: PLAY_PAUSE_OPTIMISM_MS });
const modeHold = createOptimisticHold({ timeoutMs: PLAY_PAUSE_OPTIMISM_MS });
/** The client stores a float32, so 0.35 comes back as 0.34999999... - a tolerance, not equality. */
const volumeHold = createOptimisticHold({
  timeoutMs: PLAY_PAUSE_OPTIMISM_MS,
  equals: (client, mine) => typeof client === 'number' && Math.abs(client - mine) < 0.02,
});

/** The status to draw: the client's, unless an unconfirmed optimistic flip is still live. */
const displayedStatus = (clientStatus) => playPauseHold.resolve(clientStatus);

/** The mode to draw: the client's, unless a click has moved ahead of it. */
const displayedMode = (clientMode) => modeHold.resolve(clientMode);

/**
 * Play/pause, with the button's feedback tied to what the client actually did.
 *
 * The card *mirrors* the client, so drawing a state the client has not been observed in is a lie -
 * and it used to be a lasting one: the button flipped locally, the command was sent as `playPause`,
 * and the bridge had no case for it and threw, whereupon the next snapshot flipped the button back.
 * The result was a control that appeared to work for a moment and then undid itself, with the
 * reason visible only in the host's log.
 *
 * The flip is optimistic *and held*, and it is reverted when the host reports that the client did
 * not follow - with the reason said out loud rather than swallowed.
 */
function sendPlayPause() {
  // Read from the client's last state, adjusted by any flip already in flight: two quick presses
  // must flip twice, not send the same toggle twice while the card shows one.
  const wasPlaying = displayedStatus(lastSnapshot?.playback?.status ?? 'paused') === 'playing';
  const expect = wasPlaying ? 'paused' : 'playing';
  playPauseHold.set(expect);
  clock.onPlayback({ ...(lastSnapshot?.playback ?? {}), status: expect }, clock.durationMs);
  view.setStatus(expect);
  link.control({ type: 'playPause' });
}

/**
 * The host's verdict on a command.
 *
 * `confirmed === false` means the client was told to change state and was then observed not to.
 * `ok === false` means the command never even ran. Both undo whatever the card drew optimistically.
 */
function handleControlResult(result) {
  if (!result) return;
  const type = result.command?.type;
  const failed = result.ok !== true || result.confirmed === false;

  if (type === 'playPause') {
    if (!failed) {
      // The snapshot is already carrying the client's own state; nothing to hold any more.
      playPauseHold.clear();
      return;
    }
    // The status we were drawing was the opposite of what the client was in, so that is the one to
    // name in the log - and the card goes back to the last state the client was actually seen in.
    const wasPlaying = playPauseHold.value === 'paused';
    playPauseHold.clear();
    clock.onPlayback(lastSnapshot?.playback ?? {}, clock.durationMs);
    view.setStatus(lastSnapshot?.playback?.status ?? 'unknown');
    console.warn(`[overlay] 客户端未从「${wasPlaying ? '播放' : '暂停'}」改变`);
    return;
  }

  if (type === 'seek') {
    /*
     * The client's own receipt places the bar; then the playhead is the truth again.
     *
     * Releasing the preview alone would be enough while a track is playing, because progress
     * samples keep arriving - but a *paused* client may publish nothing, and the bar would snap
     * back to where the track was before the seek until something moved it. The seek reply carries
     * `position`, so the bar can be put where the client says it now is.
     */
    if (!failed && scrub && typeof result.positionMs === 'number') snapTo(result.positionMs);
    releaseScrub();
    if (failed) console.warn(`[overlay] 跳转未确认: ${result.message ?? result.via}`);
    return;
  }

  if (type === 'setVolume') {
    // An unconfirmed volume is put back to the client's own value rather than left wrong.
    if (failed) {
      volumeHold.clear();
      view.setVolume(lastSnapshot?.playback?.volume ?? null);
      console.warn(`[overlay] 音量未确认: ${result.message ?? result.via}`);
    }
    return;
  }

  if (type === 'setMode' && failed) {
    // Put the icon back to the mode the client is actually in, and stop holding a mode it refused.
    modeHold.clear();
    view.setMode(lastSnapshot?.playback?.mode ?? null);
    console.warn(`[overlay] 播放模式未确认: ${result.message ?? result.via}`);
  }
}

/* -------------------------------------------------------------- seek / scrub */

/** The scrub preview in flight: `{ ms, at }`, or null when the bar follows the clock. */
let scrub = null;

/** Stop previewing and hand the bar back to the playback clock. */
function releaseScrub() {
  scrub = null;
  view.setScrub(null);
}

/**
 * Move the clock to a position the client reported, without waiting for a progress sample.
 *
 * `onPlayhead` snaps rather than eases when the jump is large, which is exactly a seek, and it
 * re-anchors from there - so a paused track whose progress stream has gone quiet still shows the
 * position it was actually moved to.
 */
function snapTo(positionMs) {
  clock.onPlayhead(
    { positionMs, playId: lastSnapshot?.playhead?.playId ?? null, at: Date.now(), sampleCount: clock.sampleCount },
    lastSnapshot?.song?.id ?? null,
  );
}

/**
 * Seeking, by dragging the progress bar.
 *
 * Nothing is drawn from the client while the pointer is down: the preview *is* the position, and a
 * bar that snapped back to the playhead on every frame would be unusable. The command goes out on
 * release - a drag across the bar would otherwise be dozens of seeks, each of which the client
 * would act on.
 */
function installSeekBar() {
  const track = document.getElementById('progress-track');
  if (!track) return;
  installScrub(track, {
    axis: 'x',
    onPreview(fraction) {
      const duration = clock.durationMs;
      const ms = Math.round(fraction * (duration > 0 ? duration : 0));
      scrub = { ms, at: performance.now() };
      view.setScrub(fraction, ms);
    },
    onCancel: releaseScrub,
    onCommit(fraction) {
      const duration = clock.durationMs;
      if (!(duration > 0)) {
        releaseScrub();
        return;
      }
      const ms = Math.round(fraction * duration);
      scrub = { ms, at: performance.now() };
      view.setScrub(fraction, ms);
      link.control({ type: 'seek', positionMs: ms });
    },
  });
}

/* ------------------------------------------------------------------- volume */

/**
 * The volume bar, revealed on hover.
 *
 * The bar is a preview while dragging and the client's value otherwise, and the commit happens
 * once, on release: `setVolume` reaches the native player, and the client reports the new value
 * back through its own subscription a moment later - which is why the chosen value is *held*
 * (`volumeHold`) until it does.
 *
 * The panel is kept open by `data-open` rather than by `:hover` alone, because the pointer has to
 * be able to *reach* it. `:hover` ends the instant the pointer leaves the button's 4.6u box, and
 * the panel is 17.65u wide and sits above it - so a pointer travelling up and to the left crosses
 * ground that belongs to neither. Closing is therefore delayed, and any movement onto the panel
 * cancels the delay; without this the panel vanishes just before the pointer arrives at it, which
 * is exactly what the owner reported.
 */
function installVolumeBar() {
  const bar = document.getElementById('volume-bar');
  const wrap = document.getElementById('volume-wrap');
  const pop = document.getElementById('volume-pop');
  /** How long the panel waits after the pointer leaves before hiding. */
  const CLOSE_DELAY_MS = 280;
  let closeTimer = 0;

  const open = () => {
    clearTimeout(closeTimer);
    pop?.setAttribute('data-open', 'true');
  };
  const closeSoon = () => {
    clearTimeout(closeTimer);
    closeTimer = setTimeout(() => pop?.removeAttribute('data-open'), CLOSE_DELAY_MS);
  };

  // Entering the wrapper opens; leaving it *or the panel* starts the delay. The panel is a child of
  // the wrapper, so moving onto it does not leave the wrapper at all - the panel's own handlers
  // matter only for the case where the pointer enters from outside it.
  for (const element of [wrap, pop]) {
    element?.addEventListener('pointerenter', open);
    element?.addEventListener('pointerleave', closeSoon);
  }
  // A keyboard user gets the panel too: focusing the bar opens it, leaving closes it.
  bar?.addEventListener('focus', open);
  bar?.addEventListener('blur', closeSoon);

  if (!bar) return;
  installScrub(bar, {
    axis: 'x',
    onPreview(fraction, phase) {
      view.setVolumePreview(fraction);
      if (phase === 'start') open();
    },
    onCancel() {
      view.setVolume(lastSnapshot?.playback?.volume ?? null);
      closeSoon();
    },
    onCommit(fraction) {
      const volume = Math.max(0, Math.min(1, fraction));
      volumeHold.set(volume);
      closeSoon();
      link.control({ type: 'setVolume', volume });
    },
  });
}

/** Click the mode button: advance to the client's next mode in its own cycle order. */
function cycleMode() {
  /*
   * Advance from what the card is *showing*, falling back to the first mode when the client is in
   * one the card does not offer (`playAi`, `playFm`) - `indexOf` returns -1 there, and `(-1 + 1) % 4`
   * would then always land on the same mode, which looks exactly like a button with two modes.
   */
  const current = displayedMode(lastSnapshot?.playback?.mode ?? null) ?? MODE_CYCLE[0];
  const at = MODE_CYCLE.indexOf(current);
  const next = MODE_CYCLE[at < 0 ? 0 : (at + 1) % MODE_CYCLE.length];
  // Drawn immediately and held, so clicking faster than a round trip still walks all four modes -
  // and reverted if the host says the client refused it.
  modeHold.set(next);
  view.setMode(next);
  link.control({ type: 'setMode', mode: next });
}

/* ------------------------------------------------------------------ messages */

function handleMessage(message) {
  switch (message?.kind) {
    case 'hello':
      console.info(`[overlay] 宿主协议 v${message.protocol}（宿主 ${message.hostVersion}）`);
      break;

    case 'snapshot': {
      lastSnapshot = message.snapshot;
      const songId = message.snapshot.song?.id ?? null;
      /*
       * The client's snapshot, with any unconfirmed optimistic play/pause flip applied on top.
       *
       * The order these arrive in is the whole "the button feels slow" bug: the media key takes
       * the client a moment, and it keeps publishing snapshots until it acts, so a card that drew
       * every snapshot verbatim flickered back to the old state before flipping again.
       */
      const playback = message.snapshot.playback ?? {};
      const status = displayedStatus(playback.status ?? 'unknown');
      const mode = displayedMode(playback.mode ?? null);
      const effective =
        status === playback.status && mode === playback.mode
          ? message.snapshot
          : { ...message.snapshot, playback: { ...playback, status, mode } };
      const trackChanged = view.setSnapshot(effective);
      /*
       * Every new track carries a new cover URL, and `setSnapshot` draws it. If the user's own cover is
       * on, put it back - otherwise the card would quietly revert to the song's art on the next song,
       * which is exactly the bug this one line prevents.
       */
      if (trackChanged || customCover.enabled) applyCoverChoice();
      clock.onPlayback(effective.playback ?? {}, message.snapshot.song?.durationMs ?? 0);

      /*
       * A seek that has arrived at its target is done: drop the preview so the bar follows the
       * client again. Checked here rather than only on snapshots because the playhead arrives ~30
       * times a second and a snapshot only when something changes - waiting for one would leave the
       * bar frozen at the dragged position for as long as the track stayed otherwise unchanged.
       */
      if (scrub) {
        const playheadMs = message.snapshot.playhead?.positionMs ?? null;
        if (playheadMs != null && Math.abs(playheadMs - scrub.ms) < 1500) releaseScrub();
      }
      /*
       * Hold a volume the user just chose until the client's own value catches up.
       *
       * `setVolume` reaches the native player, which reports back through the client's own
       * subscription a moment later - and until it does, snapshots still carry the *old* volume. A
       * bar that redrew from them would jump back under the pointer, which is the same class of
       * flicker the play/pause button had.
       */
      const heldVolume = volumeHold.resolve(typeof playback.volume === 'number' ? playback.volume : null);
      if (heldVolume != null) view.setVolumePreview(heldVolume);

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
      /*
       * The seek landed. The preview is held until the client's own playhead reaches it, so the bar
       * never jumps back to where the track *was* while the seek is still in flight.
       */
      if (scrub && message.playhead) {
        if (Math.abs(message.playhead.positionMs - scrub.ms) < 1500) releaseScrub();
        // A preview that is never confirmed (host gone, client refused) must not stick forever.
        else if (performance.now() - scrub.at > PLAY_PAUSE_OPTIMISM_MS * 2) releaseScrub();
      }
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

    case 'controlResult':
      handleControlResult(message.result);
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
  const on = (id, handler) => document.getElementById(id)?.addEventListener('click', handler);

  on('flip', () => view.flip());
  // Close hides the window and leaves the app in the tray; the tray's 退出 quits for real.
  // The `window.close()` fallback keeps the button working if the preload ever fails to load.
  on('close', () => {
    const bridge = shell();
    if (bridge?.close) bridge.close();
    else window.close();
  });
  on('lock', () => toggleLock());
  on('mini-expand', () => shell()?.setCollapsed?.(false));

  /*
   * The cover button is the one control with two gestures, so it is bound directly rather than
   * through the `on(id, handler)` shorthand above: left clicks pick or toggle, right clicks clear.
   */
  const coverButton = document.getElementById('cover-pick');
  coverButton?.addEventListener('click', onCoverButton);
  coverButton?.addEventListener('contextmenu', onCoverButton);

  for (const button of document.querySelectorAll('.ctrl[data-action]')) {
    button.addEventListener('click', () => {
      const action = button.dataset.action;
      if (action === 'playPause') {
        sendPlayPause();
        return;
      }
      if (action === 'next' || action === 'previous') link.control({ type: action });
      if (action === 'mode') cycleMode();
      if (action === 'mute') link.control({ type: 'toggleMute' });
    });
  }

  installSeekBar();
  installVolumeBar();

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
    } else if (event.key === 'l' || event.key === 'L') {
      toggleLock();
    } else if (event.key === 't' || event.key === 'T') {
      // Toggle lyric translations. Off is often preferred: a translation on every entry
      // makes them uneven heights and crowds the page.
      lyrics.setTranslationVisible(document.documentElement.dataset.lyricTranslation === 'off');
    }
  });

  // Move the window by pressing anywhere that is not a control. See ui/src/drag.js for why this
  // is a gesture rather than a `-webkit-app-region` drag region.
  installDragToMove({ shell });
  // The shell has no frame clock; this side does. See ui/src/resize-clock.js.
  installResizeClock({ shell });

  document.addEventListener('visibilitychange', () => {
    hidden = document.hidden;
  });

  /*
   * Second way out of the rolled-up state.
   *
   * The shell decides when to roll up from the OS pointer position, which is the only source
   * that can see outside the window. If that ever disagreed with reality, the card would be
   * stuck as a strip, so any pointer movement over the strip - an unambiguous "the user is
   * here" that needs no coordinates at all - also counts as a request to expand. The shell
   * treats a repeated request as a no-op, so this cannot fight its own watcher.
   */
  document.addEventListener('mousemove', () => {
    if (view.mode === 'mini') shell()?.setCollapsed?.(false);
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
  /*
   * Lyrics stay in sync even while the front face shows, so flipping is instant - but not
   * while the card is rolled up. In that state the card is `display: none`, so the lyrics
   * container has no height and every tick would ease the stack toward a meaningless target
   * and then visibly drift back on expand.
   */
  if (view.mode === 'expanded') lyrics.tick(clock.positionMs, dt, !hidden);

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

  /*
   * Take the lock state from the shell and keep following it, so the card's button and the
   * tray menu cannot drift apart. The subscription asks for the current state as soon as it is
   * installed, so no separate "ready" handshake is needed.
   */
  view.setLocked(locked);
  shell()?.watchState?.((state) => {
    applyLocked(state?.locked);
    /*
     * The custom cover travels on the same channel. `has`/`enabled` say whether to draw it; `rev` says
     * whether the *bytes* changed, which is the only way to notice a second picture being picked -
     * see `shouldRefetchCover`.
     */
    const cover = state?.cover ?? null;
    const previous = customCover;
    customCover = { has: cover?.has === true, enabled: cover?.enabled === true, url: previous.url, rev: cover?.rev ?? 0 };
    if (shouldRefetchCover(previous, customCover)) void refreshCustomCoverImage();
    else {
      // The image is gone (cleared): drop the copy too, so nothing can draw a stale picture.
      if (!customCover.has && customCover.url) customCover = { ...customCover, url: null };
      applyCoverChoice();
    }
  });
  // Draw the button in its "nothing chosen" state before the shell has answered.
  applyCoverChoice();

  globalThis.__overlay = {
    view,
    clock,
    lyrics,
    link,
    toggleLock,
    get locked() {
      return locked;
    },
    get mode() {
      return view.mode;
    },
    get snapshot() {
      return lastSnapshot;
    },
    /** The custom cover's state, for a console or a test to inspect. */
    get customCover() {
      return { ...customCover, showing: chooseCover({ trackUrl: lastSnapshot?.song?.coverUrl ?? null, custom: customCover }) };
    },
    applyCoverChoice,
  };

  // Tell the page-level watchdog that rendering succeeded, which hides the banner.
  globalThis.__booted = true;
  const bootError = document.getElementById('boot-error');
  if (bootError) bootError.hidden = true;
  console.info(`[overlay] 已启动，宿主 ws://127.0.0.1:${config.port}`);
  // Reported because a failed preload degrades quietly: the close button falls back to
  // window.close(), but the lock toggle has nowhere to go. The shell forwards this to its
  // terminal. The roll-up itself does not depend on the bridge at all.
  console.info(`[overlay] 桌面壳桥接: ${shell() ? '可用' : '不可用（浏览器预览模式或 preload 未加载）'}`);
  // One-shot layout self-check, reported to the shell's terminal. Delayed so the first
  // layout, the cover and the palette are all in place.
  setTimeout(() => view.reportHitTargets(), 500);
}

void boot().catch((error) => {
  // Surface startup failures in the page, not just the console.
  const message = error instanceof Error ? `${error.message}` : String(error);
  if (typeof globalThis.__bootFail === 'function') globalThis.__bootFail(message);
  console.error('[overlay] 启动失败', error);
});
