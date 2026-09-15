/**
 * Orchestrates the whole client-facing side of the host:
 *
 *   connect (CDP) -> discover modules -> inject bridge -> stream events
 *                                                    \-> send commands
 *
 * Reconnection is handled here: the client may be closed, restarted, or the page
 * may navigate (which wipes the injected bridge). In every case we back off, retry,
 * and re-run discovery/injection. Discovery results are cached on disk so a
 * reconnect after a client upgrade costs one slow scan at most.
 */

import { EventEmitter } from 'node:events';

import type {
  ClientLyricSlice,
  ConnectionInfo,
  ControlCommand,
  ControlResult,
  PlayMode,
  Playback,
  PlaybackSnapshot,
  Playhead,
  PlaybackStatus,
  QueueInfo,
  Song,
} from '@ncm-trackpic-card/shared';
import { rawPlayingStateToStatus, toSongId } from '@ncm-trackpic-card/shared';

import {
  BRIDGE_PREFIX,
  bridgeHealthExpression,
  bridgeResendExpression,
  buildBridgeScript,
  commandResultPollExpression,
} from './bridge-script.ts';
import { CdpSession, DEFAULT_CDP_PORT, type CdpTarget } from './cdp.ts';
import { diagnose, detailFor, toConnectionInfo } from './client-process.ts';
import { pressMediaKey } from './media-key.ts';

/**
 * How long to wait for the client to show the state a transport command asked for.
 *
 * Long enough to cover the client's own round trip to its audio pipeline, short enough that a
 * button does not feel like it is waiting. It costs no extra traffic: the snapshots it watches are
 * already arriving.
 */
const CONTROL_CONFIRM_MS = 900;

/** A transport command that worked and was confirmed by the client. */
function confirmedResult(
  result: ControlResult,
  before: number | null,
  after: number | null,
): ControlResult {
  return {
    ...result,
    confirmed: true,
    playingState: { before, after },
    message: `${result.message ?? result.via}（客户端已确认）`,
  };
}

/**
 * The `playingState` a command should end up at, or null when it cannot be judged.
 *
 * `playingState` is 1 = paused and 2 = playing (measured; see docs/contracts.md). Anything else -
 * no track loaded - means the client may legitimately not move, so nothing is asserted.
 */
function expectedPlayingState(command: ControlCommand, before: number | null): number | null {
  if (before !== 1 && before !== 2) return null;
  switch (command.type) {
    case 'play':
      return 2;
    case 'pause':
      return 1;
    case 'playPause':
      return before === 2 ? 1 : 2;
    default:
      // next / previous / volume / mute / mode do not have a single state to assert.
      return null;
  }
}
import { discover, type DiscoveryResult } from './discovery.ts';

const RECONNECT_MIN_MS = 2000;
const RECONNECT_MAX_MS = 10000;
const BRIDGE_HEALTH_INTERVAL_MS = 5000;
const DISCOVERY_RETRY_MS = 1500;
const DISCOVERY_MAX_ATTEMPTS = 10;

export interface ClientSessionEvents {
  snapshot: (snapshot: PlaybackSnapshot) => void;
  playhead: (playhead: Playhead, songId: number | null) => void;
  connection: (info: ConnectionInfo) => void;
  /** Forwarded verbatim from the client; the host decides what to do with it. */
  clientLyrics: (slice: ClientLyricSlice) => void;
  lyricsNeeded: (songId: number) => void;
  log: (level: 'debug' | 'info' | 'warn' | 'error', message: string) => void;
}

/** Shape of what the injected bridge reports. Kept loose on purpose. */
interface BridgeStatePayload {
  raw: Record<string, number | string | null>;
  songId: number | null;
  song: {
    id: number | null;
    name: string;
    artists: { id: number | null; name: string }[];
    albumName: string | null;
    coverUrl: string | null;
    durationMs: number | null;
    resourceType: string | null;
  };
  chorus: { startMs: number; endMs: number } | null;
  queue: { length: number; ids: number[]; index: number | null };
}

