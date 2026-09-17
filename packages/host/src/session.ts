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
import { pressMediaKey, type MediaKey } from './media-key.ts';

/**
 * The media key each transport command is sent as.
 *
 * The bridge has cases for all of these and they were measured not to work, so they are not tried:
 * a second attempt after a media key would be a *second* skip if the key did land, and a
 * double-skip is worse than a control that reports failure.
 */
const MEDIA_KEY_FOR: Partial<Record<ControlCommand['type'], MediaKey>> = {
  playPause: 'playpause',
  play: 'playpause',
  pause: 'playpause',
  next: 'next',
  previous: 'prev',
};

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
 * What the client should look like after a command, or null when it cannot be judged.
 *
 * `playingState` is 1 = paused and 2 = playing (measured; see docs/contracts.md). Anything else -
 * no track loaded - means the client may legitimately not move, so nothing is asserted. Volume,
 * mode and position *can* be asserted, and are: each of them has an observable field, and a
 * control that writes the wrong one (which is exactly what `playing/setVolume` does) looks
 * identical to a working one until something reads the field back.
 */
interface Expectation {
  /** How the expectation reads in a log line. */
  describe: string;
  /** Whether the observation the host can make now satisfies the command. */
  matches: (session: ClientSession, result: ControlResult) => boolean;
}

