// Preload: the renderer's only channel to the shell.
//
// The renderer runs with `contextIsolation: true` and `nodeIntegration: false`, so it cannot
// touch Electron directly. This exposes four one-way verbs - lock, roll up / expand, close, and
// "I have drawn" - and nothing else. It is a security boundary, so it stays as small as the UI
// actually needs: the UI must also keep working in a plain browser for development, and it only
// ever calls these through an optional `globalThis.overlayShell`, never assuming they exist.
//
// CommonJS on purpose: apps/overlay/package.json sets `"type": "module"`, and a `.cjs` file is
// unambiguously CommonJS to Electron's preload loader.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('overlayShell', {
  /** "Do not auto-collapse" - the shell needs this to run its pointer watcher. */
  setLocked: (locked) => ipcRenderer.send('overlay:set-locked', locked === true),

  /**
   * Ask the shell to resize the window to (or away from) the rolled-up bar.
   *
   * The shell does the resizing; the renderer decides what to draw from the window height it
   * ends up with, so the two cannot disagree about which state is on screen.
   */
  setCollapsed: (collapsed) => ipcRenderer.send('overlay:set-collapsed', collapsed === true),

  /** Hide the window. The app stays in the tray; the tray's 退出 quits for real. */
  close: () => ipcRenderer.send('overlay:close'),

  /** The renderer has drawn once, so it is safe to start collapsing on pointer leave. */
  ready: () => ipcRenderer.send('overlay:ready'),
});