export declare interface ClientSession {
  on<E extends keyof ClientSessionEvents>(event: E, listener: ClientSessionEvents[E]): this;
  emit<E extends keyof ClientSessionEvents>(
    event: E,
    ...args: Parameters<ClientSessionEvents[E]>
  ): boolean;
}

// eslint-disable-next-line no-redeclare
export class ClientSession extends EventEmitter {
  private readonly port: number;
  private cdp: CdpSession | null = null;
  private discovery: DiscoveryResult | null = null;
  private bridgeAlive = false;
  private stopping = false;
  private connectedSince = Date.now();
  private reconnectDelay = RECONNECT_MIN_MS;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private healthTimer: NodeJS.Timeout | null = null;
  private discoveryTimer: NodeJS.Timeout | null = null;
  private lastSongId: number | null = null;
  private lastSnapshot: PlaybackSnapshot | null = null;
  private progressSamples = 0;

  constructor(port = DEFAULT_CDP_PORT) {
    super();
    this.port = port;
  }

  get connectionInfo(): ConnectionInfo {
    return toConnectionInfo(
      {
        state: this.bridgeAlive ? 'ready' : this.stopping ? 'disconnected' : 'connecting',
        port: this.port,
        clientProcessCount: 0,
        detail: this.bridgeAlive ? detailFor('ready') : detailFor('connecting'),
        lastError: null,
      },
      this.connectedSince,
    );
  }

  get currentSnapshot(): PlaybackSnapshot | null {
    return this.lastSnapshot;
  }

  get target(): CdpTarget | null {
    return this.cdp?.target ?? null;
  }

  get discoveryInfo(): DiscoveryResult | null {
    return this.discovery;
  }

  /** Start the connect/retry loop. Resolves as soon as the first attempt finishes. */
  async start(): Promise<void> {
    this.stopping = false;
    await this.attempt();
  }

  /** Stop cleanly, disposing the injected bridge so the client is left untouched. */
  async stop(): Promise<void> {
    this.stopping = true;
    this.clearTimers();
    const session = this.cdp;
    this.cdp = null;
    if (session) {
      try {
        await session.evaluate(
          '(() => { if (window.__moBridge && window.__moBridge.dispose) { window.__moBridge.dispose(); } return true; })()',
        );
      } catch {
        /* the page may already be gone */
      }
      session.close();
    }
    this.setBridgeAlive(false, '宿主已停止');
  }

  /** Push a control command through the bridge and wait briefly for its result. */
  async control(command: ControlCommand): Promise<ControlResult> {
    const session = this.cdp;
    if (!session || !this.bridgeAlive) {
      return {
        ok: false,
        command,
        via: 'none',
        message: '尚未连接到客户端，无法发送控制指令',
      };
    }

    const before = this.rawPlayingState();
    const result = await this.sendControl(session, command);
    if (!result.ok) return result;

    /*
     * Ask the client whether it actually did anything.
     *
     * `ok` only means the command reached the page and ran without throwing. A control surface that
     * silently does nothing - which is exactly what play/pause was suspected of, and why the
     * largest button on the card was dead - produces the same "success" as one that works. So the
     * play state is read again a moment later and reported alongside.
     */
    const expected = expectedPlayingState(command, before);
    if (expected === null) return result;

    const after = await this.waitForPlayingState(session, expected);
    if (after === expected) return confirmedResult(result, before, after);

    /* The confirmation window can expire a moment before a slow-but-working call lands. */
    const recheck = this.rawPlayingState();
    if (recheck === expected) return confirmedResult(result, before, recheck);

    /*
     * The client's audio module did not move it, so try the path a keyboard's play button uses.
     *
     * Measured: `setAudioPlayerPlay/Pause` runs without throwing and changes nothing. The media key
     * goes through the client's own global hotkey, which is the one control path already known to
     * work - and it is version-proof, because it does not depend on the client's internals at all.
     */
    const viaKey = await this.fallbackViaMediaKey(session, command, before, expected, after);
    if (viaKey) return viaKey;

    /*
     * Both paths failed, so stop guessing and ask the page why: the export arities, the dva action
     * names, and the client's own transport buttons are returned in the message and land in the
     * terminal.
     */
    const diagnosis = await this.diagnoseTransport(session);
    return {
      ...result,
      confirmed: false,
      playingState: { before, after },
      message:
        `${result.message ?? result.via}（客户端状态仍为 ${after ?? '未知'}）` +
        (diagnosis ? `；${diagnosis}` : ''),
    };
  }

