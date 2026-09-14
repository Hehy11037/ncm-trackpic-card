/**
 * Minimal RFC6455 WebSocket server restricted to loopback, used to push host
 * messages to overlay clients.
 *
 * Why hand-rolled rather than the `ws` package: the client-facing broadcast needs
 * only loopback text frames, and keeping it dependency-free means the host can run
 * from a plain `node` invocation during development (no install step) and cannot
 * drift on a dependency's API. `ws` is still used for the CDP connection, because
 * that one needs custom handshake headers.
 *
 * Scope: text frames, ping/pong, close. No extensions, no compression, no
 * fragmentation of outgoing frames (payloads here are small), inbound fragments
 * are reassembled.
 */

import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { Duplex } from 'node:stream';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

const OPCODE = {
  CONTINUATION: 0x0,
  TEXT: 0x1,
  BINARY: 0x2,
  CLOSE: 0x8,
  PING: 0x9,
  PONG: 0xa,
} as const;

/** Largest inbound message we will assemble, to bound memory. */
const MAX_MESSAGE_BYTES = 4 * 1024 * 1024;

interface SocketState {
  socket: Duplex;
  buffer: Buffer;
  fragments: Buffer[];
  fragmentBytes: number;
  fragmentOpcode: number;
  closed: boolean;
}

export interface LoopbackServerOptions {
  port: number;
  /** Defaults to 127.0.0.1. Never expose this beyond loopback. */
  host?: string;
}

export class LoopbackWebSocketServer extends EventEmitter {
  private readonly port: number;
  private readonly host: string;
  private server: Server | null = null;
  private readonly peers = new Set<SocketState>();

  constructor(options: LoopbackServerOptions) {
    super();
    this.port = options.port;
    this.host = options.host ?? '127.0.0.1';
  }

  async listen(): Promise<void> {
    if (this.server) return;
    this.server = createServer((_req, res) => {
      // Plain HTTP requests on this port are a mistake; say so clearly.
      res.writeHead(426, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('This endpoint only accepts WebSocket upgrades.\n');
    });

    this.server.on('upgrade', (req, socket, head) => {
      this.handleUpgrade(req, socket as Duplex, head);
    });

    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error) => reject(err);
      this.server!.once('error', onError);
      this.server!.listen(this.port, this.host, () => {
        this.server!.off('error', onError);
        resolve();
      });
    }).catch((err) => {
      if ((err as NodeJS.ErrnoException).code === 'EADDRINUSE') {
        throw new Error(
          `端口 ${this.port} 已被占用（可能已经有一个宿主在运行）。请先关闭它，或用 --port 换一个端口。`,
        );
      }
      throw err;
    });
  }

  async close(): Promise<void> {
    for (const peer of this.peers) {
      this.destroyPeer(peer, 0x3e9, 'server shutting down'); // 1001 going away
    }
    this.peers.clear();
    if (!this.server) return;
    const server = this.server;
    this.server = null;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  get clientCount(): number {
    return this.peers.size;
  }

  /** Send a JSON message to every connected client. */
  broadcast(message: unknown): number {
    const payload = Buffer.from(JSON.stringify(message), 'utf8');
    let sent = 0;
    for (const peer of this.peers) {
      if (peer.closed) continue;
      try {
        peer.socket.write(encodeFrame(OPCODE.TEXT, payload));
        sent++;
      } catch {
        this.destroyPeer(peer, 0x3eb, 'write failed');
      }
    }
    return sent;
  }

  private handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const key = req.headers['sec-websocket-key'];
    const upgrade = String(req.headers.upgrade ?? '').toLowerCase();

    if (upgrade !== 'websocket' || typeof key !== 'string' || !key) {
      socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
      return;
    }

    // Only loopback peers are accepted. Overlay clients connect from a local
    // Electron renderer, so anything remote is a bug or an attack.
    // `remoteAddress` lives on net.Socket; the upgrade handler types it as Duplex.
    const remote = (socket as Duplex & { remoteAddress?: string }).remoteAddress ?? '';
    if (!isLoopback(remote)) {
      socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
      return;
    }

    const accept = createHash('sha1').update(key + GUID).digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );

    const peer: SocketState = {
      socket,
      buffer: head && head.length ? Buffer.from(head) : Buffer.alloc(0),
      fragments: [],
      fragmentBytes: 0,
      fragmentOpcode: 0,
      closed: false,
    };
    this.peers.add(peer);
    this.emit('connection', peer);

    socket.on('data', (chunk: Buffer) => this.onData(peer, chunk));
    socket.on('error', () => this.destroyPeer(peer, 0x3ea, 'socket error'));
    socket.on('close', () => {
      peer.closed = true;
      this.peers.delete(peer);
      this.emit('disconnect', peer);
    });

    // Process any bytes that arrived with the handshake.
    if (peer.buffer.length) this.drain(peer);
  }

  private onData(peer: SocketState, chunk: Buffer): void {
    if (peer.closed) return;
    peer.buffer = peer.buffer.length ? Buffer.concat([peer.buffer, chunk]) : chunk;
    this.drain(peer);
  }

  private drain(peer: SocketState): void {
    for (;;) {
      const frame = decodeFrame(peer.buffer);
      if (!frame) return;
      peer.buffer = peer.buffer.subarray(frame.consumed);

      switch (frame.opcode) {
        case OPCODE.TEXT:
        case OPCODE.BINARY:
          if (frame.fin) {
            this.emitMessage(peer, frame.payload, frame.opcode);
          } else {
            peer.fragments = [frame.payload];
            peer.fragmentBytes = frame.payload.length;
            peer.fragmentOpcode = frame.opcode;
          }
          break;

        case OPCODE.CONTINUATION: {
          peer.fragments.push(frame.payload);
          peer.fragmentBytes += frame.payload.length;
          if (peer.fragmentBytes > MAX_MESSAGE_BYTES) {
            this.destroyPeer(peer, 0x3e9, 'message too large');
            return;
          }
          if (frame.fin) {
            const assembled = Buffer.concat(peer.fragments, peer.fragmentBytes);
            const opcode = peer.fragmentOpcode;
            peer.fragments = [];
            peer.fragmentBytes = 0;
            peer.fragmentOpcode = 0;
            this.emitMessage(peer, assembled, opcode);
          }
          break;
        }

        case OPCODE.PING:
          try {
            peer.socket.write(encodeFrame(OPCODE.PONG, frame.payload));
          } catch {
            this.destroyPeer(peer, 0x3ea, 'pong failed');
            return;
          }
          break;

        case OPCODE.PONG:
          break;

        case OPCODE.CLOSE:
          this.destroyPeer(peer, 0x3e8, 'closed by client');
          return;

        default:
          this.destroyPeer(peer, 0x3ea, `unsupported opcode ${frame.opcode}`);
          return;
      }
    }
  }

  private emitMessage(peer: SocketState, payload: Buffer, opcode: number): void {
    if (opcode === OPCODE.BINARY) {
      // The protocol is JSON text only; ignore stray binary frames.
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload.toString('utf8'));
    } catch {
      this.emit('invalid', peer, payload.toString('utf8'));
      return;
    }
    this.emit('message', parsed, peer);
  }

  private destroyPeer(peer: SocketState, code: number, reason: string): void {
    if (peer.closed) return;
    peer.closed = true;
    try {
      peer.socket.write(encodeFrame(OPCODE.CLOSE, encodeClosePayload(code, reason)));
      peer.socket.end();
    } catch {
      try {
        peer.socket.destroy();
      } catch {
        /* ignore */
      }
    }
    this.peers.delete(peer);
  }
}

