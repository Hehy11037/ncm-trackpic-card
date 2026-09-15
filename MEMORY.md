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
| `session.ts` | Owns the connection; emits snapshots and playheads; accepts control commands. Routes transport through `media-key.ts` (primary) and the bridge (the rest), and decides `confirmed` against each command's own observable field. |
| `media-key.ts` | Spawns `tools/media-key.ps1` to inject a media key (`stdio: 'ignore'`, never throws). |
| `bridge-script.ts` | Generates the injected script. Pure string assembly — no template holes. Carries `BRIDGE_ID`, an FNV-1a hash of its own body, so a stale injection replaces itself. |
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
| `src/optimistic.js` | The held-value rule behind the play/pause flip, the mode cycle and the volume bar. |
| `src/scrub.js` | The drag gesture shared by the progress bar and the volume bar. |
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
npm test                 # 95 cases, all in-process
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
   instead of `cache-control`, so nothing was ever told not to cache. The same thing then happened
   to the injected bridge: the code was correct and the running page held the previous copy, because
   the "already installed" guard compared a hand-written version number that nobody bumped. Print
   provenance, and let an injected script identify itself by a hash of its own body (§6.21).
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
21. **An injected script declares its identity with a hash of itself, never a hand-written version.**
    The bridge's staleness guard compared `version: 2`; nobody bumped it, so after the switch gained a
    `playPause` case the client kept running the previous injection and the log still said
    `unsupported command: playPause` for code that was in the source. `BRIDGE_ID` is now
    `hashScript(body)` (FNV-1a, 8 hex) substituted at `__MO_BRIDGE_ID__`; an installed bridge with a
    different id is `dispose()`d before the new one starts, and `check-bridge-script.mjs` asserts the
    id is the script's own hash, that it changes with the content, and that no placeholder survives.
22. **A transport command presses the media key exactly once, and there is no fallback after it.**
    The key toggles, so "press, see nothing after 900ms, press again via another route" is two
    actions - a track played and immediately paused, or two skips. `pressMediaKey` appears once and
    `controlViaBridge` is reachable from exactly one branch, both asserted in
    `check-interaction.mjs`. Only `setVolume` / `toggleMute` / `setMode` / `diagnoseTransport` go
    through the bridge.
23. **A gesture that captures window geometry lands any running resize tween first.** The tween
    writes the target width immediately and interpolates the height, so a drag that began mid-tween
    captured `432x740` - a pair no window ever had, since 432 wide implies 744 tall. Apply
    `resizeAnim.target`, then read. The check compares the *order* of those two statements.
24. **The three controls with no media key each go through the client, and each does so the way the
    client itself does** (all measured; `docs/contracts.md` §6):
    * mode - `dispatch({type:'playing/onUpdate', payload:{playingMode, lastPlayingMode: <previous>}})`,
      with the four values `playOrder` / `playCycle` / `playOneCycle` / `playRandom`;
    * volume - `AudioPlayer.setVolume(0..1)` (module `4`), *not* the `playing/setVolume` action, which
      is real, runs, writes the store field, and changes nothing;
    * position - `AudioPlayer.seek({playId, seekId, value})` with **whole seconds** and a fresh
      `seekId`, answered by `{code, position}`.
    The wrapper's methods are on a prototype, so only asking the object itself finds them.
25. **`muteVolume` does not mean muted.** The client remembers the volume there, sets the volume to
    0, and does not clear it on unmute - so it is `> 0` before, during and after a mute. Muted is
    `playingVolume === 0`. Reading it the other way draws a silenced speaker over full-volume audio.
26. **An optimistic value is held until the client agrees.** Drawing every snapshot verbatim made the
    play/pause button flip, flip back and flip again - the command was immediate, the drawing was
    not, because the client keeps publishing its old state until it acts on the media key. Same for
    the volume bar, and the same rule again for the play mode: `cycleMode` advanced from the mode in
    the last snapshot, so clicking faster than a round trip sent the same next mode every time and
    the button appeared to hold only two modes (the owner reported exactly that). One module now -
    `ui/src/optimistic.js`, `createOptimisticHold`, with `ui/test/optimistic.test.mjs` - instead of
    three copies of the rule. It releases when the client agrees, when the host reports a failure, or
    on a timeout, and what it returns is always either the user's value or the client's own.
27. **A hover panel has to be reachable, not just adjacent.** The volume panel was right-aligned to
    the card's edge and sat 0.6u above the button, with `:hover` on the button's 4.6u box deciding
    everything - so it opened up and to the *left* of the pointer, and the pointer had to cross
    ground belonging to neither (where `:hover` had already ended) before it could arrive. It is
    centred on the button now, overlaps the button's box by 0.4u, and `installVolumeBar` holds
    `data-open` for 280ms after the pointer leaves, cancelling the delay if it arrives. A hover
    affordance needs a path from the trigger to itself, and that path has to cost nothing.
28. **A drag target gets its hit area from a `::before` overlay, not from padding.** Padding moves
    everything measured after it (the colour band gets away with it only because nothing is measured
    below the band); a 1.48u progress bar is ~6px tall and a 6px target is not a target. And any new
    draggable element must join `CONTROL_SELECTOR` in `ui/src/drag.js`, or pressing it moves the
    window as well.
