# Memory

What to know before touching this project. Read this first; it is deliberately about the
**rules that are currently true**, not about how they were discovered.

| File | What it is |
| --- | --- |
| `MEMORY.md` (this) | Orientation: constraints, architecture, invariants, traps, current state. |
| `NOTES.md` | Incident log, newest last. *Why* each rule exists, with the evidence. Read it when a rule looks arbitrary - it usually is not. |
| `docs/contracts.md` | Measured facts about the NetEase client: module ids, field names, units, dead ends. Do not re-derive these. |

Written 2026-09-15, at `2cbe413`. Update the "current state" section as things change; leave the
rest alone unless something in it stops being true.

---

## 1. What this is

A desktop overlay that mirrors whatever the local **NetEase Cloud Music** (网易云音乐) client is
playing: cover art, title/artist, progress, a five-colour palette taken from the artwork, and a
scroll-back lyrics page. Two faces, flipped with `F`.

The chain, end to end:

```
NetEase client (CEF)
  └─ Chromium DevTools Protocol on 127.0.0.1:9223     ← the only reliable source
       └─ packages/host        (TypeScript run straight from source by Node)
            ├─ discovers the client's webpack modules at runtime
            ├─ mirrors playback state + lyrics over a WebSocket on 127.0.0.1:8787
            └─ serves the UI over HTTP on 127.0.0.1:8788
                 └─ apps/overlay   (Electron shell: frameless, transparent, always-on-top)
                      └─ ui/       (plain ES modules + CSS, no build step)
```

Three things follow from "no build step":

* The UI is **whatever is on disk**, served per request. There is no artifact to rebuild.
* Editing a file and restarting the shell is the whole loop - except for main-process changes,
  which need the shell restarted, and renderer changes, which only need the page reloaded.
* A stale HTTP cache can silently serve old code. The UI server therefore sends
  `cache-control: no-store` for everything, and the shell prints the mtime of the UI files it is
  about to serve, so "which code is running?" is answerable from the terminal.

## 2. Hard constraints of the development environment

These are properties of the machine this was built on. They will bite immediately if forgotten.

* **No Chromium can be launched from the tooling shell.** NetEase, Electron and Chrome all die
  with `FATAL:platform_channel.cc Check failed: 拒绝访问`. So:

  > **Every visual or interactive check is done by the user, in the real shell.** Nothing in this
  > repo has ever been seen rendering by the agent that wrote it. Say so plainly rather than
  > implying a screenshot was reviewed.

  This is why the project has so much static checking, a renderer-console forwarder, and a
  hit-test self-check that reports to the terminal.
* **The NetEase client must also be started outside the sandbox**, fully exited first (it enforces
  a single instance), with `--remote-debugging-address=127.0.0.1 --remote-debugging-port=9223`.
  `tools/debug-launch.ps1` writes a shortcut and prints the steps; `npm run probe` confirms the
  channel. If port 9223 is free, the client is not running with it - the card will say
  "未检测到播放" and that is not a regression.
* **Never round-trip a source file through PowerShell.** `Get-Content -Raw` piped into
  `Set-Content` re-encodes through the console code page and destroys every Chinese string literal.
  It has happened once. Use the editor tools, or `node` with `writeFileSync(..., 'utf8')`.
  `tools/check-encoding.mjs` now guards against it.
* Do not mass-kill `node` processes: it kills the tooling shell itself.
* `tasklist`/WMI cannot see the client's protected processes; only `Get-Process` works.
* Tests run **in-process** (`node file.test.ts`), never `node --test <dir>`, which spawns children
  and hits EPERM.

## 3. Architecture map

**`packages/host`** - the only part that talks to the client.

| File | Role |
| --- | --- |
| `cdp.ts` | DevTools-protocol client against the client's debug port. |
| `discovery.ts` | Finds the dva store and audio pipeline by *shape*, never by hardcoded module id. Cached on disk under `OVERLAY_CACHE_DIR`. |
| `session.ts` | Owns the connection; emits snapshots and playheads; accepts control commands. |
| `lyrics.ts` | Source selection: verified client lyrics first, public endpoint second. |
| `lyric/parse.ts` | LRC / yrc / client-slice parsers, credit-line detection. |
| `lyric/build.ts` | Turns raw payloads into `LyricDoc`. |
| `lyric/fetch.ts` | The public endpoint (`yv=-1` is what returns word timings). |
| `lyric/cache.ts` | On-disk cache. 7 days normally, **60 seconds** for a no-lyric result. |
| `ui-server.ts` | Serves `ui/` and `/config.json` on loopback. |

**`ui`** - rendering only, no client knowledge.

