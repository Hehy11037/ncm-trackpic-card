/**
 * Runtime webpack module discovery for the NetEase client page.
 *
 * Why not hardcode ids: the community implementation
 * (cloudmusic-desktop-mcp) uses module ids 987660 and 12, and those do **not**
 * exist in the client build on this machine (verified by searching all 231 files
 * unpacked from web.pack). Hardcoding would break on the next client update; the
 * only durable approach is to locate the modules by what they export.
 *
 * Two things are discovered:
 *
 *   1. `window.__moRequire` — the real webpack require, obtained by pushing a
 *      synthetic chunk through the app's own JSONP registry.
 *   2. The dva-tool singleton (`window.__moDva`) — the one module exporting both
 *      `getStore` and `getDispatch`.
 *
 * Results are cached on disk so that a client upgrade costs one slow scan and
 * every later start is fast.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import type { CdpSession } from './cdp.js';

/** Chunk ids tried for the synthetic bootstrap chunk; first accepted one wins. */
const BOOTSTRAP_CHUNK_IDS = [990001, 990002, 990003, 900001, 900002, 999999];

export interface DiscoveryResult {
  ok: boolean;
  requireChunkId: number | null;
  moduleCount: number;
  storeModuleId: string | null;
  audioModuleId: string | null;
  scannedAt: number;
  /** Populated when discovery failed, for diagnostics. */
  reason?: string;
}

interface DiscoveryCache extends Partial<DiscoveryResult> {
  clientHint?: string;
}

const CACHE_DIR = join(
  process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'),
  'ncm-trackpic-card',
);
const CACHE_FILE = join(CACHE_DIR, 'discovery.json');

export function discoveryCachePath(): string {
  return CACHE_FILE;
}

export function readDiscoveryCache(): DiscoveryCache | null {
  try {
    return JSON.parse(readFileSync(CACHE_FILE, 'utf8')) as DiscoveryCache;
  } catch {
    return null;
  }
}

export function writeDiscoveryCache(entry: DiscoveryCache): void {
  try {
    mkdirSync(dirname(CACHE_FILE), { recursive: true });
    writeFileSync(CACHE_FILE, JSON.stringify(entry, null, 2), 'utf8');
  } catch {
    // A cache write failure is not fatal; discovery just gets slower next time.
  }
}

function bootstrapExpression(chunkId: number): string {
  return `(() => {
    const arr =
      (typeof webpackJsonp !== 'undefined' && webpackJsonp) ||
      (window && window.webpackJsonp) ||
      null;
    if (!arr || typeof arr.push !== 'function') {
      return JSON.stringify({ ok: false, reason: 'webpackJsonp registry not found' });
    }
    const mod = {};
    mod[${chunkId}] = function (module, exports, require) {
      try { window.__moRequire = require; } catch (_) {}
    };
    try {
      arr.push([[${chunkId}], mod, [[${chunkId}]]]);
    } catch (err) {
      return JSON.stringify({ ok: false, reason: String((err && err.message) || err) });
    }
    if (typeof window.__moRequire !== 'function') {
      return JSON.stringify({ ok: false, reason: 'require was not captured' });
    }
    const cache = window.__moRequire.c || {};
    return JSON.stringify({
      ok: true,
      chunkId: ${chunkId},
      moduleCount: Object.keys(cache).length,
    });
  })()`;
}

/** Locate the dva-tool singleton among already-executed modules. */
const DISCOVER_STORE_EXPRESSION = `(() => {
  const require = window.__moRequire;
  if (typeof require !== 'function') {
    return JSON.stringify({ ok: false, reason: 'no require' });
  }
  const cache = require.c || {};
  const errors = [];
  let found = null;
  for (const id of Object.keys(cache)) {
    let mod;
    try { mod = require(id); } catch (err) {
      if (errors.length < 5) errors.push(id + ': ' + String((err && err.message) || err));
      continue;
    }
    if (!mod || (typeof mod !== 'object' && typeof mod !== 'function')) continue;
    for (const exp of [mod, mod.default, mod.a]) {
      if (!exp || (typeof exp !== 'object' && typeof exp !== 'function')) continue;
      let storeOk = false;
      let dispatchOk = false;
      try { storeOk = typeof exp.getStore === 'function'; } catch (_) {}
      try { dispatchOk = typeof exp.getDispatch === 'function'; } catch (_) {}
      if (storeOk && dispatchOk) { found = { id, exp }; break; }
    }
    if (found) break;
  }
  if (!found) {
    return JSON.stringify({ ok: false, reason: 'dva-tool singleton not found', errors });
  }
  window.__moDva = found.exp;
  window.__moStore = (found.exp.app && found.exp.app._store) || null;
  return JSON.stringify({
    ok: true,
    moduleId: found.id,
    hasStore: !!window.__moStore,
    cacheSize: Object.keys(cache).length,
  });
})()`;

/** Locate the audio pipeline module by its distinctive export name. */
const DISCOVER_AUDIO_EXPRESSION = `(() => {
  const require = window.__moRequire;
  if (typeof require !== 'function') {
    return JSON.stringify({ ok: false, reason: 'no require' });
  }
  const cache = require.c || {};
  for (const id of Object.keys(cache)) {
    let mod;
    try { mod = require(id); } catch (_) { continue; }
    if (!mod) continue;
    if (Object.prototype.hasOwnProperty.call(mod, 'audioPlayerPlayProgress$')) {
      return JSON.stringify({ ok: true, moduleId: id });
    }
  }
  return JSON.stringify({ ok: false, reason: 'audio pipeline module not found' });
})()`;

async function evaluateJson(session: CdpSession, expression: string): Promise<any> {
  const raw = await session.evaluate(expression);
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw);
    } catch {
      return { ok: false, reason: `unparsable result: ${raw.slice(0, 120)}` };
    }
  }
  return raw;
}

