/**
 * Public entry point for the host package.
 *
 * `createHost` wires the two halves together: the client-facing session (CDP ->
 * discovery -> injected bridge) and the overlay-facing loopback WebSocket server.
 * Everything the overlay needs arrives as messages; nothing else crosses the
 * boundary.
 */

import { EventEmitter } from 'node:events';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  LoopbackWebSocketServer,
  type ClientMessage,
  type ControlCommand,
  type ControlResult,
  type HostMessage,
  type LyricDoc,
  type PlaybackSnapshot,
} from '../../shared/src/index.ts';

import { DEFAULT_CDP_PORT } from './cdp.ts';
import { LyricsService, type LyricsServiceOptions } from './lyrics.ts';
import { ClientSession } from './session.ts';
import { UiServer } from './ui-server.ts';

export const HOST_VERSION = '0.1.0';
export const DEFAULT_HOST_PORT = 8787;
export const DEFAULT_UI_PORT = 8788;
export const PROTOCOL_VERSION = 1;

/** Works from source (packages/host/src) and from a built/asar bundle alike. */
function defaultUiRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // packages/host/src -> repository root
  return resolve(here, '..', '..', '..', 'ui');
}

export interface HostOptions {
  cdpPort?: number;
  hostPort?: number;
  /** Port for the static overlay UI. Pass 0 to disable serving the UI. */
  uiPort?: number;
  /** Where the UI lives. Defaults to <repo>/ui. */
  uiRoot?: string;
  /**
   * Override the lyrics source. Defaults to the built-in LyricsService, which
   * prefers the client's own lyric document and falls back to the public API.
   */
  lyrics?: Pick<LyricsService, 'start' | 'get' | 'refresh' | 'prune' | 'stop'> | LyricsService;
  log?: (level: 'debug' | 'info' | 'warn' | 'error', message: string) => void;
}

export interface Host {
  start(): Promise<void>;
  stop(): Promise<void>;
  control(command: ControlCommand): Promise<ControlResult>;
  currentSnapshot(): PlaybackSnapshot | null;
  clientCount(): number;
  /** URL of the static overlay UI, or null when UI serving is disabled. */
  uiUrl(): string | null;
  on(event: 'log', listener: (level: string, message: string) => void): void;
}

