// Minimal Chrome DevTools Protocol client used by the phase-0 diagnostic tools.
//
// Deliberately dependency-free (Node's built-in global `WebSocket`) so these
// tools run before `npm install`. The TypeScript host in packages/host will grow
// its own client; this one exists to prove the channel works and to let us dump
// the live client state without booting Electron.

export const DEFAULT_CDP_PORT = 9223;

/** NetEase Cloud Music's own renderer URL scheme. */
export const NETEASE_PAGE_PREFIX = 'orpheus://';

export class CdpChannelUnavailableError extends Error {
  constructor(port, cause) {
    super(
      `无法连接网易云音乐的本地控制通道 (127.0.0.1:${port})：${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    );
    this.name = 'CdpChannelUnavailableError';
    this.port = port;
  }
}

async function fetchJson(url, timeoutMs) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ac.signal,
      headers: { accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Ask the client which debug targets it exposes.
 * @returns {Promise<{targets: any[], neteasePage: any|null}>}
 */
export async function listTargets({ port = DEFAULT_CDP_PORT, timeoutMs = 4000 } = {}) {
  let targets;
  try {
    targets = await fetchJson(`http://127.0.0.1:${port}/json`, timeoutMs);
  } catch (err) {
    throw new CdpChannelUnavailableError(port, err);
  }
  if (!Array.isArray(targets)) {
    throw new CdpChannelUnavailableError(port, new Error('unexpected /json payload'));
  }
  const neteasePage =
    targets.find(
      (t) => t?.type === 'page' && String(t.url ?? '').startsWith(NETEASE_PAGE_PREFIX),
    ) ?? null;
  return { targets, neteasePage };
}

/**
 * Is the client process running right now?
 *
 * Two environment facts shape this implementation:
 *
 *  1. `tasklist /FI ...` and `Get-CimInstance Win32_Process` return
 *     "Access denied"/empty for the client's protected processes on this machine.
 *     PowerShell's `Get-Process` reports them correctly.
 *  2. A confined shell cannot capture a child process's stdio at all --
 *     `spawnSync` with the default piped stdio fails with EPERM. So we launch the
 *     child with stdio ignored and have it write the answer to a state file,
 *     which we then read. That path works both sandboxed and normally.
 *
 * @returns {Promise<number>} number of matching processes (0 when unknown/not running)
 */
export async function clientProcessCount() {
  const { spawnSync } = await import('node:child_process');
  const { readFileSync, mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');

  let dir;
  try {
    dir = mkdtempSync(join(tmpdir(), 'mo-proc-'));
  } catch {
    // Fall back to a workspace-relative scratch dir if the temp area is closed.
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
    // stdio ignored: no pipes, so a confined shell can still start this.
    spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
      stdio: 'ignore',
      windowsHide: true,
      timeout: 8000,
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

/** Backwards-compatible boolean wrapper. */
export async function isClientRunning() {
  return (await clientProcessCount()) > 0;
}

/**
 * Open a CDP session on the NetEase page target and return a tiny JSON-RPC facade.
 *
 * Chromium's debugger only accepts loopback origins, and Node's WebSocket does
 * not send an Origin header by default -- so we set it explicitly.
 */
export async function connectToNeteasePage({ port = DEFAULT_CDP_PORT, timeoutMs = 8000 } = {}) {
  const { neteasePage } = await listTargets({ port });
  if (!neteasePage?.webSocketDebuggerUrl) {
    throw new CdpChannelUnavailableError(
      port,
      new Error(`未找到 ${NETEASE_PAGE_PREFIX} 页面目标（客户端可能仍在启动）`),
    );
  }

  const ws = new WebSocket(neteasePage.webSocketDebuggerUrl, {
    headers: { Origin: 'http://localhost' },
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('CDP WebSocket 连接超时')), timeoutMs);
    ws.addEventListener('open', () => {
      clearTimeout(timer);
      resolve();
    });
    ws.addEventListener('error', (ev) => {
      clearTimeout(timer);
      reject(new Error(`CDP WebSocket 连接失败: ${ev?.message ?? 'error'}`));
    });
  });

  let nextId = 1;
  /** @type {Map<number, {resolve: (v:any)=>void, reject:(e:Error)=>void}>} */
  const pending = new Map();
  /** @type {Array<(msg:any)=>void>} */
  const listeners = [];

  ws.addEventListener('message', (ev) => {
    let msg;
    try {
      msg = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data));
    } catch {
      return;
    }
    if (msg.id != null && pending.has(msg.id)) {
      const entry = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) entry.reject(new Error(msg.error.message ?? 'CDP error'));
      else entry.resolve(msg.result);
      return;
    }
    for (const fn of listeners) fn(msg);
  });

  const closed = new Promise((resolve) => {
    ws.addEventListener('close', () => resolve('closed'));
    ws.addEventListener('error', () => resolve('error'));
  });

  /** Send a CDP command. */
  function send(method, params = {}, { sessionTimeoutMs = 15000 } = {}) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`CDP ${method} 超时`));
      }, sessionTimeoutMs);
      pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      ws.send(JSON.stringify({ id, method, params }));
    });
  }

  /**
   * Evaluate an expression in the page. Throws with the page's own error text.
   * @returns {Promise<any>} the value, via JSON round-trip where possible
   */
  async function evaluate(expression, { awaitPromise = false, returnByValue = true } = {}) {
    const res = await send('Runtime.evaluate', {
      expression,
      returnByValue,
      awaitPromise,
      userGesture: false,
    });
    if (res?.exceptionDetails) {
      const detail = res.exceptionDetails;
      const text =
        detail.exception?.description ?? detail.text ?? 'unknown JavaScript error';
      throw new Error(`页面内求值失败: ${text}`);
    }
    return res?.result?.value;
  }

  /** Subscribe to raw CDP events. Returns an unsubscribe function. */
  function onEvent(fn) {
    listeners.push(fn);
    return () => {
      const i = listeners.indexOf(fn);
      if (i >= 0) listeners.splice(i, 1);
    };
  }

  await send('Runtime.enable');

  return {
    ws,
    send,
    evaluate,
    onEvent,
    closed,
    target: neteasePage,
    close() {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    },
  };
}

/**
 * Human-readable diagnosis of why the channel is (not) usable.
 * Distinguishes "client not running" from "running but launched without the flag"
 * because the fix is different for each.
 */
export async function diagnoseChannel({ port = DEFAULT_CDP_PORT } = {}) {
  const processCount = await clientProcessCount();
  const running = processCount > 0;
  try {
    const { targets, neteasePage } = await listTargets({ port });
    return {
      state: neteasePage ? 'ready' : 'no-target',
      running,
      processCount,
      port,
      targetCount: targets.length,
      neteasePage: neteasePage ? { title: neteasePage.title, url: neteasePage.url } : null,
    };
  } catch {
    return {
      state: running ? 'needs-relaunch' : 'client-not-running',
      running,
      processCount,
      port,
      targetCount: 0,
      neteasePage: null,
    };
  }
}
