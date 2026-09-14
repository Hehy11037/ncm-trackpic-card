// Page-side queries for phase-0 reconnaissance: resolve the real Redux store
// behind the dva-tool handle, capture the audio element, and find the module
// that owns the internal request layer (used to read lyrics from the client,
// which is more robust than re-implementing the public API calls).

/**
 * Find the real dva app/store object behind the tool singleton.
 * Whatever we get from `__moDva`, we walk a few well-known handles and pick the
 * first object that exposes a callable store.getState().
 */
export function resolveStoreExpression() {
  return `(() => {
    const dva = window.__moDva;
    if (!dva) return { ok: false, reason: 'window.__moDva missing' };
    const candidates = [];
    const push = (label, obj) => { if (obj && (typeof obj === 'object' || typeof obj === 'function')) candidates.push([label, obj]); };
    try { push('dva.app', dva.app); } catch (_) {}
    try { push('dva._app', dva._app); } catch (_) {}
    try { push('dva.store', dva.store); } catch (_) {}
    try { const s = dva.getStore(); push('getStore()._store', s && s._store); } catch (_) {}
    try { push('global.__dvaApp', window.__dvaApp); } catch (_) {}
    for (const [label, obj] of candidates) {
      let store = null;
      try { store = obj._store || obj.store || null; } catch (_) {}
      if (store && typeof store.getState === 'function') {
        window.__moStore = store;
        let topKeys = [];
        try { topKeys = Object.keys(store.getState() || {}).sort(); } catch (_) {}
        return { ok: true, via: label, topKeys };
      }
    }
    return { ok: false, reason: 'no dva app/store handle exposed', tried: candidates.map((c) => c[0]) };
  })()`;
}

/** Grab the live <audio> element the player is using, if the bundle created one. */
export function audioProbeExpression() {
  return `(() => {
    const out = { mediaElements: [], audio: null, error: null };
    try {
      const list = Array.from(document.querySelectorAll('audio'));
      out.mediaElements = list.map((el) => ({
        src: (el.src || '').slice(0, 120),
        currentTime: el.currentTime,
        duration: el.duration,
        paused: el.paused,
        readyState: el.readyState,
      }));
      if (list.length) {
        const el = list[0];
        window.__moAudio = el;
        out.audio = {
          currentTime: el.currentTime,
          duration: el.duration,
          paused: el.paused,
          ended: el.ended,
          playbackRate: el.playbackRate,
          volume: el.volume,
          muted: el.muted,
          readyState: el.readyState,
          networkState: el.networkState,
          src: (el.currentSrc || el.src || '').slice(0, 160),
        };
      }
    } catch (err) {
      out.error = String((err && err.message) || err);
    }
    return out;
  })()`;
}

/**
 * Locate the module that owns the client's internal request layer, by looking for
 * a function whose source mentions the lyric endpoint. Returns its module id so
 * the host can call it through a stable indirection instead of guessing.
 */
export function findApiModuleExpression() {
  return `(() => {
    const require = window.__moRequire;
    if (typeof require !== 'function') return { ok: false, reason: 'no require' };
    const cache = require.c || {};
    const key = '/api/song/lyric';
    const hits = [];
    for (const id of Object.keys(cache)) {
      let mod;
      try { mod = require(id); } catch (_) { continue; }
      if (!mod || (typeof mod !== 'object' && typeof mod !== 'function')) continue;
      for (const [name, value] of Object.entries(mod)) {
        if (typeof value !== 'function') continue;
        let src = '';
        try { src = Function.prototype.toString.call(value); } catch (_) { continue; }
        if (src.indexOf(key) >= 0) {
          const names = (src.match(/"\\/api\\/[a-zA-Z0-9_./-]+"/g) || []).slice(0, 8);
          hits.push({ moduleId: id, exportName: name, endpoints: names });
          if (hits.length >= 12) break;
        }
      }
      if (hits.length >= 12) break;
    }
    if (hits.length) {
      window.__moApiModuleId = hits[0].moduleId;
      window.__moApiExportName = hits[0].exportName;
    }
    return { ok: hits.length > 0, hits };
  })()`;
}

/**
 * Deep, bounded serialization of the interesting slices. Values are truncated so
 * the payload stays small enough to read over CDP.
 */
export function playbackDetailExpression() {
  return `(() => {
    const dva = window.__moDva;
    if (!dva) return { ok: false, reason: 'no dva' };

    let state;
    try {
      state = window.__moStore ? window.__moStore.getState() : dva.getStore();
    } catch (err) {
      return { ok: false, reason: 'state unavailable: ' + String((err && err.message) || err) };
    }

    const safe = (value, depth = 0, seen = new Set()) => {
      if (value === null || value === undefined) return value;
      const t = typeof value;
      if (t === 'string') return value.length > 160 ? value.slice(0, 160) + '...(' + value.length + ')' : value;
      if (t === 'number' || t === 'boolean') return value;
      if (t === 'function') return '[fn ' + (value.name || 'anonymous') + ']';
      if (t === 'symbol') return String(value);
      if (depth > 3) return '[depth]';
      if (seen.has(value)) return '[circular]';
      seen.add(value);
      if (Array.isArray(value)) {
        return value.slice(0, 6).map((v) => safe(v, depth + 1, seen));
      }
      const out = {};
      let n = 0;
      for (const k of Object.keys(value)) {
        if (n++ >= 24) { out['...'] = 'truncated'; break; }
        out[k] = safe(value[k], depth + 1, seen);
      }
      return out;
    };

    const playing = state.playing || {};
    const out = {
      ok: true,
      playingState: playing.playingState,
      playingMode: playing.playingMode,
      playingVolume: playing.playingVolume,
      muteVolume: playing.muteVolume,
      playId: playing.playId ?? null,
      playingSpeed: playing.playingSpeed,
      lyric: {
        playingLyric: playing.playingLyric,
        playingLyricLineNumber: playing.playingLyricLineNumber,
      },
      asyncLyricSlice: safe(state['async:lyric']),
      keyPlayingFields: {
        resourceName: playing.resourceName,
        resourceTrackId: playing.resourceTrackId,
        resourceAlbumId: playing.resourceAlbumId,
        resourceDuration: playing.resourceDuration,
        resourceCoverUrl: playing.resourceCoverUrl,
        resourceArtists: safe(playing.resourceArtists),
        resourceType: playing.resourceType,
      },
      curPlayingKeys: playing.curPlaying ? Object.keys(playing.curPlaying).sort() : null,
      curTrackKeys: playing.curTrack ? Object.keys(playing.curTrack).sort() : null,
      audio: window.__moAudio
        ? {
            currentTime: window.__moAudio.currentTime,
            duration: window.__moAudio.duration,
            paused: window.__moAudio.paused,
          }
        : null,
    };
    return out;
  })()`;
}
