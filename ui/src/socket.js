/**
 * WebSocket link to the host, with automatic reconnection.
 *
 * The host is the only source of truth; this module just delivers its messages and
 * exposes a way to send control commands. Reconnection matters because the host may
 * be restarted while the UI stays open.
 */

const RECONNECT_MIN_MS = 800;
const RECONNECT_MAX_MS = 6000;

export class HostLink {
  /** @param {{ port: number, onMessage: (msg) => void, onStatus: (state: string) => void }} options */
  constructor(options) {
    this.port = options.port;
    this.onMessage = options.onMessage;
    this.onStatus = options.onStatus;
    this.socket = null;
    this.delay = RECONNECT_MIN_MS;
    this.timer = null;
    this.closedByUs = false;
    this.queue = [];
  }

  get url() {
    return `ws://127.0.0.1:${this.port}`;
  }

  connect() {
    this.closedByUs = false;
    this.onStatus('connecting');

    let socket;
    try {
      socket = new WebSocket(this.url);
    } catch (err) {
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;

    socket.addEventListener('open', () => {
      this.delay = RECONNECT_MIN_MS;
      this.onStatus('connected');
      // Ask for the current picture immediately: we may have missed events.
      this.send({ kind: 'requestSnapshot' });
      this.send({ kind: 'requestLyrics' });
      for (const pending of this.queue.splice(0)) this.send(pending);
    });

    socket.addEventListener('message', (event) => {
      let message;
      try {
        message = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data));
      } catch {
        return;
      }
      this.onMessage(message);
    });

    socket.addEventListener('close', () => {
      this.onStatus('offline');
      if (!this.closedByUs) this.scheduleReconnect();
    });

    socket.addEventListener('error', () => {
      // `close` always follows, so reconnection is handled there.
    });
  }

  send(message) {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      // Remember the intent so a control click during a blip is not lost.
      if (this.queue.length < 16) this.queue.push(message);
      return false;
    }
    socket.send(JSON.stringify(message));
    return true;
  }

  control(command) {
    return this.send({ kind: 'control', command });
  }

  scheduleReconnect() {
    if (this.timer || this.closedByUs) return;
    const wait = this.delay;
    this.delay = Math.min(this.delay * 1.6, RECONNECT_MAX_MS);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.connect();
    }, wait);
  }

  close() {
    this.closedByUs = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    try {
      this.socket?.close();
    } catch {
      /* ignore */
    }
  }
}