  /**
   * Press the media key, if the client is still not where it was asked to be.
   *
   * The key *toggles*, so it is only pressed after re-reading the state: a pipeline call that was
   * merely slow, followed by a toggle, would land the client back where it started.
   */
  private async fallbackViaMediaKey(
    session: CdpSession,
    command: ControlCommand,
    before: number | null,
    expected: number,
    observed: number | null,
  ): Promise<ControlResult | null> {
    if (command.type !== 'playPause' && command.type !== 'play' && command.type !== 'pause') return null;
    if (this.rawPlayingState() === expected) return null;

    const pressed = pressMediaKey('playpause');
    if (!pressed.ok) {
      return {
        ok: false,
        command,
        via: 'none',
        confirmed: false,
        playingState: { before, after: observed },
        message: `音频管线没有生效，媒体键兜底也失败：${pressed.message}`,
      };
    }

    const after = await this.waitForPlayingState(session, expected);
    return {
      ok: true,
      command,
      via: 'media-key',
      confirmed: after === expected,
      playingState: { before, after },
      message:
        after === expected
          ? `${pressed.message}，客户端已确认`
          : `${pressed.message}，但客户端状态仍是 ${after ?? '未知'}`,
    };
  }

  /** Ask the page what its transport surfaces look like. Diagnostics only. */
  private async diagnoseTransport(session: CdpSession): Promise<string | null> {
    try {
      const result = await this.sendControl(session, { type: 'diagnoseTransport' });
      return result.ok ? (result.message ?? null) : null;
    } catch {
      return null;
    }
  }

  /** The client's raw `playingState`, straight from the last snapshot. */
  private rawPlayingState(): number | null {
    return this.lastSnapshot?.playback?.rawPlayingState ?? null;
  }

  /**
   * Wait for the client to reach an expected `playingState`, or give up.
   *
   * Polled from the snapshots the client is already pushing, so this costs no extra traffic.
   */
  private async waitForPlayingState(session: CdpSession, expected: number): Promise<number | null> {
    const deadline = Date.now() + CONTROL_CONFIRM_MS;
    let latest = this.rawPlayingState();
    while (Date.now() < deadline) {
      if (latest === expected) return latest;
      await delay(50);
      // A drop means the confirmation can no longer be judged; report what was last seen.
      if (this.cdp !== session) return latest;
      latest = this.rawPlayingState();
    }
    return latest;
  }

  /** Push the command and read its receipt from the page's result queue. */
  private async sendControl(session: CdpSession, command: ControlCommand): Promise<ControlResult> {
    const id = `c${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    try {
      await session.evaluate(
        `(() => {
          window.__moCmdQ = window.__moCmdQ || [];
          window.__moCmdQ.push(${JSON.stringify({ id, command })});
          return true;
        })()`,
      );
    } catch (err) {
      return {
        ok: false,
        command,
        via: 'none',
        message: `注入指令失败: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    const deadline = Date.now() + 1500;
    while (Date.now() < deadline) {
      await delay(60);
      let results: { id: string; ok: boolean; via: string; message?: string }[];
      try {
        results = await session.evaluateJson(commandResultPollExpression());
      } catch {
        break;
      }
      const hit = (results ?? []).find((r) => r?.id === id);
      if (hit) {
        return {
          ok: !!hit.ok,
          command,
          via: (hit.via?.split(':')[0] as ControlResult['via']) ?? 'none',
          message: hit.message ?? hit.via,
        };
      }
    }

    return { ok: false, command, via: 'none', message: '指令已发送，但没有收到执行回执' };
  }