| File | Role |
| --- | --- |
| `src/layout.js` | The unit `--u` (1% of card width) and which of the two states is on screen. |
| `src/card.js` | Front face: cover, text, progress, palette band, window controls. |
| `src/lyrics.js` | Back face: centred, depth-scaled entries. |
| `src/palette.js` | Median-cut palette extraction from the cover. |
| `src/drag.js` | Pointer gesture that moves the window. |
| `src/socket.js`, `src/clock.js` | Host link; playback clock. |

**`apps/overlay`** - the window, and *only* the window.

| File | Role |
| --- | --- |
| `main.mjs` | Window geometry, the pointer watcher, the tray, IPC, startup order. |
| `shell-utils.mjs` | Pure helpers: `fitWindow`, `clampToWorkArea`, `dragTarget`, `createHoverState`, the icon encoder. |
| `preload.cjs` | The renderer's whole IPC surface: toggle lock, collapse/expand, close, drag, watch state. |

**`tools/`** - diagnostics and checks. `tools/css-values.mjs` is the shared stylesheet reader;
`check-*.mjs` are the static checks; the rest probe the client and are not part of the app.

## 4. Invariants, and where they are enforced

Break one of these and a check fails. That is the point - none of them are visually obvious.

1. **The card's aspect is 1 : 1.8136, not 9:16.** It is the reference's measured content ratio
   (1080 x 1958). At 9:16 the literal type is too tall for the height and `overflow: hidden` clips
   the title. Declared in three languages; `check-shell.mjs` asserts all three agree.
2. **The window is `card + 2 x SHADOW_PAD` (24px).** The transparent margin exists so the card's
   CSS shadow has somewhere to render; on a transparent window a shadow is clipped flat at the
   window edge. The shadow's reach is asserted to fit inside the margin.
3. **`--u` is derived from the stage's width, never from its height.** The height is what the
   collapsed state changes, so reading it back would be circular.
4. **The renderer decides its own mode from `window.innerHeight`.** No IPC message can leave the
   drawing and the window disagreeing about which state is on screen.
5. **No element is a `-webkit-app-region` region.** See trap 6.
6. **Window positions are always clamped to the work area.** The rolled-up strip sits along the
   window's *top* edge, so a window above the top of the screen would put the strip where no
   pointer can reach it and the card could never be expanded again.
7. **The roll-up depends on nothing the renderer can break.** It is gated on
   `webContents.once('dom-ready')`, not on an IPC handshake.
8. **The lock state is owned by the shell**, persisted in `window-state.json`, controlled from the
   card's lock button and `L`. Default: **locked**. An overlay that rolls itself up on first run is
   a surprise; not rolling up is merely inert. The tray does *not* offer it - the tray menu is three
   sizes and 退出, by request.
9. **Every interactive element is at least ~24px in both dimensions**, and the colour band's
   clickable box is padded beyond its visible strip with a cancelling negative margin.
10. **A failed public lyric fetch is never treated as "this track has no lyrics"** and is never
    cached. It is retried once after 1.5s.
11. **The client's lyric slice is only accepted when the track's own name or artist appears in
    it.** The store briefly reports the previous track's lyrics under the new song id, and stale
    full lyrics are indistinguishable from real ones by inspection.
12. **`npm run check` must pass with nothing else running.** Every check is self-contained; a check
    that silently depends on the environment is worse than no check, because it is believed.
13. **A window's own size is never fed back into the next `setBounds`.** Capture it once and reuse
    it: on a display whose scale factor is not whole, DIP to physical and back can round
    differently, so re-applying what was just read compounds into visible growth. Applies to both
    the drag and the resize tween.
14. **The stage is anchored to the window's top, and the mode threshold sits at the *collapsed*
    height.** Together those make the roll-up read as the panel sliding up, with the window's
    bottom edge eating the card - instead of the card shrinking towards its middle, or popping into
    the strip halfway through.
15. **The drag's cursor position comes from the renderer's `pointermove`**, sent as absolute screen
    coordinates at most once per frame. Never poll the cursor on a timer in the shell for this: a
    timer fires near a frame rather than on it, and the irregularity reads as stutter.
16. **Choosing a colour and judging contrast use different luminance measures.** `luma255` (0-255,
    no gamma) is for "is this near-black?", "which band does it fall in?. WCAG relative luminance
    is for "can text be read on this?". Using the WCAG one to filter dark colours discards exactly
    the swatches a dark-blue cover is made of.
17. **A renderer module is never passed bare to `Array.prototype.map`** if it takes an optional
    second parameter. `map` passes the index there. `chosen.map(boostSaturation)` turned the first
    swatch grey (factor 0), left the second alone (factor 1) and blew the rest out (factors 2-4).