/**
 * Ensure `window.__moRequire` exists. Tries the cached chunk id first, then the
 * remaining candidates, and reports the first accepted one.
 */
export async function ensureRequire(
  session: CdpSession,
  preferredChunkId?: number | null,
): Promise<{ ok: boolean; chunkId: number | null; moduleCount: number; reason?: string }> {
  const order = preferredChunkId
    ? [preferredChunkId, ...BOOTSTRAP_CHUNK_IDS.filter((id) => id !== preferredChunkId)]
    : [...BOOTSTRAP_CHUNK_IDS];

  // A previous injection may already be present in this page session.
  const existing = await evaluateJson(
    session,
    `typeof window.__moRequire === 'function' ? JSON.stringify({ ok: true, moduleCount: Object.keys(window.__moRequire.c || {}).length }) : JSON.stringify({ ok: false })`,
  );
  if (existing?.ok) {
    return { ok: true, chunkId: preferredChunkId ?? null, moduleCount: existing.moduleCount };
  }

  let lastReason = 'no chunk id accepted';
  for (const id of order) {
    const result = await evaluateJson(session, bootstrapExpression(id));
    if (result?.ok) {
      return { ok: true, chunkId: result.chunkId, moduleCount: result.moduleCount };
    }
    lastReason = result?.reason ?? lastReason;
  }
  return { ok: false, chunkId: null, moduleCount: 0, reason: lastReason };
}

/**
 * Full discovery. Uses the on-disk cache for the module ids, but always verifies
 * the cached ids still resolve before trusting them.
 */
export async function discover(
  session: CdpSession,
  options: { allowCache?: boolean; persist?: boolean } = {},
): Promise<DiscoveryResult> {
  const allowCache = options.allowCache ?? true;
  const persist = options.persist ?? true;
  const cache = allowCache ? readDiscoveryCache() : null;

  const req = await ensureRequire(session, cache?.requireChunkId ?? null);
  if (!req.ok) {
    return {
      ok: false,
      requireChunkId: null,
      moduleCount: 0,
      storeModuleId: null,
      audioModuleId: null,
      scannedAt: Date.now(),
      reason: `webpack bootstrap failed: ${req.reason ?? 'unknown'}`,
    };
  }

  // Fast path: cached ids still valid?
  if (cache?.storeModuleId) {
    const check = await evaluateJson(
      session,
      `(() => {
        const require = window.__moRequire;
        if (typeof require !== 'function') return JSON.stringify({ ok: false });
        try {
          const mod = require(${JSON.stringify(cache.storeModuleId)});
          const exp = (mod && (mod.a || mod.default)) || mod;
          const ok = exp && typeof exp.getStore === 'function' && typeof exp.getDispatch === 'function';
          if (!ok) return JSON.stringify({ ok: false, reason: 'cached store module no longer matches' });
          window.__moDva = exp;
          window.__moStore = (exp.app && exp.app._store) || null;
          return JSON.stringify({ ok: true, moduleId: ${JSON.stringify(cache.storeModuleId)} });
        } catch (err) {
          return JSON.stringify({ ok: false, reason: String((err && err.message) || err) });
        }
      })()`,
    );
    if (check?.ok) {
      const audio = await resolveAudioModule(session, cache.audioModuleId ?? null);
      return {
        ok: audio.moduleId != null,
        requireChunkId: req.chunkId,
        moduleCount: req.moduleCount,
        storeModuleId: check.moduleId ?? cache.storeModuleId,
        audioModuleId: audio.moduleId,
        scannedAt: Date.now(),
        reason: audio.moduleId == null ? audio.reason : undefined,
      };
    }
  }

  const store = await evaluateJson(session, DISCOVER_STORE_EXPRESSION);
  if (!store?.ok) {
    return {
      ok: false,
      requireChunkId: req.chunkId,
      moduleCount: req.moduleCount,
      storeModuleId: null,
      audioModuleId: null,
      scannedAt: Date.now(),
      reason: `store discovery failed: ${store?.reason ?? 'unknown'}`,
    };
  }

  const audio = await resolveAudioModule(session, null);
  const result: DiscoveryResult = {
    ok: audio.moduleId != null,
    requireChunkId: req.chunkId,
    moduleCount: req.moduleCount,
    storeModuleId: store.moduleId,
    audioModuleId: audio.moduleId,
    scannedAt: Date.now(),
    reason: audio.moduleId == null ? audio.reason : undefined,
  };

  if (persist) {
    writeDiscoveryCache({
      requireChunkId: result.requireChunkId,
      storeModuleId: result.storeModuleId,
      audioModuleId: result.audioModuleId,
      moduleCount: result.moduleCount,
      scannedAt: result.scannedAt,
    });
  }

  return result;
}

async function resolveAudioModule(
  session: CdpSession,
  cachedId: string | null,
): Promise<{ moduleId: string | null; reason?: string }> {
  if (cachedId) {
    const check = await evaluateJson(
      session,
      `(() => {
        try {
          const mod = window.__moRequire(${JSON.stringify(cachedId)});
          const ok = !!mod && Object.prototype.hasOwnProperty.call(mod, 'audioPlayerPlayProgress$');
          return JSON.stringify({ ok, moduleId: ${JSON.stringify(cachedId)} });
        } catch (_) {
          return JSON.stringify({ ok: false, reason: 'cached audio module threw' });
        }
      })()`,
    );
    if (check?.ok) return { moduleId: check.moduleId ?? cachedId };
  }
  const found = await evaluateJson(session, DISCOVER_AUDIO_EXPRESSION);
  if (found?.ok) return { moduleId: String(found.moduleId) };
  return { moduleId: null, reason: found?.reason ?? 'audio module not found' };
}
