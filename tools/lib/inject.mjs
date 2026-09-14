// Page-injection strategies for reading the NetEase Cloud Music client from the
// inside, over the local Chromium debug channel.
//
// Background (measured on the machine's client, version 3.1.39.205426):
//   * The client is CEF-based and ships a webpack bundle inside web.pack.
//   * Every chunk registers itself as
//       (this.webpackJsonp = this.webpackJsonp || []).push([[chunkId], {moduleId: fn, ...})
//   * The app uses dva + Redux, and a "dva-tool" singleton exposes getStore() and
//     getDispatch(). That singleton is our handle on playback state.
//
// We deliberately DO NOT hardcode webpack module ids. The widely used community
// approach does (module ids 987660 and 12), but those ids do not exist in this
// build -- verified by grepping all 231 unpacked bundle files. So we bootstrap a
// synthetic chunk to obtain `require`, then locate the singleton at runtime.

/** Chunk ids we will try for the synthetic bootstrap chunk (first free one wins). */
export const BOOTSTRAP_CHUNK_CANDIDATES = [990001, 990002, 990003, 900001, 900002, 999999];

/**
 * Expression that defines `window.__moRequire`.
 * Returns a small JSON-serializable report (never the function itself, which
 * cannot be marshalled by returnByValue).
 */
export function bootstrapRequireExpression() {
  return `(() => {
    const ids = ${JSON.stringify(BOOTSTRAP_CHUNK_CANDIDATES)};
    const arr =
      (typeof webpackJsonp !== 'undefined' && webpackJsonp) ||
      (typeof window !== 'undefined' && window.webpackJsonp) ||
      null;
    if (!arr || typeof arr.push !== 'function') {
      return { ok: false, reason: 'webpackJsonp not found' };
    }
    const attempts = [];
    for (const id of ids) {
      try {
        const mod = {};
        mod[id] = function (module, exports, require) {
          try { window.__moRequire = require; } catch (_) {}
        };
        arr.push([[id], mod, [[id]]]);
        if (typeof window.__moRequire === 'function') {
          return {
            ok: true,
            chunkId: id,
            moduleCount: window.__moRequire.c ? Object.keys(window.__moRequire.c).length : 0,
            hasPublicPath: typeof window.__moRequire.p === 'string',
            publicPath: typeof window.__moRequire.p === 'string' ? window.__moRequire.p : null,
          };
        }
        attempts.push({ id, reason: 'no require captured' });
      } catch (err) {
        attempts.push({ id, reason: String((err && err.message) || err) });
      }
    }
    return { ok: false, reason: 'all chunk ids rejected', attempts };
  })()`;
}

/**
 * Expression that locates the dva-tool singleton (an object exposing callable
 * getStore/getDispatch) among the already-executed webpack modules and caches it
 * as `window.__moDva`.
 *
 * Candidate narrowing uses the function source as a cheap fingerprint; every
 * probe is wrapped so one hostile module cannot abort the sweep.
 */
export function discoverDvaExpression() {
  return `(() => {
    const require = window.__moRequire;
    if (typeof require !== 'function') {
      return { ok: false, reason: 'window.__moRequire missing; run bootstrap first' };
    }
    const cache = require.c || {};
    const keys = Object.keys(cache);
    const report = { scanned: keys.length, probed: 0, matches: [], errors: [] };

    const looksLikeHandler = (fn) => {
      let src = '';
      try { src = Function.prototype.toString.call(fn); } catch (_) { return false; }
      return src.indexOf('getStore') >= 0 && src.indexOf('getDispatch') >= 0;
    };

    const probe = (id) => {
      let mod;
      try { mod = require(id); } catch (err) {
        report.errors.push({ id, stage: 'require', message: String((err && err.message) || err) });
        return null;
      }
      if (!mod || (typeof mod !== 'object' && typeof mod !== 'function')) return null;
      for (const exp of [mod, mod.default, mod.a]) {
        if (!exp || (typeof exp !== 'object' && typeof exp !== 'function')) continue;
        const isHandler = looksLikeHandler(exp);
        let storeOk = false;
        let dispatchOk = false;
        try { storeOk = typeof exp.getStore === 'function'; } catch (_) {}
        try { dispatchOk = typeof exp.getDispatch === 'function'; } catch (_) {}
        if (storeOk && dispatchOk) return { id, exp, fingerprint: isHandler };
      }
      return null;
    };

    for (const id of keys) {
      report.probed++;
      const hit = probe(id);
      if (!hit) continue;
      let stateKeys = [];
      let storeError = null;
      try {
        const st = hit.exp.getStore();
        stateKeys = st && typeof st === 'object' ? Object.keys(st) : [];
        window.__moDva = hit.exp;
        window.__moDvaId = hit.id;
      } catch (err) {
        storeError = String((err && err.message) || err);
      }
      report.matches.push({
        moduleId: hit.id,
        fingerprint: hit.fingerprint,
        stateKeys,
        storeError,
      });
      if (storeError) delete window.__moDva;
    }

    report.ok = typeof window.__moDva !== 'undefined';
    report.chosen = report.ok ? window.__moDvaId : null;
    report.errors = report.errors.slice(0, 10);
    return report;
  })()`;
}

/**
 * Read a compact, JSON-safe snapshot of playback state.
 * Field names are the ones observed in this build; everything is optional so a
 * client upgrade degrades into nulls instead of throwing.
 */
export function snapshotExpression() {
  return `(() => {
    const dva = window.__moDva;
    if (!dva) return { ok: false, reason: 'window.__moDva missing' };
    let state;
    try { state = dva.getStore(); } catch (err) {
      return { ok: false, reason: 'getStore failed: ' + String((err && err.message) || err) };
    }
    const playing = (state && state.playing) || {};
    const list = (state && state.playingList) || {};
    const cur = playing.curPlaying || null;
    const track = (cur && cur.track) || null;
    const album = (track && track.album) || (track && track.al) || {};
    const artists = (track && track.artists) || (track && track.ar) || [];
    const queue = Array.isArray(list.curPlayingList) ? list.curPlayingList : [];
    return {
      ok: true,
      playingKeys: Object.keys(playing).sort(),
      listKeys: Object.keys(list).sort(),
      resourceId: cur ? Number(cur.resourceId) || null : null,
      resourceType: cur ? cur.resourceType || null : null,
      playId: playing.playId ?? null,
      playingState: playing.playingState ?? null,
      playingMode: playing.playingMode ?? null,
      playingVolume: playing.playingVolume ?? null,
      mute: playing.mute ?? null,
      name: (track && (track.name || track.title)) || null,
      albumName: album.name || null,
      coverUrl: album.picUrl || album.picUrlPre || null,
      durationMs: (track && (track.duration || track.dt)) || null,
      artists: Array.isArray(artists)
        ? artists.map((a) => (a && (a.name || a.nm)) || null).filter(Boolean)
        : [],
      queueLength: queue.length,
      queueIds: queue.slice(0, 8).map((x) => (x ? Number(x.resourceId) || null : null)),
      curTrackKeys: track ? Object.keys(track).sort() : [],
    };
  })()`;
}