18. **Lyrics use one colour.** Depth is carried by size, blur and opacity, not by hue.

## 5. Commands

```
npm run overlay          # the app (also: npx electron apps/overlay)
npm run host             # host only, for browser development
npm run check            # 8 static checks; must be green
npm test                 # 72 cases, all in-process
npm run typecheck        # tsc --noEmit

npm run probe            # is the client's debug channel up?
npm run discover         # re-run webpack module discovery
npm run dump             # one full state snapshot
npm run watch            # live progress stream

npm run check:layout     # card geometry vs the measured reference
npm run check:shell      # window geometry, hover state machine, icon, startup order
npm run check:interaction# hit targets, handlers, drag, DOM nesting
npm run check:encoding   # no corrupted or BOM-prefixed sources
```

`OVERLAY_CACHE_DIR` redirects both caches (discovery and lyrics). The Electron shell sets it to its
`userData`; set it yourself when running the host from a confined shell, or every start repeats the
full module scan.

**`npm run check` is self-contained**: nothing has to be running first. `check:ui` probes the UI
port and, when nothing answers, starts its own host (logging to `.scratch/check-ui-host.log`) and
stops it again afterwards. It only ever stops a host it started itself. Before that it depended on
a host being started by hand, so it passed for a while purely because a leftover one from an
earlier session was still alive - and then went red with seventeen `fetch failed` lines that had
nothing to do with the change being made.

## 6. Traps

Each of these cost real time. The reason matters more than the rule.

1. **Two bugs can present as one symptom, and the second hides behind the first.** "The card never
   rolls up" was a tray icon that threw during startup - everything after it in the `whenReady`
   chain never ran, including the pointer watcher. *Order startup so optional extras come last and
   are wrapped; never gate a core feature on a handshake.*
2. **A fix can be applied and never loaded.** The UI server wrote a header literally named `cache`
   instead of `cache-control`, so nothing was ever told not to cache. Print provenance.
3. **`Tray` and `BrowserWindow.icon` want a `NativeImage` or a path.** A raw PNG `Buffer` throws
   `Argument must be a file path or a NativeImage`.
4. **`minHeight` on the window makes the roll-up impossible.** Windows enforces min/max during
   `setBounds`, not only during user resizing. `resizable: false`, by contrast, only removes the
   user's drag handles.
5. **A window with no window yet is what the "hourglass" cursor means.** Windows shows its starting
   cursor for a process that has not opened a window. Create the window first, load the slow part
   after.
6. **`-webkit-app-region` could not coexist with this card's controls.** Three arrangements were
   tried; each traded one broken feature for another (band unclickable, or window unmovable).
   Dragging is now a pointer gesture, and the *shell* moves the window so the cursor cannot outrun
   it and escape.
7. **Chromium fires `pointercancel` / `lostpointercapture` when a window is moved under a captured
   pointer.** Treating those as fatal stranded the drag mid-gesture.
8. **A drag that never ends silently disables the roll-up**, because the pointer watcher skips
   every tick while one is open. Always end the gesture; keep a stale-drag guard anyway.
9. **Unit traps in the client's state.** `resourceDuration` is seconds; `curTrack.duration` and the
   chorus map are milliseconds; client lyric times are seconds; `resourceTrackId` is a string and
   the queue's `resourceId` is a number. See `docs/contracts.md`.
10. **`tasklist` cannot see the client; `Get-Process` can.**
11. **Git for Windows cannot reach GitHub with its system config here.** Override per repository:
    `http.sslBackend=openssl` and an empty `credential.helper`, then put the credential in the push
    URL. The remote stores no credential and there is no `gh`.
12. **Silence is the dominant failure mode of this UI.** A control that is not hit-testable, a
    control that is covered, a component that never mounted - all look identical. That is why the
    card logs a hit-test self-check at startup, logs every colour pick, and the shell logs every
    roll-up and drag transition.
13. **Never feed a window's own geometry back into the next `setBounds`.** `getBounds()` and
    `setBounds()` round-trip through physical pixels, so on a 125% or 150% display each frame can
    write a size a fraction larger than it read. At 60 frames a second that compounds: the card
    grows visibly while it is dragged. Capture the size once, at the press, and reuse it.
14. **A resize with no motion reads as slow however short the delay is.** The roll-up was cut from
    600ms to 300ms and still felt slow, because nothing moved - there was nothing to judge the
    speed by except the pause. A 120ms ease-out tween fixed the perception, and the mode threshold
    had to move to the collapsed height so the tween looks like a roll-up rather than a pop.