  /* ------------------------------------------------------------ internals */
  private async attempt(): Promise<void> {
    if (this.stopping) return;

    this.connectedSince = Date.now();
    const diagnosis = await diagnose(this.port);
    this.emit('connection', toConnectionInfo(diagnosis, this.connectedSince));

    if (diagnosis.state !== 'ready') {
      this.emit('log', 'info', `客户端未就绪（${diagnosis.state}）：${diagnosis.detail}`);
      this.scheduleReconnect();
      return;
    }

    let session: CdpSession;
    try {
      session = await CdpSession.attach(this.port, {
        event: (method, params) => this.onCdpEvent(method, params),
        close: (reason) => this.onCdpClosed(reason),
      });
    } catch (err) {
      this.emit('log', 'warn', `附加 CDP 失败: ${err instanceof Error ? err.message : String(err)}`);
      this.scheduleReconnect();
      return;
    }

    this.cdp = session;
    this.emit('log', 'info', `已附加到客户端页面：${session.target.url}`);

    // Discovery can be flaky right after the client starts (modules load in
    // stages), so retry a few times before giving up.
    const found = await this.discoverWithRetry(session);
    if (!found?.ok || found.audioModuleId == null) {
      this.emit('log', 'warn', `模块发现失败: ${found?.reason ?? 'unknown'}`);
      this.disconnectSession('模块发现失败');
      this.scheduleReconnect();
      return;
    }

    this.discovery = found;
    this.emit(
      'log',
      'info',
      `发现完成：store 模块 ${found.storeModuleId}，音频模块 ${found.audioModuleId}，` +
        `require 块 ${found.requireChunkId}，共 ${found.moduleCount} 个模块`,
    );

    const injected = await this.injectBridge(session, found.audioModuleId);
    if (!injected.ok) {
      this.emit('log', 'warn', `注入桥接脚本失败: ${injected.reason ?? 'unknown'}`);
      this.disconnectSession('注入失败');
      this.scheduleReconnect();
      return;
    }

    this.reconnectDelay = RECONNECT_MIN_MS;
    this.setBridgeAlive(true, null);
    this.startHealthCheck();
    // The bridge deduplicates its output, so ask it to replay the current state
    // once - otherwise a UI attaching now would see nothing until something moves.
    await this.requestResend();
  }

  /**
   * Ask the bridge to re-send state and lyrics. Safe to call any time; returns
   * false when there is no live bridge.
   */
  async requestResend(): Promise<boolean> {
    const session = this.cdp;
    if (!session || session.isClosed || !this.bridgeAlive) return false;
    try {
      return (await session.evaluate<boolean>(bridgeResendExpression())) === true;
    } catch {
      return false;
    }
  }

  private async discoverWithRetry(session: CdpSession): Promise<DiscoveryResult | null> {
    let last: DiscoveryResult | null = null;
    for (let attempt = 1; attempt <= DISCOVERY_MAX_ATTEMPTS; attempt++) {
      if (this.stopping || session.isClosed) return last;
      last = await discover(session, { allowCache: attempt === 1 });
      if (last.ok && last.audioModuleId != null) return last;
      this.emit(
        'log',
        'debug',
        `发现第 ${attempt}/${DISCOVERY_MAX_ATTEMPTS} 次未成功：${last.reason ?? 'unknown'}`,
      );
      await delay(DISCOVERY_RETRY_MS);
    }
    return last;
  }

