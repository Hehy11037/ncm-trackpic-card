// Deeper page-side probes: find where playback progress lives, and locate
// ready-to-call player control methods at runtime (rather than guessing action
// type strings that vary between client builds).

/**
 * Walk the whole Redux state tree and report every numeric field whose name
 * looks progress-related, plus the structural shape of the playing slice.
 * This is how we answer "where is currentTime?" empirically.
 */
export function findProgressExpression() {
  return `(() => {
    const store = window.__moStore;
    if (!store) return { ok: false, reason: 'no store' };
    let state;
    try { state = store.getState(); } catch (err) {
      return { ok: false, reason: String((err && err.message) || err) };
    }

    const nameRe = /(time|progress|position|seek|elapsed|played|current|duration|offset)/i;
    const found = [];
    const seen = new Set();

    const walk = (node, path, depth) => {
      if (!node || depth > 5) return;
      if (typeof node !== 'object') return;
      if (seen.has(node)) return;
      seen.add(node);
      for (const key of Object.keys(node)) {
        const value = node[key];
        const p = path ? path + '.' + key : key;
        if (typeof value === 'number' && nameRe.test(key)) {
          found.push({ path: p, value });
        } else if (typeof value === 'string' && nameRe.test(key) && value.length <= 40) {
          found.push({ path: p, value });
        } else if (value && typeof value === 'object' && !Array.isArray(value)) {
          walk(value, p, depth + 1);
        } else if (Array.isArray(value) && value.length && nameRe.test(key)) {
          found.push({ path: p, kind: 'array', length: value.length });
        }
      }
    };
    walk(state, '', 0);

    // localStorage is also used by this app for time bookkeeping.
    const lsKeys = [];
    try {
      for (let i = 0; i < localStorage.length && i < 400; i++) {
        const k = localStorage.key(i);
        if (k && /time|progress|play|current/i.test(k)) {
          lsKeys.push({ key: k, value: String(localStorage.getItem(k)).slice(0, 60) });
        }
      }
    } catch (_) {}

    return { ok: true, progressLike: found.slice(0, 60), localStorageHits: lsKeys.slice(0, 20) };
  })()`;
}

/**
 * Enumerate the resolved dva model actions, so control commands can be issued by
 * name (e.g. "playing/togglePlayPause") without hardcoding type strings that
 * differ between builds.
 */
export function listActionsExpression() {
  return `(() => {
    const store = window.__moStore;
    if (!store) return { ok: false, reason: 'no store' };
    let state;
    try { state = store.getState(); } catch (err) { return { ok: false, reason: String(err) }; }
    const dva = state['@@dva'] || {};
    const models = Object.keys(dva);
    const out = {};
    // e.g. "playing/togglePlayPause" -> { playing: [togglePlayPause, ...] }
    for (const key of models) {
      const slash = key.indexOf('/');
      if (slash < 0) continue;
      const ns = key.slice(0, slash);
      const name = key.slice(slash + 1);
      if (!out[ns]) out[ns] = [];
      out[ns].push(name);
    }
    return {
      ok: true,
      modelCount: models.length,
      namespaces: Object.keys(out).sort(),
      playingActions: (out.playing || []).sort(),
      lyricActions: (out['async:lyric'] || []).sort(),
    };
  })()`;
}

/**
 * Locate callable player-control surfaces at runtime: anything reachable that
 * looks like a play/pause/next/previous/volume controller, plus the audio
 * context used for playback (so progress can be derived from it).
 */
export function findControlsExpression() {
  return `(() => {
    const out = { audioContexts: [], mediaSessions: [], candidates: [], streams: [] };

    // WebAudio contexts (the client likely decodes/plays through WebAudio).
    const AC = window.AudioContext || window.webkitAudioContext;
    if (AC) {
      out.audioContexts.push({
        sampleRate: undefined,
        state: undefined,
        note: 'constructor present',
      });
    }
    try {
      if (window.__moAudioCtx) {
        out.audioContexts.push({
          ctx: true,
          state: window.__moAudioCtx.state,
          sampleRate: window.__moAudioCtx.sampleRate,
          currentTime: window.__moAudioCtx.currentTime,
        });
      }
    } catch (_) {}

    // Media Session API: some CEF builds mirror playback position here.
    try {
      const ms = navigator.mediaSession;
      if (ms) {
        let position = null;
        try { position = ms.getPositionState ? 'api-present' : null; } catch (_) {}
        out.mediaSessions.push({
          metadata: ms.metadata ? { title: ms.metadata.title, artist: ms.metadata.artist } : null,
          playbackState: ms.playbackState || null,
          position,
        });
      }
    } catch (_) {}

    // Look for rxjs-like streams on the playing slice (the audio pipeline
    // publishes progress through observables in this build).
    const store = window.__moStore;
    if (store) {
      try {
        const state = store.getState();
        const scan = (obj, path, depth) => {
          if (!obj || depth > 4 || typeof obj !== 'object') return;
          for (const k of Object.keys(obj)) {
            const v = obj[k];
            const p = path + '.' + k;
            if (v && typeof v === 'object' && typeof v.subscribe === 'function') {
              out.streams.push({ path: p, ctor: v.constructor && v.constructor.name });
            } else if (v && typeof v === 'object' && typeof v.getValue === 'function') {
              let value = null;
              try { value = v.getValue(); } catch (_) {}
              out.streams.push({
                path: p,
                kind: 'behaviorSubject',
                value: value && typeof value === 'object' ? Object.keys(value).slice(0, 12) : value,
              });
            } else if (v && typeof v === 'object' && depth < 4 && !Array.isArray(v)) {
              scan(v, p, depth + 1);
            }
          }
        };
        scan(state.playing || {}, 'playing', 0);
      } catch (err) {
        out.error = String((err && err.message) || err);
      }
    }
    return out;
  })()`;
}