function isLoopback(address: string): boolean {
  return (
    address === '127.0.0.1' ||
    address === '::1' ||
    address === '::ffff:127.0.0.1' ||
    address.startsWith('127.')
  );
}

interface DecodedFrame {
  fin: boolean;
  opcode: number;
  payload: Buffer;
  consumed: number;
}

/** Returns null when the buffer does not yet hold a complete frame. */
function decodeFrame(buffer: Buffer): DecodedFrame | null {
  if (buffer.length < 2) return null;
  const first = buffer[0]!;
  const second = buffer[1]!;
  const fin = (first & 0x80) !== 0;
  const opcode = first & 0x0f;
  const masked = (second & 0x80) !== 0;
  let payloadLength = second & 0x7f;
  let offset = 2;

  if (payloadLength === 126) {
    if (buffer.length < offset + 2) return null;
    payloadLength = buffer.readUInt16BE(offset);
    offset += 2;
  } else if (payloadLength === 127) {
    if (buffer.length < offset + 8) return null;
    const big = buffer.readBigUInt64BE(offset);
    if (big > BigInt(MAX_MESSAGE_BYTES)) return null;
    payloadLength = Number(big);
    offset += 8;
  }

  let maskKey: Buffer | null = null;
  if (masked) {
    if (buffer.length < offset + 4) return null;
    maskKey = buffer.subarray(offset, offset + 4);
    offset += 4;
  }

  if (buffer.length < offset + payloadLength) return null;

  const payload = Buffer.from(buffer.subarray(offset, offset + payloadLength));
  if (maskKey) {
    for (let i = 0; i < payload.length; i++) {
      payload[i] = payload[i]! ^ maskKey[i % 4]!;
    }
  }

  return { fin, opcode, payload, consumed: offset + payloadLength };
}

function encodeFrame(opcode: number, payload: Buffer): Buffer {
  const length = payload.length;
  let header: Buffer;

  if (length < 126) {
    header = Buffer.alloc(2);
    header[1] = length;
  } else if (length < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }

  header[0] = 0x80 | opcode; // FIN + opcode, server frames are never masked
  return Buffer.concat([header, payload]);
}

function encodeClosePayload(code: number, reason: string): Buffer {
  const reasonBytes = Buffer.from(reason, 'utf8').subarray(0, 123);
  const payload = Buffer.alloc(2 + reasonBytes.length);
  payload.writeUInt16BE(code, 0);
  reasonBytes.copy(payload, 2);
  return payload;
}