15. **`setInterval` is not a frame clock.** Polling the cursor every 16ms moves the window *near*
    each frame rather than on it - sometimes twice in one frame, sometimes not at all - and that
    irregularity is what "卡顿" means, even though every step is identical in size. Drive anything
    that must look smooth from `pointermove` or an animation frame.
16. **Two luminance measures, two jobs.** The palette pipeline filtered with WCAG relative
    luminance, which weights blue at 0.0722 and linearises, so a rich dark blue measures 0.034 and
    fell below the 0.06 "too dark" cut. The cover's own colour was thrown away and its darkest band
    was filled with a grey. Filtering and banding use the 0-255 luma; only contrast uses WCAG.
17. **`Array.prototype.map` passes the index as the second argument.** A helper with an optional
    second parameter therefore receives the index when passed bare: `chosen.map(boostSaturation)`
    boosted the first swatch by 0 - collapsing it to a pure grey - left the second alone, and
    multiplied the rest by 2, 3 and 4. Always wrap it: `.map((x) => f(x))`.
18. **Nothing that must look smooth is stepped by `setInterval` in the main process.** Both the
    drag and the window-resize tween are now driven by the renderer's animation frames. The shell
    computes the values, the renderer supplies the clock, and each sends the other a token so a
    tick from a superseded animation is ignored.
19. **Anything that can stall the roll-up has to self-heal or say so.** A leaked drag, a suppressed
    tick and a bad pointer sample have each stopped the card collapsing. The drag guard is 4s (a
    live drag restarts on the next move), suppression after a drag is 350ms, a failed sample no
    longer resets the "pointer is away" timer, and a pointer that has been gone for a second
    without a collapse is reported with the state of every guard.
20. **A command has three ends: the contract, the sender, and the handler.** `playPause` was
    declared in `ControlCommand`, sent by the button and the space bar, and had no `case` in the
    bridge's switch - so the largest control on the card threw `unsupported command` on every press
    and looked like it worked for one frame. `check-bridge-script.mjs` now cross-checks all three,
    and the host confirms a transport command against the client's own `playingState` rather than
    trusting that it ran.

## 7. Current state

* `npm run check` (8 steps) green, `npm test` (95) green, `tsc --noEmit` clean.
* **Confirmed by the user**: the colour band works, the lock works, the flip jitter is gone, the
  drag no longer changes the window's size, and dragging is smooth. The jitter fix was
  `will-change: transform, opacity` on `.face`; the growth fix was capturing the window size at the
  press instead of reading it back every frame; the smoothness fix was driving the drag from
  `pointermove` rather than polling a timer.
* The tray menu is now just 小 / 中 / 大 and 退出, by the owner's request. Show/hide and recovery
  from a rolled-up card are the tray icon's left-click; the lock is on the card and on `L`.
* **Play/pause: the command is wired, the client does not react to it.** The bridge reads
  `playingState` and calls `setAudioPlayerPlay`/`Pause`; measured, that call runs and changes
  nothing, and its signature cannot be read from disk because the web bundle is packed
  (`orpheus.ntpk`). The transport therefore falls back to a **media key**
  (`tools/media-key.ps1`, the client's own global hotkey) and then to a page-side diagnostic that
  lists the exports' arity, the dva play actions and the client's own transport buttons. The host
  reports `成功` / `未确认` / `失败` with the `playingState` transition either way. Whether the media
  key reaches the client is the open question - it goes quiet if the client's global-hotkey option
  is off. See `docs/contracts.md` §6.
* Do **not** trust "the command ran": `ok` means it reached the page, `confirmed` means the client
  was observed in the state that was asked for. Only the second one is a working control.
* Known open items, none urgent:
  * no README on the repository home page;
  * the tray icon is generated in memory, so there is no `.ico` for packaging;
  * `electron-builder` packaging was offered and not done;
  * the CSP warning Electron prints in development is real: a strict policy needs the inline boot
    script moved out of `index.html` first.
* **The GitHub token used for the pushes has been pasted into a session transcript and should be
  revoked.** Pushes made after that will need a new one.

## 8. Working agreement

* **Measure, do not guess.** Layout numbers come from `tools/measure-reference.mjs` reading the
  reference image's pixels. Eyeballed screenshots produced a layout that was wrong three times.
* **Say what is verified and what is not.** Static checks and unit tests are not a rendering.
* **Prefer a check over a fix.** Every bug that reached the user because a screenshot looked fine
  has become an assertion in `tools/check-*.mjs`.
* **Explain the mechanism, not just the change.** The user reads the reasoning and pushes back on
  it; several good corrections came from that.
