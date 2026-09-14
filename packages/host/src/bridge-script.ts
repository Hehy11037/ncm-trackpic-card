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

/** Build the bridge source. Pure string assembly; do not add template holes below. */
export function buildBridgeScript(options: BridgeScriptOptions): string {
  const audioModuleId = JSON.stringify(String(options.audioModuleId));
  const pollMs = Number.isFinite(options.commandPollMs) ? Number(options.commandPollMs) : 50;
  const prefix = JSON.stringify(BRIDGE_PREFIX);

  return `(() => {
  const PREFIX = ${prefix};
  const AUDIO_MODULE_ID = ${audioModuleId};
  const POLL_MS = ${pollMs};

  if (window.__moBridge && window.__moBridge.version === 2 && !window.__moBridge.disposed) {
    return { ok: true, already: true, version: 2 };
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
  const emitState = () => {
    const snap = readState();
    if (!snap) return;
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
    if (sig === lastSignature) return;
    lastSignature = sig;
    send('state', snap);
  };

  const subs = [];
  let progressCount = 0;

  try {
    const progress = audio.audioPlayerPlayProgress$;
    if (progress && typeof progress.subscribe === 'function') {
      subs.push(progress.subscribe((value) => {
        if (!Array.isArray(value) || value.length < 2) return;
        const playId = typeof value[0] === 'string' ? value[0] : null;
        const seconds = typeof value[1] === 'number' ? value[1] : null;
        if (seconds == null) return;
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
    subs.push(store.subscribe(() => emitState()));
  } catch (err) {
    send('warn', { where: 'store subscribe', message: String((err && err.message) || err) });
  }

  // Command queue: the host pushes {id, command} and the bridge executes it using
  // the client's own control surfaces.
  window.__moCmdQ = window.__moCmdQ || [];
  window.__moCmdResults = window.__moCmdResults || [];

  const dispatch = (action) => store.dispatch(action);

  const execute = (command) => {
    const t = command && command.type;
    switch (t) {
      case 'play':
        audio.setAudioPlayerPlay(null, null);
        return 'pipeline:setAudioPlayerPlay';
      case 'pause':
        audio.setAudioPlayerPause(null, null);
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
        audio.setVolume ? audio.setVolume(v, null) : dispatch({ type: 'playing/setVolume', payload: { volume: v } });
        return 'pipeline:setVolume';
      }
      case 'toggleMute': {
        const st = store.getState();
        const playing = st.playing || {};
        const host = st.host || {};
        const nextMuted = !(playing.muteVolume > 0 || host.muteVolume > 0);
        dispatch({ type: 'host/onUpdate', payload: { muteVolume: nextMuted ? 1 : 0, volumeDelta: 0 } });
        return 'dispatch:host/onUpdate(muteVolume)';
      }
      case 'setMode': {
        dispatch({ type: 'playing/switchPlayingMode', payload: { playingMode: command.mode, triggerScene: 'unknown', HeartBeatFlage: false } });
        return 'dispatch:playing/switchPlayingMode';
      }
      default:
        throw new Error('unsupported command: ' + String(t));
    }
  };

  const timer = setInterval(() => {
    const queue = window.__moCmdQ;
    if (!Array.isArray(queue) || !queue.length) return;
    const pending = queue.splice(0, queue.length);
    for (const item of pending) {
      let result;
      try {
        const via = execute(item.command);
        result = { id: item.id, ok: true, via };
      } catch (err) {
        result = { id: item.id, ok: false, via: 'none', message: String((err && err.message) || err) };
      }
      if (window.__moCmdResults.length < 100) window.__moCmdResults.push(result);
      send('commandResult', result);
    }
  }, POLL_MS);

  window.__moBridge = {
    version: 2,
    audioModuleId: AUDIO_MODULE_ID,
    dispose() {
      try { clearInterval(timer); } catch (_) {}
      for (const s of subs) { try { s.unsubscribe(); } catch (_) {} }
      window.__moBridge.disposed = true;
    },
  };

  emitState();
  send('ready', { audioModuleId: AUDIO_MODULE_ID, progressCount, store: true });
  return { ok: true, version: 2, audioModuleId: AUDIO_MODULE_ID };
})()`;
}

/** Page-side helper the host calls after pushing a command. */
export function commandResultPollExpression(): string {
  return `(() => {
    const r = window.__moCmdResults || [];
    window.__moCmdResults = [];
    return r;
  })()`;
}

/** Pageside helper that reports whether the bridge is alive. */
export function bridgeHealthExpression(): string {
  return `(() => {
    const b = window.__moBridge;
    return b
      ? { alive: !b.disposed, version: b.version, audioModuleId: b.audioModuleId }
      : { alive: false };
  })()`;
}