29. **An icon is invisible to every other check, so it needs its own.** Not laid out (the layout
    check ignores it), no id (the DOM check ignores it), and there is no browser in the tooling shell
    to look at it with. Two icons shipped wrong for exactly that reason: the volume icon's sound
    waves are *strokes* and rendered as nothing under a fill-only reader, and the mute cross was two
    filled bars which cancel at their crossing under the nonzero winding rule, so it drew four
    diamonds. `npm run icons` rasterises them into `.scratch/icons/*.png` so they can actually be
    seen, and `check-interaction.mjs` asserts that every path parses, stays inside its viewBox,
    paints something, and is filled or stroked the way the stylesheet says.
30. **A state change during an interaction may not touch an in-flow property.** The scrubbing state
    thickened the progress track with `height: calc(var(--u) * 2.1)`, and the track is an ordinary
    block in the column - so pressing the bar pushed the times, the transport row, the colour band
    and the credit down 0.62u, and released them on pointer-up. The control moved out from under the
    pointer using it. `box-shadow`, `opacity` and `transform` are the ways to emphasise something
    without occupying space; the check forbids the rest generically rather than naming `height`.
31. **Anything with `role="slider"` has to update `aria-valuenow`.** The progress bar was born with
    `aria-valuenow="0"` and nothing ever wrote to it, so it announced a position of 0 for the life of
    the window - worse than having no role, because the role is a promise.
32. **The client defers a seek while paused; so does the bridge.** Measured three ways: with the
    client paused the progress stream is silent, and dragging the client's *own* progress bar calls
    neither `AudioPlayer.seek` nor the module's `seekAudioPlayer` - yet playback resumes from where
    the bar was left. The native player is idle and neither acts on nor answers a seek. A seek that
    arrives while `playingState !== 2` is therefore stored and applied on the transition to playing,
    and reported with `deferred: true` and `confirmed` undefined - not as a failure, or the card
    would undo a jump that is going to happen.
33. **No browser can be launched from the tooling shell.** Re-confirmed with the exact failure:
    `msedge`/`chrome --headless=new` (and `--single-process --no-sandbox`) die with
    `FATAL:mojo\public\cpp\platform\platform_channel.cc:108 Check failed: 拒绝访问` — the sandbox
    blocks the named pipes Chromium's multi-process IPC needs. `tools/shot.mjs` cannot run either.
    Everything visual is therefore reconstructed (`npm run icons`, `tools/transport-layout.mjs`) or
    seen by the owner.

## 7. Current state

* `npm run check` (8 steps) green, `npm test` (126) green, `tsc --noEmit` clean.
* **Confirmed by the user**: the colour band works, the lock works, the flip jitter is gone, the
  drag no longer changes the window's size, and dragging is smooth. The jitter fix was
  `will-change: transform, opacity` on `.face`; the growth fix was capturing the window size at the
  press instead of reading it back every frame; the smoothness fix was driving the drag from
  `pointermove` rather than polling a timer. One residue remained and is now fixed: a drag begun
  during a size tween captured a mismatched width/height pair (`432x740`, where 432 wide implies 744
  tall), so the drag now lands the tween before reading the bounds (§6.23).
* The tray menu is now just 小 / 中 / 大 and 退出, by the owner's request. Show/hide and recovery
  from a rolled-up card are the tray icon's left-click; the lock is on the card and on `L`.
* **All six transport controls work and are confirmed by the client**: play/pause and next/previous
  through a media key, and mode / volume / seek through the audio wrapper. The owner confirmed
  play/pause and skipping on 2026-09-15; the other three were verified end to end through
  `tools/host-smoke.mjs --control`.
* The three new controls sit in one row: play mode on the left, previous/play/next in the middle,
  volume on the right, with the two side slots the same width so the play button stays on the card's
  centre line (which is where the reference has it - previously by absolute positioning, with the
  transform repeated in every hover/active rule). The volume bar is revealed on hover and pops *up*
  and *right-aligned*: below the row is the colour band, and centred on the button it would hang off
  the card over the shadow margin.
* The progress bar is draggable, with a preview that the playback clock does not overwrite while the
  pointer is down, and the command sent once on release. Arrow keys work when it has focus, and it
  swallows them (§6.28) because the arrows are also the card's skip keys.
* Do **not** trust "the command ran": `ok` means it reached the page, `confirmed` means the client
  was observed in the state that was asked for. Only the second one is a working control. The three
  new controls are each confirmed against their own field (volume against `playingVolume`, mode
  against `playingMode`, position against the playhead or the client's own seek reply).
* The four mode glyphs and the speaker's three states were drawn by hand and then **looked at** for
  the first time (`npm run icons`): one was replaced with the conventional shuffle glyph and one was
  redrawn as two strokes, because as filled bars it rendered as four diamonds (§6.29). The mode order
  and the Chinese names come from the client's own button, not from a guess.
* The transport row's geometry is *computed* from the stylesheet rather than eyeballed
  (`tools/transport-layout.mjs`): the play button lands at 50.00u, previous/next at 37.23/62.77, mode
  and volume at 9.34/90.66, and the volume panel (23.05u) fits inside the card's 7.04u inset and
  clear of the play button. `check-interaction.mjs` asserts those numbers; `npm run icons` draws them.
  Two mistakes came out of writing it, both hidden by the play button's position: the inset lives on
  `section.face` rather than `.card`, and a three-value `padding` shorthand is top / left-and-right /
  bottom (reading it by index made left 8 and right 7.04, which is what would have moved the play
  button off centre).
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
