/**
 * Client process / channel diagnostics.
 *
 * Two environment facts drive this implementation (both measured, see NOTES.md):
 *
 *   1. `tasklist /FI ...` and `Get-CimInstance Win32_Process` cannot see the
 *      client's protected processes on this machine ("Access denied" / empty),
 *      while PowerShell's `Get-Process` works.
 *   2. A confined shell cannot capture a child process's stdio at all:
 *      `spawnSync` with the default piped stdio fails with EPERM. So the child is
 *      launched with stdio ignored and writes its answer to a state file, which we
 *      then read. That works both sandboxed and normally.
 *
 * Distinguishing "client not running" from "running but launched without the debug
 * flag" matters because the remedy differs: start it vs restart it.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CdpSession, DEFAULT_CDP_PORT } from './cdp.ts';
import type { ConnectionInfo, ConnectionState } from '../../shared/src/index.ts';

const PROCESS_TIMEOUT_MS = 8000;

/** Number of running `cloudmusic` processes, or 0 when it cannot be determined. */
export async function clientProcessCount(): Promise<number> {
  const { mkdtempSync: mk } = await import('node:fs');
  let dir: string;
  try {
    dir = mkdtempSync(join(tmpdir(), 'mo-proc-'));
  } catch {
    try {
      dir = mkdtempSync(join(process.cwd(), '.scratch', 'mo-proc-'));
    } catch {
      return 0;
    }
  }

  const outFile = join(dir, 'count.txt');
  const script =
    `Get-Process -Name cloudmusic -ErrorAction SilentlyContinue | ` +
    `Measure-Object | Select-Object -ExpandProperty Count | ` +
    `Set-Content -LiteralPath '${outFile.replace(/'/g, "''")}' -Encoding ascii`;

  try {
    spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
      stdio: 'ignore',
      windowsHide: true,
      timeout: PROCESS_TIMEOUT_MS,
    });
    const text = readFileSync(outFile, 'utf8').trim();
    const match = text.match(/\d+/);
    const parsed = match ? Number(match[0]) : 0;
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  } catch {
    return 0;
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
}

export interface Diagnosis {
  state: ConnectionState;
  port: number;
  clientProcessCount: number;
  detail: string;
  lastError: string | null;
}

const DETAIL: Record<ConnectionState, string> = {
  ready: '已同步',
  connecting: '正在连接客户端…',
  'client-not-running': '没找到网易云客户端，请先启动',
  'needs-relaunch': '客户端没开同步通道，重启一次即可',
  'no-target': '通道已开，没找到播放页面（客户端可能还在启动）',
  disconnected: '连接已断开，正在重试…',
};

export function detailFor(state: ConnectionState): string {
  return DETAIL[state];
}

/**
 * Ask the channel and the process table what the current situation is.
 * Never throws; a failure to reach the channel is itself the diagnosis.
 */
export async function diagnose(port = DEFAULT_CDP_PORT): Promise<Diagnosis> {
  let portReachable = false;
  let pageFound = false;
  let lastError: string | null = null;

  try {
    const { neteasePage } = await CdpSession.listTargets(port);
    portReachable = true;
    pageFound = neteasePage !== null;
  } catch (err) {
    lastError = err instanceof Error ? err.message : String(err);
  }

  const processes = await clientProcessCount();

  let state: ConnectionState;
  if (pageFound) state = 'ready';
  else if (portReachable) state = 'no-target';
  else if (processes > 0) state = 'needs-relaunch';
  else state = 'client-not-running';

  return {
    state,
    port,
    clientProcessCount: processes,
    detail: detailFor(state),
    lastError: state === 'ready' ? null : lastError,
  };
}

export function toConnectionInfo(diagnosis: Diagnosis, since = Date.now()): ConnectionInfo {
  return {
    state: diagnosis.state,
    port: diagnosis.port,
    clientProcessCount: diagnosis.clientProcessCount,
    detail: diagnosis.detail,
    lastError: diagnosis.lastError,
    since,
  };
}
