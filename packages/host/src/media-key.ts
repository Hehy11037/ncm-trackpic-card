/**
 * Media-key fallback for the transport controls.
 *
 * The overlay's own path to play/pause is the client's audio module
 * (`setAudioPlayerPlay`/`setAudioPlayerPause`), and calling it was **measured to have no effect**:
 * the command runs without throwing and the client's `playingState` never moves. A media key is the
 * documented fallback (docs/contracts.md section 6), and it has the property the audio-module call
 * lacks - it goes through the client's own global hotkey, which is what a keyboard's play button
 * uses, so it cannot break when the client's internals change.
 *
 * It is injected at the system level rather than posted to a window, which matters here: the
 * overlay is always on top and focused, so a key delivered to the foreground window would arrive at
 * the overlay instead of the client.
 *
 * ## Why this keeps a process alive
 *
 * It used to spawn PowerShell per press, which cost about **880ms** - and the owner felt every one of
 * them as a delay between clicking play/pause and the music stopping. Almost none of that was the
 * key press: roughly 380ms is Windows PowerShell starting, and the rest is `Add-Type` compiling the
 * P/Invoke declaration again *on every press*.
 *
 * So one PowerShell is started and kept, running `media-key.ps1 -Serve`: the type is compiled once
 * and each press is a single line written to its stdin, answered with an ack. Measured, a session
 * round trip is under a millisecond and a real press is dominated by the script's own 30ms gap
 * between key-down and key-up - about **35ms per press** instead of 880ms.
 *
 * `spawnSync` is kept as a fallback. It is what runs if the session cannot be started or dies
 * mid-life, and it is also the only path that works where a child with piped stdio cannot be
 * created at all - which is exactly what a confined build shell does, so the test suite would
 * otherwise be unable to exercise this file.
 */

import { spawn, spawnSync, type ChildProcessByStdio } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = resolve(HERE, '..', '..', '..', 'tools', 'media-key.ps1');
const PRESS_TIMEOUT_MS = 6000;
/** The first command pays PowerShell's start plus the type compile; the rest are immediate. */
const START_TIMEOUT_MS = 15000;

export type MediaKey = 'playpause' | 'next' | 'prev' | 'stop';

export interface MediaKeyResult {
  ok: boolean;
  message: string;
}

/** stdio: ['pipe', 'pipe', 'ignore'] means stdin and stdout are pipes and stderr is not. */
type MediaSession = ChildProcessByStdio<Writable, Readable, null>;

let child: MediaSession | null = null;
let buffer = '';
let waiting: ((line: string) => void) | null = null;
let starting: Promise<void> | null = null;

function missing(): MediaKeyResult | null {
  if (process.platform !== 'win32') return { ok: false, message: '媒体键兜底目前只在 Windows 上实现' };
  if (!existsSync(SCRIPT)) return { ok: false, message: `找不到媒体键脚本: ${SCRIPT}` };
  return null;
}

/** Hand the next output line to whoever is waiting for it. */
function consume(chunk: string): void {
  buffer += chunk;
  let at = buffer.indexOf('\n');
  while (at >= 0) {
    const line = buffer.slice(0, at).trim();
    buffer = buffer.slice(at + 1);
    if (line && waiting) {
      const resolveWaiting = waiting;
      waiting = null;
      resolveWaiting(line);
    }
    at = buffer.indexOf('\n');
  }
}

/** Write one command and wait for its reply line. */
function ask(command: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve_) => {
    if (!child || child.exitCode !== null) {
      resolve_('ERR no session');
      return;
    }
    const timer = setTimeout(() => {
      if (waiting === settle) waiting = null;
      settle(`ERR timeout after ${timeoutMs}ms`);
    }, timeoutMs);
    const settle = (line: string) => {
      clearTimeout(timer);
      resolve_(line);
    };
    waiting = settle;
    try {
      child.stdin.write(`${command}\n`);
    } catch (err) {
      settle(`ERR ${err instanceof Error ? err.message : String(err)}`);
    }
  });
}

/** Start the session if it is not running, and wait for its type to be compiled. */
function startSession(): Promise<void> {
  if (child && child.exitCode === null) return Promise.resolve();
  if (starting) return starting;
  starting = new Promise<void>((resolve_) => {
    let started: MediaSession;
    try {
      started = spawn(
        'powershell',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT, '-Serve'],
        { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true },
      );
    } catch {
      starting = null;
      resolve_();
      return;
    }
    child = started;
    buffer = '';
    started.stdout.setEncoding('utf8');
    started.stdout.on('data', consume);
    started.on('error', () => {
      child = null;
      if (waiting) {
        const settle = waiting;
        waiting = null;
        settle('ERR session error');
      }
    });
    started.on('exit', () => {
      child = null;
      starting = null;
      if (waiting) {
        const settle = waiting;
        waiting = null;
        settle('ERR session exited');
      }
    });
    // The reply to `ping` is the round trip that proves the compile is finished, so the first real
    // press is not the one that waits for it.
    void ask('ping', START_TIMEOUT_MS).then(() => {
      starting = null;
      resolve_();
    });
  });
  return starting;
}

/**
 * Start the session now, so the first button press is fast.
 *
 * Called when the host starts. Failures are swallowed: `pressMediaKey` falls back to one-shot
 * spawning, which is slower but correct.
 */
export async function warmMediaKeys(): Promise<void> {
  if (missing()) return;
  await startSession();
}

/** Shut the session down. The host calls this on stop so no hidden PowerShell is left behind. */
export function stopMediaKeys(): void {
  const running = child;
  child = null;
  starting = null;
  if (!running) return;
  try {
    running.stdin.write('quit\n');
  } catch {
    /* already gone */
  }
  running.kill();
}

/** The old path: one PowerShell per press. Slow, but it needs no pipes to the child. */
function pressOnce(key: MediaKey): MediaKeyResult {
  const started = Date.now();
  try {
    const result = spawnSync(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT, '-Key', key],
      { stdio: 'ignore', windowsHide: true, timeout: PRESS_TIMEOUT_MS },
    );
    const ms = Date.now() - started;
    if (result.error) return { ok: false, message: `发送媒体键失败: ${result.error.message}` };
    if (result.status !== 0) {
      return { ok: false, message: `media-key.ps1 退出码 ${result.status}（耗时 ${ms}ms）` };
    }
    return { ok: true, message: `已发送媒体键 ${key}（一次性进程，耗时 ${ms}ms）` };
  } catch (err) {
    return { ok: false, message: `发送媒体键异常: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/** Press a media key. Never throws; the result says what happened. */
export async function pressMediaKey(key: MediaKey): Promise<MediaKeyResult> {
  const absent = missing();
  if (absent) return absent;

  try {
    await startSession();
    if (!child) return pressOnce(key);
    const started = Date.now();
    const line = await ask(key, PRESS_TIMEOUT_MS);
    const ms = Date.now() - started;
    if (line.startsWith('SENT:')) return { ok: true, message: `已发送媒体键 ${key}（耗时 ${ms}ms）` };
    // A dead or wedged session: drop it and fall back, so a press is never silently lost.
    stopMediaKeys();
    const fallback = pressOnce(key);
    return { ok: fallback.ok, message: `${line}；${fallback.message}` };
  } catch (err) {
    return { ok: false, message: `发送媒体键异常: ${err instanceof Error ? err.message : String(err)}` };
  }
}
