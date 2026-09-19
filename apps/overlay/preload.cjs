// Preload: the renderer's only channel to the shell.
//
// The renderer runs with `contextIsolation: true` and `nodeIntegration: false`, so it cannot
// touch Electron directly. This exposes three verbs and one subscription - toggle the lock,
// roll up / expand, close, and hear the shell's authoritative state - and nothing else. It is
// a security boundary, so it stays as small as the UI actually needs, and the UI only ever
// calls it through an optional `globalThis.overlayShell`, never assuming it exists.
//
// CommonJS on purpose: apps/overlay/package.json sets `"type": "module"`, and a `.cjs` file is
// unambiguously CommonJS to Electron's preload loader.
//
// Note what is NOT here: nothing about *when* the window rolls up. The shell owns that
// decision entirely, because it must keep working even if this bridge fails to load - the
// renderer only reports the lock toggle and does what the window size tells it to.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('overlayShell', {
  /** Flip "do not auto-collapse". The shell owns and persists the value. */
  toggleLock: () => ipcRenderer.send('overlay:toggle-lock'),

  /** Ask the shell to roll the window up, or expand it back to the full card. */
  setCollapsed: (collapsed) => ipcRenderer.send('overlay:set-collapsed', collapsed === true),

  /** Hide the window. The app stays in the tray; the tray's 退出 quits for real. */
  close: () => ipcRenderer.send('overlay:close'),

  /*
   * The user's own cover: pick a file, switch it on/off, or clear it and go back to the song's art.
   *
   * The shell owns all three, because it also persists the choice - and `coverUrl` is a separate call
   * rather than part of the state broadcast, since the image is a data URL and re-sending it on every
   * state change would be wasteful. Everything about the cover is optional: a plain browser has no
   * `overlayShell` at all, and the card's button then does nothing.
   */
  pickCover: () => ipcRenderer.invoke('overlay:pick-cover'),
  toggleCover: () => ipcRenderer.send('overlay:toggle-cover'),
  clearCover: () => ipcRenderer.send('overlay:clear-cover'),
  coverUrl: () => ipcRenderer.invoke('overlay:cover-url'),

  /*
   * Restart the NetEase client with its loopback debug channel open.
   *
   * The channel only opens at launch, so an overlay that cannot see the client cannot fix that by
   * itself - this is the one action that can. It resolves with `{ ok, message }` so the card can say
   * what happened instead of leaving the button looking dead.
   */
  restartClient: () => ipcRenderer.invoke('overlay:restart-client'),

  /*
   * Moving the window, as a plain pointer gesture rather than a `-webkit-app-region` drag region.
   * See ui/src/drag.js for why.
   *
   * Coordinates are absolute screen positions taken from `pointermove`, which is delivered in step
   * with the compositor. They come from the renderer rather than from polling the cursor in the
   * shell, because a timer fires *near* a frame rather than on it and the resulting irregularity
   * reads as stutter.
   */
  dragStart: (x, y) => ipcRenderer.send('overlay:drag-start', x, y),
  dragMove: (x, y) => ipcRenderer.send('overlay:drag-move', x, y),
  dragEnd: () => ipcRenderer.send('overlay:drag-end'),

  /**
   * Drive the shell's resize tween from this side's animation frames.
   *
   * `setInterval` in the main process fires *near* a frame rather than on it, which is what makes a
   * short window resize look jittery. A renderer has a real frame clock, so the shell asks for a
   * tick and calls back once per frame for as long as the tween lasts.
   *
   * @param {(request: {token: number, ms: number}) => void} handler
   */
  onAnimateResize: (handler) => {
    if (typeof handler !== 'function') return () => {};
    const listener = (_event, request) => handler(request);
    ipcRenderer.on('overlay:animate-resize', listener);
    return () => ipcRenderer.removeListener('overlay:animate-resize', listener);
  },

  /** One frame of the tween has been drawn. `token` 0 means "no tween is running". */
  resizeTick: (token) => ipcRenderer.send('overlay:resize-tick', token),

  /**
   * Subscribe to the shell's state (`{ locked }`), and ask for it immediately.
   *
   * The lock state is owned by the shell so that the tray menu and the card button cannot
   * disagree; the button is a view of it, not a second copy. Returns an unsubscribe function.
   */
  watchState: (handler) => {
    if (typeof handler !== 'function') return () => {};
    const listener = (_event, state) => handler(state);
    ipcRenderer.on('overlay:state', listener);
    ipcRenderer.send('overlay:request-state');
    return () => ipcRenderer.removeListener('overlay:state', listener);
  },
});
