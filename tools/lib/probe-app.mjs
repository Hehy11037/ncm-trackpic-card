// Introspect the dva app object itself: in this build the playback pipeline
// publishes progress through a service/stream hanging off the app instance
// rather than through Redux state.

/** Shallow structure report of the dva app object. */
export function appIntrospectExpression() {
  return `(() => {
    const dva = window.__moDva;
    if (!dva) return { ok: false, reason: 'no dva' };
    const app = dva.app || dva._app || null;
    if (!app) return { ok: false, reason: 'no app handle' };

    const describe = (obj, limit) => {
      let names = [];
      try { names = Object.getOwnPropertyNames(obj); } catch (err) { return { error: String(err) }; }
      const fns = [];
      const vals = [];
      for (const n of names.slice(0, limit)) {
        let t = 'unknown';
        try { t = typeof obj[n]; } catch (_) {}
        if (t === 'function') fns.push(n);
        else vals.push(n + ':' + t);
      }
      return { fns: fns.slice(0, 40), vals: vals.slice(0, 40), total: names.length };
    };

    const out = { ok: true, keys: [], appDesc: describe(app, 120) };

    // Common dva app-ish containers worth poking at.
    for (const key of ['_store', 'store', 'services', '_services', 'app', '_app', 'dva', '_dva']) {
      let v = null;
      try { v = app[key]; } catch (_) {}
      out.keys.push({ key, present: v !== null && v !== undefined, type: typeof v });
    }

    // Anything with a subscribe/getValue (rxjs) hanging off the app.
    const streams = [];
    const seen = new Set();
    const walk = (obj, path, depth) => {
      if (!obj || depth > 3) return;
      if (typeof obj !== 'object' && typeof obj !== 'function') return;
      if (seen.has(obj)) return;
      seen.add(obj);
      let names = [];
      try { names = Object.getOwnPropertyNames(obj); } catch (_) { return; }
      for (const n of names) {
        let v = null;
        try { v = obj[n]; } catch (_) { continue; }
        const p = path + '.' + n;
        if (v && typeof v === 'object') {
          if (typeof v.getValue === 'function') {
            let value = '(threw)';
            try { value = v.getValue(); } catch (_) {}
            streams.push({
              path: p,
              kind: 'BehaviorSubject',
              value: value && typeof value === 'object' ? Object.keys(value).slice(0, 14) : value,
            });
          } else if (typeof v.subscribe === 'function') {
            streams.push({ path: p, kind: 'Observable' });
          } else if (depth < 3) {
            walk(v, p, depth + 1);
          }
        }
      }
    };
    walk(app, 'app', 0);

    // Also scan the player control modules' own module state via the require cache.
    const require = window.__moRequire;
    const moduleStreams = [];
    if (typeof require === 'function' && require.c) {
      for (const id of ['716', '1186', '685', '11']) {
        let mod;
        try { mod = require(id); } catch (_) { continue; }
        if (!mod) continue;
        for (const [n, v] of Object.entries(mod)) {
          if (v && typeof v === 'object' && typeof v.getValue === 'function') {
            let value = '(threw)';
            try { value = v.getValue(); } catch (_) {}
            moduleStreams.push({
              moduleId: id,
              exportName: n,
              kind: 'BehaviorSubject',
              value: value && typeof value === 'object' ? Object.keys(value).slice(0, 16) : value,
            });
          }
        }
      }
    }

    return { ok: true, appDesc: out.appDesc, keys: out.keys, streams: streams.slice(0, 40), moduleStreams };
  })()`;
}

/**
 * Probe the player control module (found at runtime, id passed in) for its export
 * shape and any module-level state that carries position.
 */
export function playerModuleExpression(moduleId) {
  return `(() => {
    const require = window.__moRequire;
    if (typeof require !== 'function') return { ok: false, reason: 'no require' };
    let mod;
    try { mod = require(${JSON.stringify(String(moduleId))}); } catch (err) {
      return { ok: false, reason: 'require failed: ' + String((err && err.message) || err) };
    }
    if (!mod) return { ok: false, reason: 'module not loaded' };

    const out = { ok: true, exportKeys: Object.keys(mod) };
    out.exports = {};
    for (const [n, v] of Object.entries(mod)) {
      const t = typeof v;
      if (t === 'function') {
        out.exports[n] = 'fn/' + v.length + 'args';
      } else if (v && t === 'object') {
        const names = [];
        try { names = Object.getOwnPropertyNames(v); } catch (_) {}
        out.exports[n] = 'object{' + names.slice(0, 22).join(',') + '}';
      } else {
        out.exports[n] = t + ':' + String(v).slice(0, 60);
      }
    }
    return out;
  })()`;
}
