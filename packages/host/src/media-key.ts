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
 * PowerShell rather than a native addon, because the project already ships PowerShell tooling and
 * this is one `keybd_event` call. The child's stdio is ignored and its exit code is the answer,
 * which is the same pattern `client-process.ts` uses and for the same reason: a confined shell
 * cannot capture a child's output at all.
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = resolve(HERE, '..', '..', '..', 'tools', 'media-key.ps1');
const PRESS_TIMEOUT_MS = 6000;

export type MediaKey = 'playpause' | 'next' | 'prev' | 'stop';

export interface MediaKeyResult {
  ok: boolean;
  message: string;
}

/** Press a media key. Never throws; the result says what happened. */
export function pressMediaKey(key: MediaKey): MediaKeyResult {
  if (process.platform !== 'win32') {
    return { ok: false, message: '媒体键兜底目前只在 Windows 上实现' };
  }
  if (!existsSync(SCRIPT)) {
    return { ok: false, message: `找不到媒体键脚本: ${SCRIPT}` };
  }

  const started = Date.now();
  try {
    const result = spawnSync(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT, '-Key', key],
      { stdio: 'ignore', windowsHide: true, timeout: PRESS_TIMEOUT_MS },
    );
    const ms = Date.now() - started;
    if (result.error) {
      return { ok: false, message: `发送媒体键失败: ${result.error.message}` };
    }
    if (result.status !== 0) {
      return { ok: false, message: `media-key.ps1 退出码 ${result.status}（耗时 ${ms}ms）` };
    }
    return { ok: true, message: `已发送媒体键 ${key}（耗时 ${ms}ms）` };
  } catch (err) {
    return { ok: false, message: `发送媒体键异常: ${err instanceof Error ? err.message : String(err)}` };
  }
}
