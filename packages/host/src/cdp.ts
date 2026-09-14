/**
 * CDP (Chromium DevTools Protocol) transport for the NetEase client.
 *
 * The client is CEF-based and only exposes its debug channel when started with
 * `--remote-debugging-port`. Two details measured on this machine matter:
 *
 *   1. Chromium rejects debugger handshakes that lack a loopback `Origin`, and
 *      Node's built-in WebSocket cannot send custom headers — hence `ws`.
 *   2. The client enforces a single instance, so the host must never try to
 *      launch it while another instance is running; it should ask the user
 *      instead. See docs/contracts.md.
 */

import WebSocket from 'ws';
export const DEFAULT_CDP_PORT = 9223;
const NETEASE_PAGE_PREFIX = 'orpheus://';

export interface CdpTarget {
  id?: string;
  type?: string;
  title?: string;
  url?: string;
  webSocketDebuggerUrl?: string;
}

export class ChannelUnavailableError extends Error {
  readonly port: number;

  constructor(port: number, cause: unknown) {
    super(
      `无法连接网易云音乐的本地控制通道 (127.0.0.1:${port})：${
        cause instanceof Error ? cause.message : String(cause)
      }`,
      { cause },
    );
    this.name = 'ChannelUnavailableError';
    this.port = port;
  }
}

interface PendingCall {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export interface CdpSessionEvents {
  /** Raw CDP events, already unwrapped from the envelope. */
  event?: (method: string, params: any) => void;
  close?: (reason: string) => void;
}

/** A live CDP session bound to the client's page target. */
export class CdpSession {
  readonly target: CdpTarget;
  private readonly socket: WebSocket;
  private nextId = 1;
  private readonly pending = new Map<number, PendingCall>();
  private readonly listeners: CdpSessionEvents;
  private closedReason: string | null = null;

  private constructor(socket: WebSocket, target: CdpTarget, listeners: CdpSessionEvents) {
    this.socket = socket;
    this.target = target;
    this.listeners = listeners;

    socket.on('message', (data: WebSocket.RawData) => this.onMessage(data));
    socket.on('close', () => this.finish('socket closed'));
    socket.on('error', (err: Error) => this.finish(`socket error: ${err.message}`));
  }

  get isClosed(): boolean {
    return this.closedReason !== null;
  }

  get closedBecause(): string | null {
    return this.closedReason;
  }

  /** Fetch the client's debug targets. */
  static async listTargets(
    port: number,
    timeoutMs = 4000,
  ): Promise<{ targets: CdpTarget[]; neteasePage: CdpTarget | null }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json`, {
        signal: controller.signal,
        headers: { accept: 'application/json' },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const targets = (await res.json()) as CdpTarget[];
      if (!Array.isArray(targets)) throw new Error('unexpected /json payload');
      const neteasePage =
        targets.find(
          (t) => t.type === 'page' && String(t.url ?? '').startsWith(NETEASE_PAGE_PREFIX),
        ) ?? null;
      return { targets, neteasePage };
    } catch (err) {
      throw new ChannelUnavailableError(port, err);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Attach to the client's page target and enable the Runtime domain. */
  static async attach(
    port: number,
    listeners: CdpSessionEvents = {},
    timeoutMs = 8000,
  ): Promise<CdpSession> {
    const { neteasePage } = await CdpSession.listTargets(port);
    if (!neteasePage?.webSocketDebuggerUrl) {
      throw new ChannelUnavailableError(
        port,
        new Error(`未找到 ${NETEASE_PAGE_PREFIX} 页面目标（客户端可能仍在启动）`),
      );
    }

    const socket = new WebSocket(neteasePage.webSocketDebuggerUrl, {
      origin: 'http://localhost',
    });

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('CDP WebSocket 连接超时')), timeoutMs);
      socket.once('open', () => {
        clearTimeout(timer);
        resolve();
      });
      socket.once('error', (err: Error) => {
        clearTimeout(timer);
        reject(new Error(`CDP WebSocket 连接失败: ${err.message}`));
      });
    });

    const session = new CdpSession(socket, neteasePage, listeners);
    await session.send('Runtime.enable');
    return session;
  }

  /** Send a CDP command. */
  send<T = any>(method: string, params: Record<string, unknown> = {}, timeoutMs = 15000): Promise<T> {
    if (this.closedReason) {
      return Promise.reject(new Error(`CDP 会话已关闭（${this.closedReason}）`));
    }
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP ${method} 超时`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: resolve as (value: any) => void,
        reject,
        timer,
      });
      try {
        this.socket.send(JSON.stringify({ id, method, params }));
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  /**
   * Evaluate an expression in the page and return its value.
   * Page-side exceptions are surfaced with the page's own message.
   */
  async evaluate<T = any>(
    expression: string,
    options: { awaitPromise?: boolean; returnByValue?: boolean; timeoutMs?: number } = {},
  ): Promise<T> {
    const result = await this.send<any>(
      'Runtime.evaluate',
      {
        expression,
        returnByValue: options.returnByValue ?? true,
        awaitPromise: options.awaitPromise ?? false,
        userGesture: false,
      },
      options.timeoutMs ?? 15000,
    );
    if (result?.exceptionDetails) {
      const detail = result.exceptionDetails;
      const text =
        detail.exception?.description ?? detail.text ?? 'unknown JavaScript error';
      throw new Error(`页面内求值失败: ${text}`);
    }
    return result?.result?.value as T;
  }

  /** Evaluate an expression that returns a JSON string, and parse it. */
  async evaluateJson<T = any>(expression: string, awaitPromise = false): Promise<T> {
    const raw = await this.evaluate<string | T>(expression, { awaitPromise });
    if (typeof raw !== 'string') return raw as T;
    try {
      return JSON.parse(raw) as T;
    } catch {
      throw new Error(`返回值不是合法 JSON: ${raw.slice(0, 160)}`);
    }
  }

  close(): void {
    try {
      this.socket.close();
    } catch {
      /* ignore */
    }
    this.finish('closed by host');
  }

  private onMessage(data: WebSocket.RawData): void {
    let message: any;
    try {
      message = JSON.parse(typeof data === 'string' ? data : data.toString());
    } catch {
      return;
    }

    if (message.id != null) {
      const call = this.pending.get(message.id);
      if (!call) return;
      this.pending.delete(message.id);
      clearTimeout(call.timer);
      if (message.error) call.reject(new Error(message.error.message ?? 'CDP error'));
      else call.resolve(message.result);
      return;
    }

    if (typeof message.method === 'string') {
      this.listeners.event?.(message.method, message.params);
    }
  }

  private finish(reason: string): void {
    if (this.closedReason) return;
    this.closedReason = reason;
    for (const [, call] of this.pending) {
      clearTimeout(call.timer);
      call.reject(new Error(`CDP 会话中断（${reason}）`));
    }
    this.pending.clear();
    this.listeners.close?.(reason);
  }
}

/** Is the client process running? (See client-process.ts for the mechanism.) */
export async function isPortListening(port: number, timeoutMs = 1500): Promise<boolean> {
  try {
    await CdpSession.listTargets(port, timeoutMs);
    return true;
  } catch {
    return false;
  }
}