export function createHost(options: HostOptions = {}): Host {
  const cdpPort = options.cdpPort ?? DEFAULT_CDP_PORT;
  const hostPort = options.hostPort ?? DEFAULT_HOST_PORT;
  const uiPort = options.uiPort ?? DEFAULT_UI_PORT;
  const log = options.log ?? (() => {});

  const emitter = new EventEmitter();
  const session = new ClientSession(cdpPort);
  const server = new LoopbackWebSocketServer({ port: hostPort });
  const ui =
    uiPort > 0
      ? new UiServer({
          port: uiPort,
          root: options.uiRoot ?? defaultUiRoot(),
          config: { hostPort, hostVersion: HOST_VERSION, protocol: PROTOCOL_VERSION },
          log: (level, message) => log(level, message),
        })
      : null;

  const broadcast = (message: HostMessage): void => {
    if (server.clientCount === 0) return;
    server.broadcast(message);
  };

  // Lyrics come from the shared service; it pushes documents as they resolve.
  const lyrics: LyricsService =
    options.lyrics instanceof LyricsService
      ? options.lyrics
      : new LyricsService({
          session,
          log: (level, message) => session.emit('log', level, message),
          onDoc: (doc) => broadcast({ kind: 'lyrics', doc }),
        } satisfies LyricsServiceOptions);

  session.on('snapshot', (snapshot: PlaybackSnapshot) => {
    broadcast({ kind: 'snapshot', snapshot });
    // The service decides whether this needs work (it coalesces and caches).
    const songId = snapshot.song?.id;
    if (songId != null) {
      const cached = lyrics.get(songId);
      if (cached) broadcast({ kind: 'lyrics', doc: cached });
    }
  });

  session.on('playhead', (playhead, songId) => {
    broadcast({ kind: 'playhead', playhead, songId });
  });

  session.on('connection', (connection) => {
    broadcast({ kind: 'connection', connection });
  });

  session.on('log', (level, message) => {
    log(level, message);
    emitter.emit('log', level, message);
  });

  server.on('connection', () => {
    log('info', `界面已连接（当前 ${server.clientCount} 个）`);
    broadcast({
      kind: 'hello',
      protocol: PROTOCOL_VERSION,
      hostVersion: HOST_VERSION,
      at: Date.now(),
    });
    const snapshot = session.currentSnapshot;
    if (snapshot) broadcast({ kind: 'snapshot', snapshot });
    broadcast({ kind: 'connection', connection: session.connectionInfo });
    // Ask the client bridge to replay state + lyrics for the newcomer.
    void session.requestResend();
  });

  server.on('disconnect', () => {
    log('info', `界面断开（剩余 ${server.clientCount} 个）`);
  });

  server.on('message', (raw: unknown) => {
    void handleClientMessage(raw as ClientMessage);
  });

  server.on('invalid', (_peer: unknown, text: string) => {
    log('warn', `忽略无法解析的界面消息: ${text.slice(0, 120)}`);
  });

  async function handleClientMessage(message: ClientMessage): Promise<void> {
    switch (message?.kind) {
      case 'control': {
        const result = await session.control(message.command);
        /*
         * The confirmation is the interesting half of the log line: `成功` only means the command
         * reached the page. `未确认` means the client was told to change state and did not - which
         * is the difference between a working control and a dead one, and it is exactly what the
         * play/pause deck was before it was wired up.
         */
        const verdict = !result.ok ? '失败' : result.confirmed === false ? '未确认' : '成功';
        const state =
          result.playingState && result.playingState.before !== null
            ? `，playingState ${result.playingState.before} → ${result.playingState.after ?? '?'}`
            : '';
        const good = result.ok && result.confirmed !== false;
        log(good ? 'info' : 'warn', `控制指令 ${message.command.type} → ${verdict} (${result.via})${state}`);
        /*
         * The message carries the *why*, and on a failure it also carries the page's diagnosis of
         * the client's transport surfaces. Logging it here means the terminal is enough to explain a
         * control that ran and did nothing - otherwise the only copy would be in the overlay's
         * console, one indirection away.
         */
        if (!good && result.message) log('warn', `  ${result.message}`);
        broadcast({ kind: 'controlResult', result });
        break;
      }
      case 'requestSnapshot': {
        const snapshot = session.currentSnapshot;
        if (snapshot) broadcast({ kind: 'snapshot', snapshot });
        broadcast({ kind: 'connection', connection: session.connectionInfo });
        break;
      }
      case 'requestLyrics': {
        const songId = message.songId ?? session.currentSnapshot?.song?.id ?? null;
        if (songId != null) {
          const cached = lyrics.get(songId);
          if (cached) broadcast({ kind: 'lyrics', doc: cached });
          else {
            const fresh = await lyrics.refresh(songId).catch(() => null);
            if (fresh) broadcast({ kind: 'lyrics', doc: fresh });
          }
        }
        break;
      }
      default:
        log('warn', `未知的界面消息: ${JSON.stringify(message)}`);
    }
  }

  return {
    async start() {
      await server.listen();
      log('info', `宿主已监听 ws://127.0.0.1:${hostPort}`);
      if (ui) {
        await ui.listen();
        log('info', `界面地址 ${ui.url}`);
      }
      lyrics.start();
      const pruned = lyrics.prune();
      if (pruned.removed) {
        log('info', `清理过期歌词缓存 ${pruned.removed} 条，保留 ${pruned.kept} 条`);
      }
      await session.start();
    },
    async stop() {
      // Release the lyrics service's timers first, or the process would not exit.
      lyrics.stop();
      await session.stop();
      await server.close();
      await ui?.close();
    },
    control: (command) => session.control(command),
    currentSnapshot: () => session.currentSnapshot,
    clientCount: () => server.clientCount,
    uiUrl: () => ui?.url ?? null,
    on(event, listener) {
      emitter.on(event, listener as (...args: any[]) => void);
    },
  };
}
