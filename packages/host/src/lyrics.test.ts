// Unit tests for the lyrics service's source selection and retry behaviour.
//
//   node packages/host/src/lyrics.test.ts
//
// Run in-process rather than through `node --test <dir>`: spawning a child process for each file
// hits EPERM in this environment, so every test file here is a plain script.
//
// The behaviour under test is the one that made a run of tracks look like they had no lyrics.
// "The public request failed" and "this track has no lyrics" used to fall through to the same log
// line and neither was ever retried, so a single timeout or transient rate limit left the card
// showing credits only for the rest of the session. Both halves are pinned here: the retry
// happens, and a failure is never treated as a result.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import type { LyricDoc } from '@ncm-trackpic-card/shared';

import type { ClientSession } from './session.ts';

// Redirect the lyric cache before the service module is imported, so nothing touches the real
// one. `cacheDir()` reads the variable on every call, but the directory has to exist first.
const cacheRoot = mkdtempSync(join(tmpdir(), 'ncm-lyrics-test-'));
process.env.OVERLAY_CACHE_DIR = cacheRoot;

const { LyricsService } = await import('./lyrics.ts');

/* ------------------------------------------------------------------- doubles */

/** One scripted response: a thrown error, an HTTP error, or a payload to return. */
type FetchStep = 'fail' | 'http500' | Record<string, unknown>;

const WITH_LYRICS: FetchStep = { lrc: { lyric: '[00:01.00]第一行\n[00:02.00]第二行' } };
const EMPTY: FetchStep = { lrc: { lyric: '' } };

interface Harness {
  logs: string[];
  docs: LyricDoc[];
  calls: string[];
  emit: (songId: number) => void;
  /** Log lines containing `needle`. */
  find: (needle: string) => string[];
}

interface HarnessOptions {
  script: FetchStep[];
  name?: string;
  artist?: string;
  retryDelayMs?: number;
}

/**
 * Build a service wired to a session stub and a scripted fetch.
 *
 * The stubs are cast rather than implemented in full: `ClientSession` is a large class, and the
 * service only ever reads `currentSnapshot` and subscribes to two events.
 */
function makeService(options: HarnessOptions): Harness {
  const { script, name = 'テスト曲', artist = 'テスト歌手', retryDelayMs = 5 } = options;

  const handlers = new Map<string, (payload: unknown) => void>();
  const session = {
    currentSnapshot: { song: { name, artists: [{ name: artist }] } },
    on(event: string, handler: (payload: unknown) => void) {
      handlers.set(event, handler);
      return session;
    },
  };

  const calls: string[] = [];
  const fetchImpl = async (url: string): Promise<unknown> => {
    calls.push(String(url));
    const step = script.shift();
    if (step === undefined || step === 'fail') throw new Error('network down');
    if (step === 'http500') return { ok: false, json: async () => ({}) };
    return { ok: true, json: async () => step };
  };

  const logs: string[] = [];
  const docs: LyricDoc[] = [];
  const service = new LyricsService({
    session: session as unknown as ClientSession,
    fetchOptions: { fetchImpl: fetchImpl as unknown as typeof fetch },
    log: (level, message) => logs.push(`${level} ${message}`),
    onDoc: (doc) => docs.push(doc),
    // The real delay exists so a rate-limited endpoint is not hammered; the tests only care that
    // a second attempt happens after it.
    retryDelayMs,
  });
  // The service subscribes to the session in start(); without it nothing is ever asked for.
  service.start();

  return {
    logs,
    docs,
    calls,
    emit: (songId) => handlers.get('lyricsNeeded')?.(songId),
    find: (needle) => logs.filter((line) => line.includes(needle)),
  };
}

/** Let queued microtasks and the injected retry delay run. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 30));
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

after(() => {
  try {
    rmSync(cacheRoot, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

/* --------------------------------------------------------------------- tests */

describe('public endpoint failures are retried', () => {
  it('succeeds on the second attempt after a thrown request', async () => {
    const t = makeService({ script: ['fail', WITH_LYRICS] });
    t.emit(111001);
    await settle();

    assert.equal(t.calls.length, 2, '应当重试一次');
    assert.equal(t.docs.length, 1, '重试成功后应当交付歌词');
    assert.equal(t.docs[0]?.lines.length, 2);
    assert.equal(t.find('公开接口请求失败').length, 1, '应当记录一次请求失败');
    assert.equal(t.find('歌词来自公开接口').length, 1);
  });

  it('retries an HTTP 500 as well as a thrown error', async () => {
    const t = makeService({ script: ['http500', WITH_LYRICS] });
    t.emit(111002);
    await settle();

    assert.equal(t.calls.length, 2);
    assert.equal(t.docs.length, 1);
  });

  it('gives up after the second failure and says so', async () => {
    const t = makeService({ script: ['fail', 'fail'] });
    t.emit(111003);
    await settle();

    assert.equal(t.calls.length, 2, '只重试一次');
    assert.equal(t.docs.length, 0);
    assert.equal(t.find('两次请求都失败').length, 1);
    // The distinguishing point: this must NOT be reported as "no lyrics", or a network problem
    // is indistinguishable from a track that genuinely has none.
    assert.equal(t.find('公开接口无可显示歌词').length, 0, '失败不能被当作“无歌词”');
  });

  it('does not retry when the request simply had no lyrics', async () => {
    const t = makeService({ script: [EMPTY] });
    t.emit(111004);
    await settle();

    assert.equal(t.calls.length, 1, '“没歌词”是结果，不是失败，不该重试');
    assert.equal(t.find('公开接口无可显示歌词').length, 1);
    assert.equal(t.find('请求失败').length, 0);
  });

  it('discards a result that arrives after the track changed', async () => {
    const t = makeService({ script: ['fail', 'fail', 'fail'] });
    t.emit(111005);
    // Switch tracks while the first request is still in flight. Its result can only describe the
    // previous track, so it must be thrown away rather than delivered.
    t.emit(111006);
    await settle();

    assert.equal(t.find('丢弃过期歌词结果: 111005').length, 1, '过期结果必须被丢弃');
    assert.equal(t.docs.length, 0, '两首歌都没有歌词可交付');
  });

  it('abandons the retry pause when the track changes during it', async () => {
    // A long pause, so the switch lands inside it rather than before the first attempt returns.
    const t = makeService({ script: ['fail', 'fail', 'fail'], retryDelayMs: 80 });
    t.emit(111007);
    await sleep(30); // the first attempt has failed; the pause before the retry is still running
    t.emit(111008);
    await sleep(150);

    assert.equal(t.find('放弃重试（已切歌）').length, 1, '重试等待期间切歌应放弃重试');
    // Track 7 was attempted once and abandoned; track 8 was attempted twice. Three in total, not
    // four: the abandoned retry must not have gone out.
    assert.equal(t.calls.length, 3, '被放弃的重试不应发出请求');
  });
});

describe('cache interaction', () => {
  it('serves a second visit from memory without touching the network', async () => {
    const t = makeService({ script: [WITH_LYRICS, EMPTY] });
    t.emit(111009);
    await settle();
    const afterFirst = t.calls.length;

    t.emit(111010); // a different track, so the service does not short-circuit on currentSongId
    t.emit(111009); // back to the first
    await settle();

    assert.equal(t.docs.length, 2, '第二次访问也应交付文档');
    assert.equal(t.calls.length, afterFirst + 1, '只有新歌发起了请求');
  });
});