function expectationFor(command: ControlCommand, snapshot: PlaybackSnapshot | null): Expectation | null {
  const raw = snapshot?.playback.rawPlayingState ?? null;
  const volume = snapshot?.playback.volume ?? null;
  const mode = snapshot?.playback.mode ?? null;
  const positionMs = snapshot?.playhead?.positionMs ?? null;

  switch (command.type) {
    case 'play':
      return raw === 1 || raw === 2 ? { describe: 'playingState 2', matches: (s) => s.rawPlayingState() === 2 } : null;
    case 'pause':
      return raw === 1 || raw === 2 ? { describe: 'playingState 1', matches: (s) => s.rawPlayingState() === 1 } : null;
    case 'playPause':
      if (raw !== 1 && raw !== 2) return null;
      return raw === 2
        ? { describe: 'playingState 1', matches: (s) => s.rawPlayingState() === 1 }
        : { describe: 'playingState 2', matches: (s) => s.rawPlayingState() === 2 };
    case 'setVolume':
      return {
        describe: `音量 ${command.volume.toFixed(2)}`,
        // The client stores a float32, so 0.35 comes back as 0.34999999... A tolerance, not equality.
        matches: (s) => {
          const now = s.volume();
          return now != null && Math.abs(now - command.volume) < 0.02;
        },
      };
    case 'toggleMute':
      if (volume == null) return null;
      return volume > 0
        ? { describe: '音量 0', matches: (s) => s.volume() === 0 }
        : { describe: '音量恢复', matches: (s) => (s.volume() ?? 0) > 0 };
    case 'setMode':
      return {
        describe: `播放模式 ${command.mode}`,
        matches: (s) => s.mode() === command.mode,
      };
    case 'seek':
      return {
        describe: `播放位置约 ${Math.round(command.positionMs / 1000)}s`,
        /*
         * The receipt is the client's own reply - `{code: 0, position}` - so it counts even before
         * the next progress sample arrives. Otherwise the playhead is compared with a tolerance:
         * playback continues while the check runs, and a second of drift is the clock, not a miss.
         */
        matches: (s, result) => {
          if (result.positionMs != null) {
            return Math.abs(result.positionMs - command.positionMs) < 1500;
          }
          const now = s.positionMs();
          if (now == null) return false;
          if (positionMs != null && Math.abs(now - positionMs) < 500) return false; // never moved
          return Math.abs(now - command.positionMs) < 2500;
        },
      };
    default:
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

  /**
   * Run a control command.
   *
   * The transport commands go out as **media keys**, and the rest go through the bridge.
   *
   * That is not the design this started with. Both of the bridge's routes were measured against a
   * running client and neither moves it:
   *
   *  - `setAudioPlayerPlay`/`setAudioPlayerPause` run without throwing and change nothing;
   *  - `dispatch({ type: 'playing/playNextOrPrev' })` returns a perfectly good action object, so the
   *    receipt says `ok: true`, and the track does not change. `docs/contracts.md` section 6 called
   *    skip-to-next "solved" on the strength of that receipt, which is exactly the trap this
   *    function's confirmation was added to close.
   *
   * A media key is the path a keyboard's play button uses - the client's own global hotkey - so it
   * does not depend on the client's internals, and it is the one transport mechanism that cannot
   * break when the client is updated. It is therefore the primary, not a fallback. The bridge's
   * routes are kept for `setVolume`, `toggleMute` and `setMode`, which have no media-key equivalent.
   */
  async control(command: ControlCommand): Promise<ControlResult> {
    const session = this.cdp;
    if (!session || !this.bridgeAlive) {
      return {
        ok: false,
        command,
        via: 'none',
        message: '还没连上客户端，无法发送指令',
      };
    }

    const key = MEDIA_KEY_FOR[command.type];
    if (!key) return this.controlViaBridge(session, command);

    const before = this.rawPlayingState();
    const beforeSongId = this.currentSongId();
    const beforePositionMs = this.lastSnapshot?.playhead?.positionMs ?? 0;
    const expectedState =
      command.type === 'playPause' ? (before === 2 ? 1 : 2) : command.type === 'play' ? 2 : 1;

    const pressed = pressMediaKey(key);
    if (!pressed.ok) {
      return {
        ok: false,
        command,
        via: 'none',
        confirmed: false,
        playingState: { before, after: before },
        message: `媒体键发送失败：${pressed.message}`,
      };
    }

    const changed = await this.waitForTransportEffect(
      session,
      expectedState,
      beforeSongId,
      beforePositionMs,
    );
    const after = this.rawPlayingState();

    if (changed) {
      return {
        ok: true,
        command,
        via: 'media-key',
        confirmed: true,
        playingState: { before, after },
        message: `${pressed.message}，客户端已确认`,
      };
    }

    /*
     * The key went out and the client did not move. Two things can be true, and they need
     * different fixes, so both are reported: nothing has the media hotkey registered (the client
     * has a global-hotkey option, and it may be off), or something else consumed the key.
     */
    const diagnosis = await this.diagnoseTransport(session);
    return {
      ok: false,
      command,
      via: 'media-key',
      confirmed: false,
      playingState: { before, after },
      message:
        `${pressed.message}，但客户端没有变化（playingState ${before ?? '?'} → ${after ?? '?'}` +
        (beforeSongId !== null ? `，歌曲仍为 ${beforeSongId}` : '') +
        '）；可能被全局快捷键或其它程序接管' +
        (diagnosis ? `；${diagnosis}` : ''),
    };
  }

  /**
   * The bridge route: everything without a media-key equivalent, and the only route to the audio
   * wrapper for volume and position.
   *
   * `ok` only means the command reached the page and ran without throwing, and an action that
   * changes nothing (or the wrong field) returns exactly that - `playing/setVolume` is a working
   * action that does not move the volume. So whatever the command asked for is read back before the
   * result is called confirmed.
   */
  private async controlViaBridge(session: CdpSession, command: ControlCommand): Promise<ControlResult> {
    const before = this.rawPlayingState();
    const expectation = expectationFor(command, this.lastSnapshot);
    const result = await this.sendControl(session, command);
    if (!result.ok) {
      return { ...result, confirmed: false, playingState: { before, after: this.rawPlayingState() } };
    }

    /*
     * A deferred command did not happen yet, so there is nothing to observe: a seek asked for while
     * the client is paused is applied when playback resumes. Reporting it as unconfirmed would have
     * the card warn about - and undo - a jump that is going to happen.
     */
    if (result.deferred) {
      return { ...result, confirmed: undefined, playingState: { before, after: this.rawPlayingState() } };
    }

    if (!expectation) {
      // Nothing observable to assert: report the receipt and say so rather than guessing.
      return { ...result, confirmed: undefined, playingState: { before, after: this.rawPlayingState() } };
    }

    const observed = await this.waitFor(expectation, result);
    const after = this.rawPlayingState();
    if (observed) return confirmedResult(result, before, after);

    const diagnosis = await this.diagnoseTransport(session);
    return {
      ...result,
      confirmed: false,
      playingState: { before, after },
      message:
        `${result.message ?? result.via}（客户端没有变成${expectation.describe}）` +
        (diagnosis ? `；${diagnosis}` : ''),
    };
  }

  /** Poll the expectation against the snapshots the client is already pushing. */
  private async waitFor(expectation: Expectation, result: ControlResult): Promise<boolean> {
    const deadline = Date.now() + CONTROL_CONFIRM_MS;
    while (Date.now() < deadline) {
      if (expectation.matches(this, result)) return true;
      await delay(50);
    }
    return expectation.matches(this, result);
  }

  /** The song id of the last snapshot, or null. */
  private currentSongId(): number | null {
    return this.lastSnapshot?.song?.id ?? null;
  }

  /**
   * Wait for a transport command to show *some* effect on the client.
   *
   * Several signals, because one does not fit all three commands: a play/pause flips `playingState`,
   * a skip changes the song, and a skip in repeat-one mode changes neither - it restarts the same
   * song, which shows up as the playhead jumping backwards.
   */
  private async waitForTransportEffect(
    session: CdpSession,
    expectedState: number | null,
    beforeSongId: number | null,
    beforePositionMs: number,
  ): Promise<boolean> {
    const deadline = Date.now() + CONTROL_CONFIRM_MS;
    while (Date.now() < deadline) {
      if (this.cdp !== session) return false;
      if (expectedState !== null && this.rawPlayingState() === expectedState) return true;
      if (beforeSongId !== null && this.currentSongId() !== beforeSongId) return true;
      const position = this.lastSnapshot?.playhead?.positionMs ?? 0;
      if (beforePositionMs > 3000 && position < beforePositionMs - 1000) return true;
      await delay(50);
    }
    return false;
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
  rawPlayingState(): number | null {
    return this.lastSnapshot?.playback?.rawPlayingState ?? null;
  }

  /*
   * Read-only views of the last snapshot, for the expectations above.
   *
   * Deliberately public and deliberately dumb: they read the *client's* last reported value, so an
   * expectation can never be satisfied by the overlay's own optimistic state.
   */

  /** The client's current volume, 0..1, or null. */
  volume(): number | null {
    return this.lastSnapshot?.playback?.volume ?? null;
  }

  /** The client's current play mode, or null. */
  mode(): string | null {
    return this.lastSnapshot?.playback?.mode ?? null;
  }

  /** The last playhead the client published, in milliseconds, or null. */
  positionMs(): number | null {
    return this.lastSnapshot?.playhead?.positionMs ?? null;
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
      let results: {
        id: string;
        ok: boolean;
        via: string;
        message?: string;
        positionMs?: number | null;
        deferred?: boolean;
      }[];
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
          positionMs: hit.positionMs ?? null,
          deferred: hit.deferred === true,
        };
      }
    }

    return { ok: false, command, via: 'none', message: '指令已发出，没收到回执' };
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
      const health = await session.evaluateJson<{ alive: boolean; id?: string }>(
        bridgeHealthExpression(),
      );
      if (!health?.alive) {
        // The page navigated or the bridge was torn down: re-establish it.
        this.emit('log', 'debug', '桥接脚本失效，重新注入');
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
        /*
         * The build id is printed because it is the only evidence that the page is running the
         * injection the host just made. When it was not, every play/pause press answered
         * `unsupported command: playPause` from code that no longer existed in the source, and
         * nothing in the log said which copy had replied.
         */
        this.emit(
          'log',
          'info',
          `桥接就绪（音频模块 ${envelope.payload?.audioModuleId}，桥接 ${envelope.payload?.bridgeId ?? '未知'}）`,
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
    const volume = (raw.playingVolume as number | null) ?? null;
    const playback: Playback = {
      status,
      rawPlayingState: (raw.playingState as number | null) ?? null,
      mode: (raw.playingMode as PlayMode | null) ?? null,
      volume,
      /*
       * Muted means the volume is zero - *not* `muteVolume > 0`.
       *
       * `muteVolume` is the value the client remembers so it can restore it, measured from its own
       * mute effect: muting puts `{muteVolume: playingVolume}` and then sets the volume to 0, and
       * unmuting restores the volume without clearing `muteVolume`. So it is > 0 both before and
       * after a mute - the earlier mapping read it as "muted", which drew a silenced card for a
       * track playing at full volume.
       */
      muted: volume == null ? null : volume <= 0.001,
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
