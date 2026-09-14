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
   * Moving the window, as a plain pointer gesture rather than a `-webkit-app-region` drag region.
   * See ui/src/drag.js for why. Only the start and the end cross the bridge: the shell watches the
   * OS cursor itself and keeps the pressed point at the same offset inside the window, so the
   * cursor can never outrun the window and escape it.
   */
  dragStart: () => ipcRenderer.send('overlay:drag-start'),
  dragEnd: () => ipcRenderer.send('overlay:drag-end'),

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
