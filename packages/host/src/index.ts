/**
 * Public entry point for the host package.
 *
 * `createHost` wires the two halves together: the client-facing session (CDP ->
 * discovery -> injected bridge) and the overlay-facing loopback WebSocket server.
 * Everything the overlay needs arrives as messages; nothing else crosses the
 * boundary.
 */

import { EventEmitter } from 'node:events';

import {
  LoopbackWebSocketServer,
  type ClientMessage,
  type ControlCommand,
  type ControlResult,
  type HostMessage,
  type LyricDoc,
  type PlaybackSnapshot,
} from '@music-overlay/shared';

import { DEFAULT_CDP_PORT } from './cdp.ts';
import { ClientSession } from './session.ts';

export const HOST_VERSION = '0.1.0';
export const DEFAULT_HOST_PORT = 8787;
export const PROTOCOL_VERSION = 1;

export interface HostOptions {
  cdpPort?: number;
  hostPort?: number;
  /** Resolve lyrics for a song id. Injected so the host stays testable. */
  lyricsProvider?: (songId: number) => Promise<LyricDoc | null>;
  log?: (level: 'debug' | 'info' | 'warn' | 'error', message: string) => void;
}

export interface Host {
  start(): Promise<void>;
  stop(): Promise<void>;
  control(command: ControlCommand): Promise<ControlResult>;
  currentSnapshot(): PlaybackSnapshot | null;
  clientCount(): number;
  on(event: 'log', listener: (level: string, message: string) => void): void;
}

export function createHost(options: HostOptions = {}): Host {
  const cdpPort = options.cdpPort ?? DEFAULT_CDP_PORT;
  const hostPort = options.hostPort ?? DEFAULT_HOST_PORT;
  const log = options.log ?? (() => {});

  const emitter = new EventEmitter();
  const session = new ClientSession(cdpPort);
  const server = new LoopbackWebSocketServer({ port: hostPort });

  const broadcast = (message: HostMessage): void => {
    if (server.clientCount === 0) return;
    server.broadcast(message);
  };

  session.on('snapshot', (snapshot: PlaybackSnapshot) => {
    broadcast({ kind: 'snapshot', snapshot });
    const songId = snapshot.song?.id;
    if (songId != null && options.lyricsProvider) {
      void options.lyricsProvider(songId)
        .then((doc) => {
          if (doc) broadcast({ kind: 'lyrics', doc });
        })
        .catch((err) => {
          log('warn', `歌词获取失败(${songId}): ${err instanceof Error ? err.message : String(err)}`);
        });
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
        log('info', `控制指令 ${message.command.type} → ${result.ok ? '成功' : '失败'} (${result.via})`);
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
        if (songId != null && options.lyricsProvider) {
          const doc = await options.lyricsProvider(songId).catch(() => null);
          if (doc) broadcast({ kind: 'lyrics', doc });
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
      await session.start();
    },
    async stop() {
      await session.stop();
      await server.close();
    },
    control: (command) => session.control(command),
    currentSnapshot: () => session.currentSnapshot,
    clientCount: () => server.clientCount,
    on(event, listener) {
      emitter.on(event, listener as (...args: any[]) => void);
    },
  };
}
