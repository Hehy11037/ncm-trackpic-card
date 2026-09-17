/**
 * The script injected into the NetEase client page.
 *
 * Design constraints, all learned from the running client:
 *
 *  - **No `Runtime.addBinding`.** Outbound events are emitted as
 *    `console.debug("__MO__" + JSON)` and picked up by the host from
 *    `Runtime.consoleAPICalled`. That needs only `Runtime.enable`, and it has the
 *    pleasant side effect of making the data visible in the client's own DevTools.
 *  - **No polling of playback state inside the page.** The client publishes the
 *    playhead on `audioPlayerPlayProgress$` at ~30 Hz; we subscribe once and
 *    forward. Only the command queue is polled (50 ms, negligible).
 *  - **Idempotent.** Reinjecting after a page navigation is safe.
 *  - Module ids and the store handle are passed in by the host, which discovers
 *    them at runtime (see discovery.ts). Nothing about the client's internals is
 *    hardcoded here.
 */

export const BRIDGE_PREFIX = '__MO__';
export interface BridgeScriptOptions {
  /** Module id of the audio pipeline (exports `audioPlayerPlayProgress$`). */
  audioModuleId: string;
  /** How often to drain the command queue, in milliseconds. */
  commandPollMs?: number;
}

/** Stable short hash of the script body, used as the bridge's identity. */
export function hashScript(source: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < source.length; i++) {
    hash ^= source.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/** Build the bridge source. Pure string assembly; do not add template holes below. */
export function buildBridgeScript(options: BridgeScriptOptions): string {
  const audioModuleId = JSON.stringify(String(options.audioModuleId));
  const pollMs = Number.isFinite(options.commandPollMs) ? Number(options.commandPollMs) : 50;
  const prefix = JSON.stringify(BRIDGE_PREFIX);
  /** Placeholder replaced with the real id once the body is assembled. */
  const ID_PLACEHOLDER = '__MO_BRIDGE_ID__';

  const body = `(() => {
  const PREFIX = ${prefix};
  const AUDIO_MODULE_ID = ${audioModuleId};
  const POLL_MS = ${pollMs};
  const BRIDGE_ID = ${JSON.stringify(ID_PLACEHOLDER)};

  /*
   * Replace a bridge that is already installed, and only skip if it is *this* build.
   *
   * The guard used to be a hand-written version number, and it was not bumped when the command
   * switch gained a case - so a client page that still had the previous injection kept answering
   * from the old code, and every play/pause press came back "unsupported command" from a bridge
   * that the host believed it had just replaced. A hand-maintained version is a promise to
   * remember; a hash of the script is the fact.
   *
   * The old bridge is disposed rather than abandoned, or its subscriptions and its command timer
   * would keep running alongside the new one.
   */
  if (window.__moBridge && window.__moBridge.id !== BRIDGE_ID && !window.__moBridge.disposed) {
    try { window.__moBridge.dispose(); } catch (_) {}
  }
  if (window.__moBridge && window.__moBridge.id === BRIDGE_ID && !window.__moBridge.disposed) {
    return { ok: true, already: true, id: BRIDGE_ID };
  }

  const require = window.__moRequire;
  if (typeof require !== 'function') {
    return { ok: false, reason: 'window.__moRequire missing; host must bootstrap webpack first' };
  }
  const dva = window.__moDva;
  if (!dva) {
    return { ok: false, reason: 'window.__moDva missing; host must run module discovery first' };
  }
  const app = dva.app || dva._app || null;
  const store = (app && app._store) || window.__moStore || null;
  if (!store || typeof store.getState !== 'function') {
    return { ok: false, reason: 'dva store not reachable' };
  }

  const audio = require(AUDIO_MODULE_ID);
  if (!audio || typeof audio.audioPlayerPlayProgress$ !== 'object') {
    return { ok: false, reason: 'audio pipeline module ' + AUDIO_MODULE_ID + ' unusable' };
  }

  /*
   * The native player wrapper, found by shape rather than by module id.
   *
   * Volume and position are not dva actions: the client's own volume slider and progress bar call
   * this object directly and dispatch nothing (measured by wrapping 'store.dispatch' and dragging
   * both - zero actions, and the volume/position still changed). Its methods live on a prototype,
   * so it cannot be found by enumerating module exports; what identifies it is the pair of methods
   * the client calls on it.
   */
  const findAudioPlayer = () => {
    for (const id of Object.keys(require.c || {})) {
      let mod;
      try { mod = require(id); } catch (_) { continue; }
      if (!mod || typeof mod !== 'object') continue;
      const candidate = mod.AudioPlayer;
      if (candidate && typeof candidate.setVolume === 'function' && typeof candidate.seek === 'function') {
        return candidate;
      }
    }
    return null;
  };
  const player = findAudioPlayer();

  const send = (kind, payload) => {
    try {
      console.debug(PREFIX + JSON.stringify({ kind, payload, t: Date.now() }));
    } catch (_) {}
  };

  const num = (v) => (typeof v === 'number' && isFinite(v) ? v : null);
  const str = (v) => (typeof v === 'string' ? v : null);
  const toId = (v) => {
    if (typeof v === 'number' && isFinite(v)) return v;
    if (typeof v === 'string' && v) { const n = Number(v); return isFinite(n) ? n : null; }
    return null;
  };

  const arr = (v) => (Array.isArray(v) ? v : []);

  /*
   * Milliseconds to the whole seconds the native player's seek takes.
   *
   * The client's own progress bar sent 'value: 109' for 109 seconds. Rounding rather than flooring
   * matters at the end of a track: flooring a 0.6s remainder lands short of the point the user
   * released the pointer at. The shared 'msToSeekSeconds' states the same rule for the UI's
   * display, and a check evaluates this very line to prove the two still agree.
   */
  const seekSeconds = (ms) => Math.max(0, Math.round(ms / 1000));

  /** Build the lyric payload for a song (or null when it cannot be read). */
  const buildLyricPayload = (songId) => {
    if (songId == null) return null;
    let slice;
    try {
      slice = store.getState()['async:lyric'] || {};
    } catch (_) {
      return null;
    }
    const pick = (list) => arr(list).map((e) => ({
      time: e && typeof e.time === 'number' ? e.time : null,
      lyric: e && typeof e.lyric === 'string' ? e.lyric : null,
    }));
    return {
      songId,
      currentUsedLyric: str(slice.currentUsedLyric),
      currentUsedLyricVersion: num(slice.currentUsedLyricVersion),
      isLoading: !!slice.isLoading,
      isLyricFetchFailed: !!slice.isLyricFetchFailed,
      offset: num(slice.offset),
      lyricLines: pick(slice.lyricLines),
      tlyricLines: pick(slice.tlyricLines),
      romaLyricLines: pick(slice.romaLyricLines),
      at: Date.now(),
    };
  };

  /** If the client has not loaded lyrics for this song yet, prod it to. */
  const requestLyrics = (songId) => {
    try {
      const slice = store.getState()['async:lyric'] || {};
      const hasLines = arr(slice.lyricLines).length > 0;
      if (!hasLines && !slice.isLoading) {
        store.dispatch({ type: 'async:lyric/fetchLyric', payload: { force: true } });
      }
    } catch (_) {}
  };

  /** Read the parts of the store the overlay cares about. Raw units preserved. */
  const readState = () => {
    let state;
    try { state = store.getState(); } catch (_) { return null; }
    const playing = state.playing || {};
    const list = state.playingList || {};
    const cur = playing.curPlaying || null;
    const track = (cur && cur.track) || playing.curTrack || null;
    const album = (track && track.album) || {};
    const artistsRaw = (track && track.artists) || playing.resourceArtists || [];
    const queue = Array.isArray(list.curPlayingList) ? list.curPlayingList : [];
    const songId = toId(playing.resourceTrackId) || (cur ? toId(cur.resourceId) : null);
    const chorusMap = (list && list.curPlayingListChorusMap) || null;

    let artists = [];
    try {
      artists = (Array.isArray(artistsRaw) ? artistsRaw : []).map((a) => ({
        id: a && a.id != null ? toId(a.id) : null,
        name: (a && (a.name || a.nm)) || '',
      })).filter((a) => !!a.name);
    } catch (_) { artists = []; }

    let durationMs = null;
    if (track && num(track.duration) != null) durationMs = num(track.duration);
    else if (num(playing.resourceDuration) != null) durationMs = Math.round(playing.resourceDuration * 1000);

    let chorus = null;
    if (chorusMap && songId != null) {
      const entry = chorusMap[songId] || chorusMap[String(songId)];
      if (entry && num(entry.startTime) != null && num(entry.endTime) != null) {
        chorus = { startMs: entry.startTime, endMs: entry.endTime };
      }
    }

    let index = null;
    if (songId != null) {
      const at = queue.findIndex((x) => x && toId(x.resourceId) === songId);
      if (at >= 0) index = at;
    }

    return {
      raw: {
        resourceTrackId: str(playing.resourceTrackId),
        playingState: num(playing.playingState),
        playingMode: str(playing.playingMode),
        playingVolume: num(playing.playingVolume),
        playingSpeed: num(playing.playingSpeed),
        muteVolume: num(playing.muteVolume),
        volumeDelta: num(playing.volumeDelta),
        resourceDuration: num(playing.resourceDuration),
        resourceName: str(playing.resourceName),
        resourceCoverUrl: str(playing.resourceCoverUrl),
        lyricLineNumber: num(playing.playingLyricLineNumber),
      },
      songId,
      song: {
        id: songId,
        name: (track && (track.name || track.title)) || str(playing.resourceName) || '',
        artists,
        albumName: (album && album.name) || null,
        coverUrl: (album && (album.picUrl || album.picUrlPre)) || str(playing.resourceCoverUrl) || null,
        durationMs,
        resourceType: str(playing.resourceType) || (cur ? str(cur.resourceType) : null),
      },
      chorus,
      queue: {
        length: queue.length,
        ids: queue.slice(0, 200).map((x) => (x ? toId(x.resourceId) : null)).filter((v) => v != null),
        index,
      },
    };
  };

  let lastSignature = null;
  let lastLyricSignature = null;
  let lastLyricSongId = null;
  let lastStatePayload = null;
  let lastLyricPayload = null;
  let lastClientSongId = null;
  const emitState = () => {
    const snap = readState();
    if (!snap) return;
    lastStatePayload = snap;
    const sig = [
      snap.songId,
      snap.raw.playingState,
      snap.raw.playingMode,
      snap.raw.playingVolume,
      snap.raw.muteVolume,
      snap.song.name,
      snap.song.coverUrl,
      snap.queue.length,
      snap.chorus ? snap.chorus.startMs + '-' + snap.chorus.endMs : '',
    ].join('|');
    if (sig !== lastSignature) {
      lastSignature = sig;
      send('state', snap);
    }

    // Lyrics are worth re-sending when the song changes or the client swaps the
    // lyric version (it refreshes them asynchronously after a track change).
    let slice = null;
    try { slice = store.getState()['async:lyric'] || {}; } catch (_) {}
    if (slice) {
      lastClientSongId = snap.songId;
      const lsig = [
        slice.currentUsedLyric,
        slice.currentUsedLyricVersion,
        Array.isArray(slice.lyricLines) ? slice.lyricLines.length : 0,
        slice.isLoading ? 1 : 0,
        slice.offset,
      ].join('|');
      if (snap.songId !== lastLyricSongId) {
        lastLyricSongId = snap.songId;
        lastLyricSignature = null;
        if (snap.songId != null) requestLyrics(snap.songId);
      }
      if (lsig !== lastLyricSignature) {
        lastLyricSignature = lsig;
        lastLyricPayload = buildLyricPayload(snap.songId);
        if (lastLyricPayload) send('lyrics', lastLyricPayload);
      }
    }
  };

  /**
   * Re-send the current state. Called by the host right after injection and
   * whenever an overlay client connects, because otherwise a UI that attaches
   * after the last change would sit there empty until something moves.
   */
  const resend = () => {
    const snap = lastStatePayload || readState();
    if (snap) {
      lastStatePayload = snap;
      send('state', snap);
    }
    const songId = snap ? snap.songId : lastClientSongId;
    const payload = lastLyricPayload || buildLyricPayload(songId);
    if (payload) {
      lastLyricPayload = payload;
      send('lyrics', payload);
    }
    return true;
  };

  const subs = [];
  let progressCount = 0;
  /*
   * The current playback id, kept from the progress stream.
   *
   * 'audioplayer.seek' is addressed by it: the client's own progress bar sent
   * '{playId: "2102424489_UOH3CY", seekId: "2102424489|seek|46YB26", value: 109}', and the seek is
   * matched to its reply by 'seekId'. Without a playId there is nothing to seek within, so seek
   * reports that rather than sending a call that cannot work.
   */
  let lastPlayId = null;
  let lastPositionMs = 0;
  /**
   * A seek asked for while the client was paused, in seconds, waiting for playback to resume.
   *
   * The client does the same thing with its own progress bar: while paused it records where the bar
   * was dragged to and starts from there. See the 'seek' command for the measurement.
   */
  let pendingSeekSeconds = null;

  /** Apply a deferred seek, now that the client says it is playing. */
  const applyPendingSeek = () => {
    if (pendingSeekSeconds == null) return;
    if (playingState() !== 2) return;
    if (!player || typeof player.seek !== 'function' || !lastPlayId) return;
    const seconds = pendingSeekSeconds;
    pendingSeekSeconds = null;
    try {
      const songId = String(lastPlayId).split('_')[0];
      player.seek({
        playId: lastPlayId,
        seekId: songId + '|seek|' + Math.random().toString(36).slice(2, 8).toUpperCase(),
        value: seconds,
      });
      send('warn', { where: 'deferred seek', message: '恢复播放，执行暂停时记下的 ' + seconds + 's' });
    } catch (err) {
      send('warn', { where: 'deferred seek', message: String((err && err.message) || err) });
    }
  };

  try {
    const progress = audio.audioPlayerPlayProgress$;
    if (progress && typeof progress.subscribe === 'function') {
      subs.push(progress.subscribe((value) => {
        if (!Array.isArray(value) || value.length < 2) return;
        const playId = typeof value[0] === 'string' ? value[0] : null;
        const seconds = typeof value[1] === 'number' ? value[1] : null;
        if (seconds == null) return;
        if (playId) lastPlayId = playId;
        lastPositionMs = Math.round(seconds * 1000);
        progressCount++;
        send('progress', {
          playId,
          positionMs: Math.round(seconds * 1000),
          rawState: typeof value[2] === 'number' ? value[2] : null,
          count: progressCount,
        });
      }));
    }
  } catch (err) {
    send('warn', { where: 'progress subscribe', message: String((err && err.message) || err) });
  }

  try {
    subs.push(store.subscribe(() => {
      applyPendingSeek();
      emitState();
    }));
  } catch (err) {
    send('warn', { where: 'store subscribe', message: String((err && err.message) || err) });
  }

  // Command queue: the host pushes {id, command} and the bridge executes it using
  // the client's own control surfaces.
  window.__moCmdQ = window.__moCmdQ || [];
  window.__moCmdResults = window.__moCmdResults || [];

  const dispatch = (action) => store.dispatch(action);

  /** The client's own play state: 1 = paused, 2 = playing (measured). */
  const playingState = () => {
    const st = store.getState().playing || {};
    return typeof st.playingState === 'number' ? st.playingState : null;
  };

  const transport = (want) => {
    const fn = want === 'pause' ? audio.setAudioPlayerPause : audio.setAudioPlayerPlay;
    if (typeof fn !== 'function') {
      const available = Object.keys(audio).filter((k) => /play|pause/i.test(k)).join(', ');
      throw new Error(
        '音频模块没有 setAudioPlayer' + (want === 'pause' ? 'Pause' : 'Play') + '（可用: ' + available + '）',
      );
    }
    // Called on the module rather than bare: the function needs the module as its receiver.
    fn.call(audio, null, null);
    return want;
  };

  const execute = (command) => {
    const t = command && command.type;
    switch (t) {
      case 'playPause': {
        /*
         * The UI only ever sends this one, and it used to fall straight through to the default
         * case and throw - so the largest control on the card, and the space bar, did nothing at
         * all. The deck is a toggle, so the state to flip away from is read here rather than
         * guessed by the caller.
         */
        const state = playingState();
        if (state === null) throw new Error('读不到 playingState，无法判断该播放还是暂停');
        const want = state === 2 ? 'pause' : 'play';
        transport(want);
        return 'pipeline:setAudioPlayer' + (want === 'pause' ? 'Pause' : 'Play') + ':from' + state;
      }
      case 'play':
        transport('play');
        return 'pipeline:setAudioPlayerPlay';
      case 'pause':
        transport('pause');
        return 'pipeline:setAudioPlayerPause';
      case 'stop':
        audio.setAudioPlayerStop(null);
        return 'pipeline:setAudioPlayerStop';
      case 'next':
      case 'previous': {
        const st = store.getState().playing || {};
        const cur = st.curPlaying || null;
        const payload = { triggerScene: 'unknown', curPlaying: cur, type: (t === 'next' ? 'next' : 'prev') };
        dispatch({ type: 'playing/playNextOrPrev', payload });
        return 'dispatch:playing/playNextOrPrev';
      }
      case 'setVolume': {
        const v = typeof command.volume === 'number' ? Math.max(0, Math.min(1, command.volume)) : null;
        if (v == null) throw new Error('setVolume requires a numeric volume');
        /*
         * The wrapper, not a dva action.
         *
         * 'playing/setVolume' exists and *looks* right - it is a real action, it runs, and
         * 'playing.playingVolume' even changes - but the native volume does not move: measured by
         * dispatching it and reading 'AudioPlayer.getApplicationVolume()' back, which stayed at
         * 0.5 while the store went to 0.35. The client's own slider dispatches nothing at all, and
         * this call is what it does instead. The store follows on its own, through the client's
         * native-to-store volume subscription.
         */
        if (!player || typeof player.setVolume !== 'function') {
          throw new Error('找不到客户端的 AudioPlayer.setVolume');
        }
        /*
         * No mute bookkeeping here. A non-zero volume *is* the unmute, and the mini-player's mute
         * flag is a mirror the client maintains itself from the volume (its own code sets it
         * whenever playingVolume changes). Poking it as well would be a second writer for a value
         * the client already owns.
         */
        return Promise.resolve(player.setVolume(v)).then(() => 'pipeline:AudioPlayer.setVolume(' + v + ')');
      }
      case 'toggleMute': {
        /*
         * The client's own toggle: mute means volume 0 with the previous volume remembered, unmute
         * means put that remembered volume back. Both halves go through 'setVolume', so the state
         * the card shows and the sound the user hears cannot disagree.
         */
        if (!player || typeof player.setVolume !== 'function') {
          throw new Error('找不到客户端的 AudioPlayer.setVolume');
        }
        const playing = store.getState().playing || {};
        const volume = num(playing.playingVolume) || 0;
        const remembered = num(playing.muteVolume) || 0;
        const muted = volume === 0;
        const next = muted ? (remembered > 0 ? remembered : 0.1) : 0;
        return Promise.resolve(player.setVolume(next)).then(
          () => 'pipeline:AudioPlayer.setVolume(' + next + ')' + (muted ? ' 取消静音' : ' 静音'),
        );
      }
      case 'setMode': {
        const mode = typeof command.mode === 'string' ? command.mode : null;
        if (!mode) throw new Error('setMode requires a mode');
        /*
         * The client's own action, not a hand-rolled store write.
         *
         * This used to dispatch 'playing/onUpdate {playingMode, lastPlayingMode}' - the last line of
         * the client's own mode effect, which was as far as the bundle could be read at the time. It
         * worked as far as the *state* went: the mode changed, and the client's own icon followed it.
         *
         * What it skipped is the rest of that effect, and the difference is observable. Switching to
         * 随机播放 through the effect re-draws every queue entry's 'randomOrder' - that is the shuffle
         * - and through 'onUpdate' it does not, so "shuffle" would replay the previous random order
         * instead of shuffling. Measured by dispatching both and reading the queue
         * (.scratch/try-mode-actions.mjs): the randomOrder values all changed under
         * 'switchPlayingMode' and were untouched under 'onUpdate'.
         *
         * 'triggerScene' is the value the client's own code passes when the *app* changes the mode
         * rather than a click inside its own window (module 10's scene enum, 'sysTray'), which is
         * exactly this situation.
         */
        dispatch({
          type: 'playing/switchPlayingMode',
          payload: { playingMode: mode, triggerScene: 'sysTray', HeartBeatFlage: false },
        });
        return 'dispatch:playing/switchPlayingMode(' + mode + ')';
      }
      case 'seek': {
        const ms = num(command.positionMs);
        if (ms == null) throw new Error('seek requires positionMs');
        if (!player || typeof player.seek !== 'function') {
          throw new Error('找不到客户端的 AudioPlayer.seek');
        }
        if (!lastPlayId) {
          throw new Error('还没有拿到 playId（进度流尚未推送），无法跳转');
        }
        /*
         * Whole seconds, and a fresh 'seekId' per call.
         *
         * The shape is the client's own, recorded from its progress bar:
         * '{playId, seekId: "<songId>|seek|<random>", value: <seconds>}', answered with
         * '{playId, seekId, code, position}'. The reply is a receipt worth reporting: 'code === 0'
         * with the position the player moved to.
         */
        const songId = String(lastPlayId).split('_')[0];
        const seekId = songId + '|seek|' + Math.random().toString(36).slice(2, 8).toUpperCase();
        const seconds = seekSeconds(ms);

        /*
         * While the client is paused, the position is *remembered* rather than seeked.
         *
         * Measured, and the measurement is the reason: with the client paused, dragging its own
         * progress bar calls neither AudioPlayer.seek nor the module's seekAudioPlayer - nothing
         * at all - and yet playback resumes from the place the bar was dragged to. The native
         * player is idle, ignores a seek, and never answers it (which is also why the host saw "no
         * receipt" and the progress stream went silent). So the client defers, and so does this:
         * the target is applied the moment the client reports it is playing again.
         */
        if (playingState() !== 2) {
          pendingSeekSeconds = seconds;
          return {
            via: 'pipeline',
            message: '客户端暂停中，已记下 ' + seconds + 's，恢复播放时执行',
            positionMs: seconds * 1000,
            deferred: true,
          };
        }
        return Promise.resolve(player.seek({ playId: lastPlayId, seekId, value: seconds })).then((reply) => {
          const code = reply && typeof reply.code === 'number' ? reply.code : null;
          const position = reply && typeof reply.position === 'number' ? reply.position : null;
          if (code !== null && code !== 0) {
            throw new Error('客户端拒绝了跳转（code ' + code + '）');
          }
          return {
            via: 'pipeline',
            message: 'AudioPlayer.seek(' + seekId + ') -> ' + seconds + 's' +
              (position != null ? '，客户端报告 ' + position + 's' : ''),
            positionMs: position != null ? Math.round(position * 1000) : null,
          };
        });
      }
      case 'diagnoseTransport': {
        /*
         * Why did a transport command not move the client?
         *
         * "The call ran and nothing happened" is not something that can be reasoned about from
         * outside, so the page is asked directly: the play/pause exports and their arity (a
         * mismatch there is the likeliest reason a null-argument call is a no-op), every dva action
         * whose name mentions playing, and the client's own transport buttons - which are the one
         * control path already known to work.
         */
        const parts = [];

        try {
          const fns = Object.keys(audio)
            .filter((k) => /play|pause|stop/i.test(k))
            .map((k) => k + '/' + (typeof audio[k] === 'function' ? audio[k].length : typeof audio[k]));
          parts.push('exports[' + fns.join(' ') + ']');
        } catch (err) {
          parts.push('exports[读取失败: ' + String(err && err.message || err) + ']');
        }

        try {
          const dva = store.getState()['@@dva'] || {};
          const names = [];
          for (const model of Object.keys(dva)) {
            const def = dva[model] || {};
            for (const bucket of ['reducers', 'effects']) {
              const group = def[bucket] || {};
              for (const name of Object.keys(group)) {
                if (/play|pause/i.test(model + '/' + name)) names.push(model + '/' + name);
              }
            }
          }
          parts.push('actions[' + names.slice(0, 14).join(' ') + ']');
        } catch (err) {
          parts.push('actions[读取失败: ' + String(err && err.message || err) + ']');
        }

        try {
          const selector = '[aria-label*="播放"], [aria-label*="暂停"], [title*="播放"], [title*="暂停"], [class*="play" i], [class*="pause" i]';
          const found = document.querySelectorAll(selector);
          const seen = [];
          for (let i = 0; i < found.length && seen.length < 8; i++) {
            const el = found[i];
            const cls = String(el.className || '').split(/\s+/).filter(Boolean).slice(0, 2).join('.');
            const label = el.getAttribute('aria-label') || el.getAttribute('title') || '';
            const text = el.tagName.toLowerCase() + (cls ? '.' + cls : '') + (label ? '[' + label + ']' : '');
            if (seen.indexOf(text) < 0) seen.push(text);
          }
          parts.push('dom[' + seen.join(' ') + ']');
        } catch (err) {
          parts.push('dom[读取失败: ' + String(err && err.message || err) + ']');
        }

        return 'diagnose:' + parts.join(' ');
      }
      default:
        throw new Error('unsupported command: ' + String(t));
    }
  };

  /*
   * Commands are settled asynchronously.
   *
   * 'seek' and 'setVolume' go through the client's audio wrapper, whose methods return promises
   * resolved by the native player's reply. Reporting 'ok' before that reply arrives would be
   * exactly the "the command ran, so it worked" mistake the confirmation rule exists to prevent -
   * and worse here, because a seek reports *where* the player ended up.
   */
  const settle = (item, outcome) => {
    let result;
    if (outcome && outcome.ok === false) {
      result = { id: item.id, ok: false, via: outcome.via || 'none', message: outcome.message };
    } else if (outcome && typeof outcome === 'object' && 'via' in outcome) {
      result = {
        id: item.id,
        ok: true,
        via: outcome.via,
        message: outcome.message,
        positionMs: outcome.positionMs,
        deferred: outcome.deferred === true,
      };
    } else {
      result = { id: item.id, ok: true, via: outcome };
    }
    if (window.__moCmdResults.length < 100) window.__moCmdResults.push(result);
    send('commandResult', result);
  };

  const timer = setInterval(() => {
    const queue = window.__moCmdQ;
    if (!Array.isArray(queue) || !queue.length) return;
    const pending = queue.splice(0, queue.length);
    for (const item of pending) {
      let outcome;
      try {
        outcome = execute(item.command);
      } catch (err) {
        settle(item, { ok: false, via: 'none', message: String((err && err.message) || err) });
        continue;
      }
      if (outcome && typeof outcome.then === 'function') {
        outcome.then(
          (value) => settle(item, value),
          (err) => settle(item, { ok: false, via: 'pipeline', message: String((err && err.message) || err) }),
        );
      } else {
        settle(item, outcome);
      }
    }
  }, POLL_MS);

  window.__moBridge = {
    id: BRIDGE_ID,
    audioModuleId: AUDIO_MODULE_ID,
    /** Force a state + lyric re-send; used by the host when a UI attaches. */
    resend,
    dispose() {
      try { clearInterval(timer); } catch (_) {}
      for (const s of subs) { try { s.unsubscribe(); } catch (_) {} }
      window.__moBridge.disposed = true;
    },
  };

  emitState();
  send('ready', { audioModuleId: AUDIO_MODULE_ID, progressCount, store: true, bridgeId: BRIDGE_ID });
  return { ok: true, id: BRIDGE_ID, audioModuleId: AUDIO_MODULE_ID };
})()`;

  /*
   * The identity is a hash of the assembled body, with the placeholder left in place while
   * hashing. Every edit therefore produces a new id, and a page still running an older injection
   * replaces it on the next attach - which is what the hand-written version failed to do.
   */
  return body.replaceAll(ID_PLACEHOLDER, hashScript(body));
}

/** Page-side helper the host calls after pushing a command. */
export function commandResultPollExpression(): string {
  return `(() => {
    const r = window.__moCmdResults || [];
    window.__moCmdResults = [];
    return r;
  })()`;
}

/** Pageside helper that reports whether the bridge is alive, and which build it is. */
export function bridgeHealthExpression(): string {
  return `(() => {
    const b = window.__moBridge;
    return b
      ? { alive: !b.disposed, id: b.id, audioModuleId: b.audioModuleId }
      : { alive: false };
  })()`;
}

/**
 * Ask the bridge to re-send its current state and lyrics.
 *
 * Needed because the bridge deduplicates: if playback has not changed since it was
 * injected, a UI that attaches afterwards would otherwise receive nothing.
 */
export function bridgeResendExpression(): string {
  return `(() => {
    const b = window.__moBridge;
    if (!b || !b.resend) return false;
    return !!b.resend();
  })()`;
}
