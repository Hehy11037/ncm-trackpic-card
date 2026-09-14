// Runtime discovery of the client's player/native bridge: find callable surfaces
// that expose playback position or transport control, without hardcoding module
// ids or object names.
//
// Why: the Redux store has no currentTime field and the bundle creates no <audio>
// element -- the audio engine is native (cloudmusic.dll). Progress therefore has
// to come from either (a) an object the native layer exposes to the page, or
// (b) a module that owns the player state.

/** Look for a global object whose property names look like a native/player bridge. */
export function findGlobalBridgeExpression() {
  return `(() => {
    const nameRe = /(player|play|audio|media|native|bridge|orpheus|ncm|ne_|cloudmusic|engine)/i;
    const hits = [];
    for (const key of Object.keys(window)) {
      if (!nameRe.test(key)) continue;
      let value = window[key];
      let kind = typeof value;
      let methods = [];
      let props = [];
      try {
        if (value && (kind === 'object' || kind === 'function')) {
          methods = Object.getOwnPropertyNames(value)
            .filter((n) => { try { return typeof value[n] === 'function'; } catch (_) { return false; } })
            .slice(0, 25);
          props = Object.keys(value).slice(0, 15);
        }
      } catch (_) {}
      hits.push({ key, kind, methods, props });
      if (hits.length >= 60) break;
    }
    return { ok: true, hits };
  })()`;
}

/**
 * Search webpack modules for objects exposing progress-ish or transport-ish
 * methods. This is the runtime analogue of grepping the bundle, and it survives
 * module-id changes.
 */
export function findPlayerModuleExpression() {
  return `(() => {
    const require = window.__moRequire;
    if (typeof require !== 'function') return { ok: false, reason: 'no require' };
    const cache = require.c || {};

    const progressRe = /^(get)?(current|played)?(time|position|progress|seek|elapsed)/i;
    const controlRe = /(play|pause|next|prev|toggle|switch|volume|mute|seek|rate|speed)/i;

    const timerHits = [];
    const controlHits = [];

    for (const id of Object.keys(cache)) {
      let mod;
      try { mod = require(id); } catch (_) { continue; }
      if (!mod) continue;

      // Unwrap common export shapes.
      const buckets = [['self', mod]];
      try { if (mod.default) buckets.push(['default', mod.default]); } catch (_) {}
      try { if (mod.a) buckets.push(['a', mod.a]); } catch (_) {}

      for (const [bucketName, obj] of buckets) {
        if (!obj || (typeof obj !== 'object' && typeof obj !== 'function')) continue;
        let names;
        try { names = Object.getOwnPropertyNames(obj); } catch (_) { continue; }

        const progressFns = [];
        const controlFns = [];
        for (const n of names) {
          let isFn = false;
          try { isFn = typeof obj[n] === 'function'; } catch (_) {}
          if (!isFn) continue;
          if (progressRe.test(n)) progressFns.push(n);
          else if (controlRe.test(n)) controlFns.push(n);
        }

        if (progressFns.length) {
          let sample = null;
          for (const fn of progressFns) {
            try {
              const v = obj[fn]();
              if (typeof v === 'number' || (v && typeof v === 'object')) {
                sample = { fn, type: typeof v, value: typeof v === 'number' ? v : Object.keys(v).slice(0, 10) };
                break;
              }
            } catch (_) {}
          }
          timerHits.push({ moduleId: id, bucket: bucketName, fns: progressFns.slice(0, 10), sample });
          if (timerHits.length >= 15) break;
        }
        if (controlFns.length >= 3) {
          controlHits.push({ moduleId: id, bucket: bucketName, fns: controlFns.slice(0, 14) });
          if (controlHits.length >= 15) break;
        }
      }
      if (timerHits.length >= 15 && controlHits.length >= 15) break;
    }

    return { ok: true, timerHits, controlHits };
  })()`;
}

/** All debug targets, in case progress lives in a worker or a separate page. */
export function listAllTargetsExpression() {
  return `(() => ({
    href: location.href,
    title: document.title,
    frames: Array.from(document.querySelectorAll('iframe')).map((f) => f.src).slice(0, 10),
    hasWorker: typeof Worker !== 'undefined',
  }))()`;
}