  private async injectBridge(
    session: CdpSession,
    audioModuleId: string,
  ): Promise<{ ok: boolean; reason?: string }> {
    const script = buildBridgeScript({ audioModuleId });
    const raw = await session.evaluate<string | { ok: boolean; reason?: string }>(script);
    if (typeof raw === 'string') {
      try {
        return JSON.parse(raw) as { ok: boolean; reason?: string };
      } catch {
        return { ok: false, reason: `无法解析注入结果: ${raw.slice(0, 120)}` };
      }
    }
    return raw ?? { ok: false, reason: '注入未返回结果' };
  }

  private startHealthCheck(): void {
    this.clearHealthTimer();
    this.healthTimer = setInterval(() => {
      void this.checkBridgeHealth();
    }, BRIDGE_HEALTH_INTERVAL_MS);
  }

  private async checkBridgeHealth(): Promise<void> {
    const session = this.cdp;
    if (!session || session.isClosed) return;
    try {
      const health = await session.evaluateJson<{ alive: boolean }>(bridgeHealthExpression());
      if (!health?.alive) {
        // The page navigated or the bridge was torn down: re-establish it.
        this.emit('log', 'debug', '桥接脚本已失效，正在重新注入');
        const found = this.discovery;
        if (!found?.audioModuleId) {
          this.disconnectSession('桥接失效且无发现缓存');
          return;
        }
        const reinject = await this.reinject(session, found);
        if (!reinject) {
          this.disconnectSession('重新注入失败');
        }
      }
    } catch (err) {
      this.emit('log', 'debug', `健康检查失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Re-run discovery if needed, then inject. Used after page navigation. */
  private async reinject(session: CdpSession, found: DiscoveryResult): Promise<boolean> {
    const needsRequire = await session.evaluate<boolean>(
      'typeof window.__moRequire === "function"',
    );
    if (!needsRequire) {
      const redo = await this.discoverWithRetry(session);
      if (!redo?.ok || redo.audioModuleId == null) return false;
      this.discovery = redo;
      found = redo;
    }
    const injected = await this.injectBridge(session, found.audioModuleId!);
    if (injected.ok) {
      this.setBridgeAlive(true, null);
      return true;
    }
    return false;
  }

  private onCdpEvent(method: string, params: any): void {
    if (method !== 'Runtime.consoleAPICalled') return;
    const args: any[] = params?.args ?? [];
    if (!args.length) return;
    const first = args[0];
    const text: unknown = first?.value;
    if (typeof text !== 'string' || !text.startsWith(BRIDGE_PREFIX)) return;

    let envelope: { kind: string; payload: any; t: number };
    try {
      envelope = JSON.parse(text.slice(BRIDGE_PREFIX.length));
    } catch {
      return;
    }

    switch (envelope.kind) {
      case 'ready':
        this.progressSamples = 0;
        this.emit(
          'log',
          'info',
          `桥接就绪（音频模块 ${envelope.payload?.audioModuleId}）`,
        );
        break;

      case 'state':
        this.onBridgeState(envelope.payload as BridgeStatePayload);
        break;

      case 'progress':
        this.onBridgeProgress(envelope.payload);
        break;

      case 'lyrics':
        this.emit('clientLyrics', envelope.payload as ClientLyricSlice);
        break;

      case 'warn':
        this.emit('log', 'warn', `桥接警告: ${JSON.stringify(envelope.payload)}`);
        break;

      case 'commandResult':
        this.emit('log', 'debug', `控制回执: ${JSON.stringify(envelope.payload)}`);
        break;

      default:
        this.emit('log', 'debug', `未知桥接事件: ${envelope.kind}`);
    }
  }

  private onBridgeState(payload: BridgeStatePayload): void {
    if (!payload) return;
    const songId = toSongId(payload.songId);
    const previousSongId = this.lastSongId;
    const song: Song = {
      id: songId,
      name: payload.song?.name ?? '',
      artists: Array.isArray(payload.song?.artists) ? payload.song.artists : [],
      albumName: payload.song?.albumName ?? null,
      coverUrl: payload.song?.coverUrl ?? null,
      durationMs: payload.song?.durationMs ?? null,
      resourceType: payload.song?.resourceType ?? null,
    };

    const raw = payload.raw ?? {};
    const status: PlaybackStatus = rawPlayingStateToStatus(raw.playingState as number | null);
    const playback: Playback = {
      status,
      rawPlayingState: (raw.playingState as number | null) ?? null,
      mode: (raw.playingMode as PlayMode | null) ?? null,
      volume: (raw.playingVolume as number | null) ?? null,
      muted: raw.muteVolume != null ? Number(raw.muteVolume) > 0 : null,
      speed: (raw.playingSpeed as number | null) ?? null,
    };

    const queue: QueueInfo = {
      length: payload.queue?.length ?? 0,
      ids: Array.isArray(payload.queue?.ids) ? payload.queue.ids : [],
      index: payload.queue?.index ?? null,
    };

    const snapshot: PlaybackSnapshot = {
      song: songId == null && !song.name ? null : song,
      playback,
      playhead: this.lastSnapshot?.playhead ?? null,
      queue,
      chorus: payload.chorus ?? null,
      // The UI extracts its palette from the cover image it already loads (the
      // image CDN allows cross-origin reads), so the host does not compute one.
      // The field stays in the contract for a future client-side palette source.
      palette: null,
      lyricLine: (raw.lyricLineNumber as number | null) ?? null,
    };

    this.lastSnapshot = snapshot;
    this.emit('snapshot', snapshot);

    if (songId !== previousSongId) {
      this.lastSongId = songId;
      this.progressSamples = 0;
      if (songId != null) this.emit('lyricsNeeded', songId);
    }
  }

  private onBridgeProgress(payload: {
    playId: string | null;
    positionMs: number;
    rawState: number | null;
    count: number;
  }): void {
    if (!payload || typeof payload.positionMs !== 'number') return;
    this.progressSamples++;

    const playhead: Playhead = {
      positionMs: payload.positionMs,
      playId: payload.playId ?? null,
      at: Date.now(),
      sampleCount: payload.count ?? this.progressSamples,
    };

    if (this.lastSnapshot) {
      this.lastSnapshot = { ...this.lastSnapshot, playhead };
    }

    this.emit('playhead', playhead, this.lastSongId);
  }

  private onCdpClosed(reason: string): void {
    if (this.cdp?.closedBecause === reason) {
      this.cdp = null;
    }
    this.setBridgeAlive(false, reason);
    if (!this.stopping) {
      this.emit('log', 'warn', `CDP 会话断开（${reason}）`);
      this.scheduleReconnect();
    }
  }

  private disconnectSession(reason: string): void {
    this.clearHealthTimer();
    const session = this.cdp;
    this.cdp = null;
    this.setBridgeAlive(false, reason);
    try {
      session?.close();
    } catch {
      /* ignore */
    }
  }

  private setBridgeAlive(alive: boolean, reason: string | null): void {
    if (this.bridgeAlive === alive) return;
    this.bridgeAlive = alive;
    this.emit('connection', {
      state: alive ? 'ready' : this.stopping ? 'disconnected' : 'connecting',
      port: this.port,
      clientProcessCount: 0,
      detail: alive ? detailFor('ready') : detailFor('connecting'),
      lastError: reason,
      since: Date.now(),
    });
  }

  private scheduleReconnect(): void {
    if (this.stopping || this.reconnectTimer) return;
    const wait = this.reconnectDelay;
    this.reconnectDelay = Math.min(this.reconnectDelay * 1.5, RECONNECT_MAX_MS);
    this.emit('log', 'info', `${Math.round(wait / 1000)} 秒后重试连接`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.attempt();
    }, wait);
  }

  private clearTimers(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.clearHealthTimer();
    if (this.discoveryTimer) {
      clearTimeout(this.discoveryTimer);
      this.discoveryTimer = null;
    }
  }

  private clearHealthTimer(): void {
    if (this.healthTimer) {
      clearInterval(this.healthTimer);
      this.healthTimer = null;
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
