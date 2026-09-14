// Probe the audio pipeline module (discovered at runtime as the module exporting
// audioPlayerPlayProgress$). Subscribes to its observables and reports the real
// emitted values, which is what the overlay's progress clock will run on.

/**
 * Subscribe to every observable the audio module exports, collect a few samples,
 * and report value shapes. The subscription is torn down afterwards.
 */
export function sampleAudioStreamsExpression(moduleId, samples = 4, intervalMs = 300) {
  return `(async () => {
    const require = window.__moRequire;
    if (typeof require !== 'function') return { ok: false, reason: 'no require' };
    let mod;
    try { mod = require(${JSON.stringify(String(moduleId))}); } catch (err) {
      return { ok: false, reason: 'require failed: ' + String((err && err.message) || err) };
    }
    if (!mod) return { ok: false, reason: 'module not loaded' };

    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const describe = (v, depth = 0) => {
      if (v === null || v === undefined) return v;
      const t = typeof v;
      if (t === 'number' || t === 'boolean' || t === 'string') {
        return t === 'string' && v.length > 80 ? v.slice(0, 80) + '...' : v;
      }
      if (t === 'function') return '[fn]';
      if (depth > 2) return '[deep]';
      if (Array.isArray(v)) return v.slice(0, 4).map((x) => describe(x, depth + 1));
      const out = {};
      let n = 0;
      for (const k of Object.keys(v)) {
        if (n++ >= 16) { out['...'] = 'more'; break; }
        out[k] = describe(v[k], depth + 1);
      }
      return out;
    };

    const results = [];
    const names = Object.keys(mod).filter((n) => {
      const v = mod[n];
      return v && typeof v === 'object' && typeof v.subscribe === 'function';
    });

    for (const name of names) {
      const stream = mod[name];
      const captured = [];
      let init = null;
      try { if (typeof stream.getValue === 'function') init = describe(stream.getValue()); } catch (_) {}
      const sub = stream.subscribe({
        next: (v) => { if (captured.length < ${samples}) captured.push(describe(v)); },
        error: (e) => captured.push({ error: String((e && e.message) || e) }),
      });
      await sleep(${intervalMs});
      try { sub.unsubscribe(); } catch (_) {}
      results.push({ name, initial: init, samples: captured });
    }

    return { ok: true, streamNames: names, results };
  })()`;
}

/**
 * Find who consumes the audio module's transport functions, so we can learn each
 * function's expected arguments from real call sites instead of trial and error.
 */
export function findControlCallSitesExpression(audioModuleId) {
  return `(() => {
    const require = window.__moRequire;
    if (typeof require !== 'function') return { ok: false, reason: 'no require' };
    const audioMod = require(${JSON.stringify(String(audioModuleId))});
    if (!audioMod) return { ok: false, reason: 'audio module not loaded' };

    // Names we care about, taken from the module itself.
    const wanted = Object.keys(audioMod).filter((n) => typeof audioMod[n] === 'function');
    const interesting = ['setAudioPlayerPlay', 'setAudioPlayerPause', 'setAudioPlayerStop', 'seekAudioPlayer', 'startLoad'];

    const cache = require.c || {};
    const hits = [];
    for (const id of Object.keys(cache)) {
      if (id === ${JSON.stringify(String(audioModuleId))}) continue;
      let mod;
      try { mod = require(id); } catch (_) { continue; }
      if (!mod) continue;
      for (const [expName, value] of Object.entries(mod)) {
        if (typeof value !== 'function') continue;
        let src = '';
        try { src = Function.prototype.toString.call(value); } catch (_) { continue; }
        // The minified import name is unknown, so match by presence of several
        // pipeline method names plus rxjs subscribe plumbing.
        const mentioned = interesting.filter((n) => src.indexOf(n) >= 0);
        const touchesPipeline = src.indexOf('audioPlayerPlayProgress') >= 0 ||
                                src.indexOf('audioPlayerSeekSeconds') >= 0 ||
                                src.indexOf('audioPlayerPlayState') >= 0;
        if (mentioned.length || touchesPipeline) {
          hits.push({
            moduleId: id,
            exportName: expName,
            mentioned,
            touchesPipeline,
            excerpt: src.length > 700 ? src.slice(0, 700) + '...' : src,
          });
        }
        if (hits.length >= 10) break;
      }
      if (hits.length >= 10) break;
    }
    return { ok: true, wanted, hits };
  })()`;
}
