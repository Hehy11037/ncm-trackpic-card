/**
 * Static file server for the overlay UI, bound to loopback.
 *
 * Why an HTTP server instead of a bundler or file://:
 *
 *  - The UI is plain ES modules, so it needs to be served over http:// (module
 *    scripts do not load from file://).
 *  - Serving it from the host means the same UI can be opened in a normal browser
 *    during development and loaded by the Electron shell in the packaged app -
 *    one code path, no build step.
 *  - It also serves `/config.json`, so the UI learns the WebSocket port instead of
 *    hardcoding it.
 *
 * Only loopback is accepted and only files inside the UI root are served.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';

export interface UiServerOptions {
  port: number;
  /** Absolute path to the directory holding index.html. */
  root: string;
  host?: string;
  /** Served verbatim at /config.json. */
  config: Record<string, unknown>;
  log?: (level: 'warn', message: string) => void;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ico': 'image/x-icon',
};

export class UiServer {
  private readonly options: UiServerOptions;
  private readonly rootAbs: string;
  private server: Server | null = null;

  constructor(options: UiServerOptions) {
    this.options = options;
    this.rootAbs = resolve(options.root);
  }

  get url(): string {
    return `http://127.0.0.1:${this.options.port}/`;
  }

  async listen(): Promise<void> {
    if (this.server) return;
    const host = this.options.host ?? '127.0.0.1';

    this.server = createServer((req, res) => {
      void this.handle(req, res);
    });

    await new Promise<void>((resolvePromise, reject) => {
      const onError = (err: Error) => reject(err);
      this.server!.once('error', onError);
      this.server!.listen(this.options.port, host, () => {
        this.server!.off('error', onError);
        resolvePromise();
      });
    }).catch((err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        throw new Error(
          `界面端口 ${this.options.port} 已被占用。请关闭占用它的程序，或用 --ui-port 换一个端口。`,
        );
      }
      throw err;
    });
  }

  async close(): Promise<void> {
    if (!this.server) return;
    const server = this.server;
    this.server = null;
    await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      if (!isLoopback(req.socket.remoteAddress ?? '')) {
        respond(res, 403, 'text/plain; charset=utf-8', 'loopback only');
        return;
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        respond(res, 405, 'text/plain; charset=utf-8', 'method not allowed');
        return;
      }

      const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
      if (pathname === '/config.json') {
        respond(res, 200, MIME['.json']!, JSON.stringify(this.options.config, null, 2), NO_CACHE);
        return;
      }

      const relative = pathname === '/' ? 'index.html' : decodeURIComponent(pathname.slice(1));
      const target = this.resolveSafe(relative);
      if (!target) {
        respond(res, 403, 'text/plain; charset=utf-8', 'path not allowed');
        return;
      }

      const info = await stat(target).catch(() => null);
      if (!info || !info.isFile()) {
        respond(res, 404, 'text/plain; charset=utf-8', `not found: ${relative}`);
        return;
      }

      const body = await readFile(target);
      respond(res, 200, MIME[extname(target).toLowerCase()] ?? 'application/octet-stream', body, NO_CACHE);
    } catch (err) {
      this.options.log?.('warn', `界面服务出错: ${err instanceof Error ? err.message : String(err)}`);
      respond(res, 500, 'text/plain; charset=utf-8', 'internal error');
    }
  }

  /** Resolve a request path inside the UI root, or null when it escapes it. */
  private resolveSafe(relative: string): string | null {
    const normalized = normalize(relative).replace(/^([/\\])+/, '');
    if (normalized.startsWith('..') || normalized.includes(`..${sep}`)) return null;
    const target = resolve(join(this.rootAbs, normalized));
    if (target !== this.rootAbs && !target.startsWith(this.rootAbs + sep)) return null;
    return target;
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

/**
 * Nothing the UI loads may be cached.
 *
 * This was written as `{ cache: 'no-store' }`, which produced a header literally named `cache`
 * - not a real HTTP header, so no cache directive was sent at all. Chromium's own HTTP cache
 * lives in the Electron profile, which survives restarts, so a fixed stylesheet could keep
 * being served from cache and the fix would look like it had never been applied. That is a
 * particularly nasty failure mode for a project whose whole loop is "edit the UI, restart the
 * shell, look at it".
 */
const NO_CACHE: Record<string, string> = {
  'cache-control': 'no-store, no-cache, must-revalidate',
  pragma: 'no-cache',
  expires: '0',
};

function respond(
  res: ServerResponse,
  status: number,
  contentType: string,
  body: string | Buffer,
  extra: Record<string, string> = {},
): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': Buffer.byteLength(body),
    ...extra,
  });
  res.end(body);
}
