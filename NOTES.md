# Change log / incident notes

Short notes on decisions and on mistakes worth not repeating.

## 2026-09-14 — the client must not be launched from a sandboxed shell

`cloudmusic.exe` started by a sandboxed/confined shell **inherits that shell's
restrictions** and dies immediately:

```
ERROR:client_app.cpp(242) CustomSchems Add Failed, it may called localstorage or cache access failed(1).
FATAL:platform_channel.cc(85) Check failed: . : Access is denied. (0x5)
```

Cause: the confined process may not write under `%LOCALAPPDATA%\Netease` and may
not open named pipes (CEF's `platform_channel` is a named pipe).

Symptom to recognise: `cloudmusic_reporter.exe` stays alive while the
`cloudmusic.exe` processes exit within a second or two, and the debug port never
opens.

Consequences for this project:

* `tools/relaunch-ncm.ps1` must be run from a **normal, non-sandboxed terminal**
  (or simply start the client from its Start Menu shortcut / desktop icon).
* The host app that talks to CDP must not launch the client itself when it runs
  inside a confined environment. Prefer asking the user to start the client.
* Do **not** delete files inside the client's data directory
  (`webapp91x64\LOCK`, `safemode\flag`, caches, ...). The client owns that state.
  An earlier attempt at "clearing crash state" was both ineffective and
  unnecessary: the real cause was the sandbox, not stale files.

A second, unrelated false alarm from the same session: writes to
`%LOCALAPPDATA%\<anything>` are denied for this project's tooling shell, but
`%TEMP%` and the workspace are writable. That is the tooling sandbox's write
policy, **not** a system ACL problem. `Get-Acl` still reports FullControl for the
user, and `%TEMP%` looks identical, so compare write behaviour across several
`%LOCALAPPDATA%` subdirectories before concluding that permissions are broken.

## 2026-09-14 — no Chromium can be launched from the tooling shell

Confirmed independently three ways:

* the NetEase client (CEF) dies with `FATAL:platform_channel.cc(85) ... Access is denied (0x5)`
* Electron dies the same way (`platform_channel.cc:108`)
* `chrome.exe --headless=new --screenshot` produces no image

Cause: Chromium's Mojo platform channel uses a **named pipe**, which a confined
shell cannot create. `app.commandLine.appendSwitch('single-process')` gets past the
Mojo failure, after which Electron dies on profile/cache writes instead
(`STATUS_BREAKPOINT`, exit `0x80000003`).

Consequences worth remembering:

* **Visual work cannot be verified from here.** Screenshots of the overlay or the
  Electron shell have to be produced by the user, from a normal desktop session.
  Do not burn time trying to render Chromium inside this shell.
* Logic that would otherwise only be observable in a browser is worth extracting
  into plain modules with tests. `ui/src/clock.js` is the clearest example: the
  extrapolation, easing, seek-snap and pause-freeze rules are all verified by
  `node ui/test/clock.test.mjs` with a stubbed `performance.now()`.
* Static checks are the substitute for a browser: `tools/check-ui.mjs` (serving,
  content types, path traversal), `tools/check-ui-dom.mjs` (every `getElementById`
  in the UI resolves against `index.html`, and every referenced asset exists).
* The overlay is served over HTTP by the host on purpose: the same URL works in a
  normal browser during development and in the Electron shell once packaged, and
  it needs no bundler.

## 2026-09-15 — clipped descenders, three times

Symptom: the tails of `p j y g` are cut off. It came back three times because each
round fixed only one of two cooperating causes:

1. **A tight line box.** A `line-height` below roughly 1.5 does not cover a 600-weight
   font's glyph extent, and this stack falls through several families (MiSans, Noto Sans
   SC, 微软雅黑) whose ascent/descent metrics differ.
2. **`overflow: hidden` on or near the text.** It is needed for the two-line title clamp,
   and it slices anything leaving the box. `-webkit-line-clamp` sizes the box as
   `line-height x lines`, so clamp plus a tight line box is the worst case. The lyric
   entries are the same shape and worse, because the active entry is scaled to 1.08.

What actually works:

* title and artist `line-height: 1.6`, lyric `1.45` plus `padding-bottom` on the text span
  so a scaled-up active entry still has room;
* prefer **padding over margin** for the compensation: padding does not collapse and cannot
  be absorbed by a flex `auto` margin;
* when a taller box shifts the column, cancel it on a **following** element's margin (a
  negative bottom padding is not valid);
* `tools/check-layout.mjs` now reads `line-height` from the stylesheet instead of assuming
  it. It was hardcoded, so changing the CSS made the check quietly disagree with the real
  layout — exactly the drift that let this keep coming back.

If a descender is still clipped after all of that, the cause is elsewhere: check whether the
element sits inside a `transform` (a scaled ancestor clips differently), or whether the
font's own metrics are at fault. In that case name the specific glyph and where it appears.


## 2026-09-14 — phase 0 closed

The debug channel works and the playback contract is measured; see
`docs/contracts.md` for the full, evidence-backed field table.

Worth remembering:

* **Runtime module discovery was the right call.** The community implementation's
  hardcoded webpack module ids (`987660`, `12`) do not exist in 3.1.39. The dva
  store singleton is module `11`; the audio pipeline is module `1186`, found by
  looking for the export name `audioPlayerPlayProgress$`.
* **Progress is not in Redux and there is no `<audio>` element.** Audio decodes
  natively. The clock is the `audioPlayerPlayProgress$` stream, emitting
  `[playId, seconds, playState]` at ~30 Hz.
* **`playingState` 1 = paused, 2 = playing.** A probe run that showed zero
  dispatches and a frozen lyric line number was simply a paused client — worth
  checking before hunting for a bug.
* **Units differ per field.** `resourceDuration` is seconds; `curTrack.duration`
  and the chorus map are milliseconds.
* **Wrapping exported functions is not enough to intercept calls.** Replacing
  `setAudioPlayerPlay` on the module namespace captured nothing, because the
  consumer had already destructured the reference. Interception has to happen
  through a live `dispatch` tap or at the native boundary.
* Quick EMPTY-diagnosis habit: before writing a long probe, confirm the app is
  actually in the state you assume (playing vs paused). Several probes were spent
  on a paused client.

## 2026-09-14 — git cannot talk to GitHub out of the box here

Two settings in Git for Windows' **system** config break things, and both need a
per-repository override:

```
C:/Program Files/Git/etc/gitconfig
  http.sslbackend=schannel
  credential.helper=manager
```

* `schannel` fails with `SEC_E_NO_CREDENTIALS (0x8009030E)` when trying to reach
  github.com. Override with `http.sslBackend=openssl`.
* `credential.helper=manager` makes git spawn `sh.exe`, which dies inside a
  confined shell with `couldn't create signal pipe, Win32 error 5`. With the
  helper enabled the push never even reaches GitHub. Override it with an empty
  helper and put the credential in the remote URL instead.

`git config --global` cannot be written from this shell (its config file lives
under the user profile), so the overrides are set **per repository**:

```powershell
git config --local http.sslBackend openssl
git config --local --add credential.helper ""
```

With those in place the remaining requirement is a real credential. Verified with
a deliberately invalid token: GitHub answers
`remote: Invalid username or token. Password authentication is not supported for
Git operations.` — a server response, which proves the transport works and only
the credential was missing. Use the `https://x-access-token:<TOKEN>@github.com/...`
form as the push URL.

## 2026-09-15 — why the colour band "could not be clicked"

Reported as "色带不能点击选颜色", with the layout looking correct in a screenshot.
Two causes, both invisible to a screenshot, and both now covered by
`tools/check-interaction.mjs`:

* **The target was 4px tall.** `.band` was `height: 1.7u` with the swatches at
  62% of it, which is 4.2px at the default 400px card. Fix: keep the measured
  1.7u visible strip, but pad the *element* out to 6.5u (26px) with
  `padding: 2.4u 0` plus `margin: -2.4u 0` so the padding cannot move anything.
  That needs `box-sizing: content-box` — the global `border-box` would make the
  padding eat the measured height instead.
* **`-webkit-app-region`.** `html, body` declare `drag`, which turns the *whole
  window* into a title bar. Chromium subtracts the boxes of elements that declare
  `no-drag`, so anything clickable has to opt out or its clicks start a window
  drag and the control looks dead. The carve-out is the element's own box, so a
  4px swatch gives a 4px no-drag region. Every interactive element now appears in
  one explicit `no-drag` list in `card.css` — and the list itself is asserted by
  the check, because a new control that forgets it will look fine.

Also: a click in the padded area lands on the *container*, not on a swatch, so the
band uses one delegated listener on `#palette` that falls back to the pointer's x
position. Per-swatch listeners were also being thrown away and re-created by every
`renderBand()`.

## 2026-09-15 — rolling the window up (QQ-style) and what blocks it

The card now shrinks to a strip when the pointer leaves, and the shell owns three
things the renderer cannot:

* **`minHeight` would have made the roll-up impossible.** The original window set
  `minHeight: heightForWidth(MIN_WIDTH, ...)`. Windows applies min/max constraints
  during `setBounds` as well as during user resizing, so the window could never
  have become shorter than a full card. There is deliberately no `minHeight` now;
  `resizable: false` only removes the user's drag handles and does not stop
  `setBounds`.
* **The pointer is polled from the main process**, not taken from a renderer
  `mouseleave`. With a transparent window, "left the card" and "left the window"
  are different questions, and only the main process can ask the OS. Events also
  stop arriving exactly when the window under the cursor changes size.
* **The renderer derives its mode from `window.innerHeight`**, rather than from an
  IPC message. Both sides then physically cannot disagree about which state is on
  screen, and there is no ordering problem to get wrong: the shell resizes, the
  renderer follows. The gap between the two heights is hundreds of pixels, so a
  40px tolerance is unambiguous.

The hover rules are a small state machine in `apps/overlay/shell-utils.mjs`
(`createHoverState`) rather than logic inlined in the polling loop, so the awkward
cases are testable: a pointer that rests inside must never collapse, one that
brushes the edge must not collapse, one that returns within the delay must cancel
it, and the whole thing must produce exactly one transition no matter how long it
runs.

**The shadow needs room.** A CSS `box-shadow` on a transparent Electron window is
clipped flat at the window edge, so the window is now `card + 2 x SHADOW_PAD`
(24px) and the card is centred inside that margin. The shadow's reach
(`offset-y + blur/2 + spread` = 19.2px at the default size) is asserted to fit
inside the margin, because a clipped shadow reads as a rendering bug rather than a
shadow. `hasShadow: false` stays: the *native* shadow would be a rectangle around
the whole window, margin included.

## 2026-09-15 — sharing the stylesheet reader

`check-layout.mjs` had its own CSS evaluator; the new interaction check needed the
same one. It now lives in `tools/css-values.mjs` and both import it, so the two
checks cannot disagree about what the CSS says. Two traps found while extracting it:

* A comment sitting above a rule is swept into that rule's selector by a
  `([^{}]+)\{...\}` scan, which silently broke a selector lookup. Comments are
  stripped up front.
* `splitTopLevel` splits on whitespace *and* commas, which is right for `max(a, b)`
  arguments and wrong for a comma-separated list: it chopped every `box-shadow`
  layer into its individual lengths. `splitCommas` and `splitWhitespace` are now
  separate functions.

`tools/check-interaction.mjs` also parses `index.html` into a tree and asserts the
nesting (`#mini` is a sibling of `#card`, not inside it; the top-bar controls are
inside `.card`). A misplaced closing tag still loads and still parses — it just
puts the card in the wrong parent and nothing lines up afterwards.

**PowerShell 5.1 writes a UTF-8 BOM with `Set-Content -Encoding UTF8`**, and
`-Encoding utf8NoBOM` does not exist there at all. Use `node` for file surgery:
its `writeFileSync(..., 'utf8')` has no BOM. A BOM is legal in a JS module but
breaks byte-level checks and is one more silent difference from a hand-written file.

## 2026-09-15 (2) — "the fix didn't take" and the band, again

The user came back with three things, and the first lesson is not about any of them.

### A fix can be applied and never loaded

`ui-server.ts` passed `{ cache: 'no-store' }` into the extra-headers object, which
writes a header literally named **`cache`**. That is not a real HTTP header, so no
cache directive went out at all. Chromium's HTTP cache lives in the Electron profile
(`userData`), which survives restarts - so a changed stylesheet could keep being
served from cache and the change would look like it had never been made.

Two habits came out of this, both now permanent:

* The UI server sends a real `cache-control: no-store, no-cache, must-revalidate`
  plus `pragma`/`expires`, for every file *and* for `config.json`.
* The shell prints the mtime of the UI files it is about to serve, at startup. With
  no build step, "which code is actually running?" is a real question, and it should
  be answerable from the terminal rather than guessed at.

### Invert the drag region instead of carving out of it

The band was *still* unclickable after its hit box was padded to 26px, while an
identical `<button>` in the top bar worked. The remaining suspect was
`-webkit-app-region`: `html, body` declared `drag`, making the whole window a title
bar, and controls relied on `no-drag` carve-outs. On a **transparent Windows
window** that did not hold for the band.

Rather than keep guessing at how the region is resolved, the scheme is inverted:
`body` declares no region at all, and the *grab handles* opt in
(`.cover-wrap`, `.title`, `.artist`, the mini bar's cover and text). A control that
is not inside a drag element cannot be swallowed by one, whatever the resolution
rules turn out to be. The cost is that the transparent shadow margin and the gaps
between blocks no longer drag the window; the cover is a ~340px square, so there is
plenty left.

The band also moved from `click` to `pointerdown`: a click needs press and release
on the same element, and the band is rebuilt from inside its own handler.

### One symptom, two bugs: never gate a feature on a handshake

The roll-up was gated on an `overlay:ready` IPC message from the preload, so *any*
preload problem produced exactly one symptom: "the card never rolls up". The
handshake is gone - the gate is `webContents.once('dom-ready')`, which is entirely
about the page having a document and a size. The roll-up needs nothing from the
renderer, and now nothing from the renderer can break it.

The lock state moved to the shell for the same reason, and now has two UIs: the card
button and a tray checkbox. It is persisted in `window-state.json` and defaults to
**on** - an overlay that rolls itself up the first time the pointer wanders off is a
surprise on first run, while not rolling up is merely inert. Because the tray owns a
copy of the control, the overlay can never end up in a state its user cannot change,
even if the preload never loads.

### Diagnosing "it cannot be clicked" from outside

There is no browser here, so the only way to settle a hit-testing question is to ask
the page. `CardView.reportHitTargets()` runs once at startup and logs, for every
control, its box and what `elementFromPoint` says is on top of it - plus, in the
shell's terminal, a `BLOCKED` line naming what is covering it. Controls that CSS
says are not hit-testable yet (the top-bar buttons before hover, the mini bar while
rolled up) are reported as `inert` instead, so only a real obstruction is flagged.
Every successful colour pick also logs its index and hex.

### The faint jitter after a flip

Plausibly self-inflicted. `--card-height` used to come from `stage.clientHeight`,
which is an integer; it became `width * STAGE_ASPECT`, a fraction, putting every
absolutely-positioned face on a sub-pixel boundary. Both stage heights are rounded
now, matching `Math.round(card * aspect)` in `fitWindow`.

There is a second, independent cause: a face left at `rotateY(0deg)` keeps its own
composited layer, and Chromium re-rasterises it when the transition ends, which can
differ from the static card by a sub-pixel. So `data-settled` drops the transform
entirely once the flip is over. `transform: none` still animates - the spec treats it
as the identity matrix when interpolating - so the next flip works normally.

## 2026-09-15 (3) — reading the terminal output

The user pasted the startup log, and it answered everything at once.

### The tray icon was taking down the roll-up

```
UnhandledPromiseRejectionWarning: Error: Argument must be a file path or a NativeImage
    at createTray (main.mjs:507)
```

`new Tray(makeIconPng(...))` handed Electron a raw PNG **Buffer**. `Tray` - and
`BrowserWindow.icon` - want a `NativeImage` or a path. The throw happened in the middle
of the `whenReady()` chain, so **everything after it never ran, including
`startHoverWatch()`**. That is exactly the reported symptom: "no auto collapse, it stays
expanded". Two unrelated bugs presented as one, and the second one hid behind the first.

The icon itself was fine - the PNG decoded into a rounded square with a play triangle,
checked with an image viewer. The shell now wraps it in `nativeImage.createFromBuffer`
and warns if the result `isEmpty()`. Two lessons, both now enforced by
`tools/check-shell.mjs`:

* **Start optional features last, and wrap them.** `startHoverWatch()` runs before
  `createWindow()` and `createTray()`, the tray is inside a `try`, and the whole chain
  has a `.catch`. A broken tray icon must not be able to disable the roll-up.
* **Check that the image data decodes, not just that the container is well-formed.** The
  CRC checks all passed on a file whose pixels could still have been unusable. The check
  now inflates the IDAT, asserts the scanline length, and probes two pixels.

### Dragging had to come back

Removing the window-wide drag region in the previous round was an overcorrection: it made
the band work but left the window impossible to move. The right shape is to **subtract the
card in one rect**:

```
html, body  { -webkit-app-region: drag }     /* the whole window, margins included */
.card       { -webkit-app-region: no-drag }  /* one rect covering every control */
.cover-wrap, .title, .artist, .progress, .credit, .lyrics { -webkit-app-region: drag }
```

The band's original failure was the *size* of its carve-out (4px), not the mechanism: an
18px button in the top bar always worked under exactly the same scheme. Carving out the
card as a whole means no control can be swallowed however small it is, and the large
non-interactive surfaces opt back in so the window can still be dragged - `.lyrics` is in
that list because the back face has no other handle. The transparent margin around the
card is draggable too, so the window can be moved even if a handle is missed.

### The layout check was reading the wrong rule

Adding `.credit` to a comma-separated group near the top of `card.css` made
`check-layout.mjs` report a 14u shift in the credit line that did not exist. Two separate
flaws in `tools/css-values.mjs`:

* `declaration()` used `\.credit\s*\{`, which matches only the **last** selector of a
  comma-separated rule - so the group matched and the real rule was never seen.
* It scanned only the *first* matching rule, so a selector appearing twice (`.card` has a
  drag rule and then its real box) answered with whichever came first.

It now splits selector lists and takes the last declaration, like the cascade. Both are
pinned by checks, because both produced confident wrong answers rather than errors.

## 2026-09-15 (4) — stop betting on `-webkit-app-region`

Three rounds produced three different arrangements of drag regions, and each one traded
one broken feature for another:

| arrangement | colour band | window movable |
| --- | --- | --- |
| body draggable, 4px band carve-out | **broken** | yes |
| body draggable, 26px band carve-out | **broken** | yes |
| nothing draggable | yes | **broken** |
| body draggable, card carved out in one rect | untested | assumed |

The two requirements genuinely pull against each other, and their failure modes are not
equal: a window that cannot be moved is an annoyance, a control that cannot be pressed is
a bug. So the mechanism is gone entirely - **no element declares `-webkit-app-region`** -
and dragging is an ordinary pointer gesture in `ui/src/drag.js`: press anywhere that is not
a control, then move.

Three details make that gesture safe rather than a new source of bugs:

* The window position is `dragTarget(originBounds, totalDx, totalDy)` - a pure function of
  the **total** delta since the press, not an accumulation. A dropped or coalesced pointer
  event therefore cannot make the window drift. It is unit-tested, including that the
  captured origin is never mutated.
* `setPointerCapture` is used, because a fast flick can otherwise release the button
  outside the window and leave the drag running.
* `dragStart` is sent on the press but `dragEnd` is **always** sent, even when nothing
  moved. Skipping it for a plain click left a drag open, and the shell skips every
  auto-collapse tick while a drag is open - which would have reproduced the exact "never
  rolls up" symptom this round was fixing. The shell additionally drops a drag that has had
  no traffic for 30s.

### The tray icon, and why one bug hid another

The user's startup log contained the whole answer:

```
UnhandledPromiseRejectionWarning: Error: Argument must be a file path or a NativeImage
    at createTray (main.mjs:507)
```

`new Tray(makeIconPng(...))` handed Electron a raw PNG **Buffer**; `Tray` and
`BrowserWindow.icon` want a `NativeImage` or a path. The throw happened in the middle of
the `whenReady()` chain, so **everything after it never ran, including
`startHoverWatch()`** - "no auto collapse, it stays expanded", exactly as reported. Two
unrelated bugs presenting as one, the second hidden behind the first.

The icon itself was fine; the PNG decoded into a rounded square with a play triangle. Two
lessons, both now enforced:

* **Start optional features last, and wrap them.** `startHoverWatch()` runs before
  `createWindow()` and `createTray()`; the tray is inside a `try`; the whole chain has a
  `.catch`. A broken tray icon must not be able to disable the roll-up.
* **Check that the image data decodes, not just that the container is well-formed.** Every
  CRC passed on a file whose pixels could still have been unusable. `check-shell.mjs` now
  inflates the IDAT, asserts the scanline length, and probes two pixels.

## 2026-09-15 (5) — "no lyrics" and "the request failed" were the same thing

Read from a leftover host's log rather than from a report:

```
[00:00:15] info  歌词来自客户端（仅制作人员信息）: 561981284（2 行，逐字=false）
[00:00:15] debug 公开接口无可显示歌词: 561981284（等待客户端）
[00:01:12] info  歌词来自客户端（仅制作人员信息）: 29185029（2 行，逐字=false）
[00:01:13] debug 公开接口无可显示歌词: 29185029（等待客户端）
[00:01:20] info  歌词来自客户端（仅制作人员信息）: 2013145999（2 行，逐字=false）
[00:01:21] debug 公开接口无可显示歌词: 2013145999（等待客户端）
```

Four tracks in a row where the only lyrics on screen were the composer credits. That is a
legitimate outcome for a track nobody uploaded lyrics for - but it was also what a **failed
request** produced, because of two things in `lyrics.ts`:

* `fetchFromApi` returned `null` both for "the request failed" and for "the response had
  nothing in it", and the caller logged the same line for both.
* Nothing retried. A single timeout, one HTTP 500, or one transient rate limit therefore left
  that track showing credits only for the rest of the session.

A failed fetch is now distinguished from an empty result, retried once after 1.5s (abandoned
if the track changes first, including mid-pause), and never written to the cache - a network
error says nothing about whether a track has lyrics. Retrying is what the 60-second no-lyric
TTL was already trying to work around, from the wrong end.

`packages/host/src/lyrics.test.ts` is new and covers all of it: retry on a thrown error and on
an HTTP 500, give up after the second failure, do **not** retry an empty result, discard a
result that arrives after a track change, abandon the retry pause when the track changes during
it, and serve a repeat visit from memory. The retry delay is injectable so the suite stays fast.

## 2026-09-15 (6) — four reported symptoms, three mechanisms

### The hourglass at startup was a window that did not exist yet

`whenReady()` started the host and then `await waitForUi()` **before** `createWindow()`. For as
long as the host took to spawn, load and bind its ports there was no window at all - and Windows
shows its "starting" cursor (the arrow with an hourglass) for a process that has not opened a
window yet. Nothing to do with memory; the fix is ordering. The window now comes up immediately
with a data-URL placeholder, and the real UI is loaded once the host answers.

The startup block's order is now asserted rather than described: watcher, then window, then tray,
then the wait for the host, then `loadUi()`.

### The roll-up felt slow because of two numbers

Sampling every 120ms plus a 600ms delay is up to 720ms after the pointer leaves. Now 60ms and
300ms - a deliberate move away is obvious well before half a second, and the delay is the part
that is actually perceived.

### The drag: the cursor was outrunning the window

Reported as "dragging works at first, then it suddenly rolls up into a strip and cannot be
expanded again". Both halves are the same mistake. The renderer reported pointer deltas and the
shell applied them, so:

* the window lagged the cursor, the cursor left the window, and `pointerup` never arrived;
* Chromium's `pointercancel` / `lostpointercapture` - which fire when a window is moved under a
  captured pointer - ended the gesture while the button was still held.

With a drag open the shell skips every auto-collapse tick, and once it closed the pointer was
outside, so the card rolled up. It then sat where the drag had left it, which is not necessarily
anywhere reachable.

Now the **shell** moves the window: it watches the OS cursor and holds the pressed point at a
fixed offset inside the window. The cursor cannot outrun the window, so it cannot escape, so
`pointerup` always arrives. Plus:

* every position is clamped to the display (`clampToWorkArea`), which is what makes the strip
  recoverable - it sits along the window's *top* edge, so a window above the top of the screen
  would put the strip where no pointer can reach it;
* a cancel or lost capture is recoverable: the next move with the button still down re-arms the
  gesture, so a spurious cancel costs nothing;
* every end is logged with its reason, so if it happens again the terminal says which path fired;
* the tray has an explicit **展开卡片** item. A card whose only recovery is a pointer target
  cannot recover from being somewhere the pointer cannot go.

### The flip jitter, and a guess that was removed

The previous round's `data-settled` (dropping the transform 470ms after a flip) did not help - and
a style change shortly after an animation is itself something to see - so it is gone. The
replacement is the opposite approach: `will-change: transform, opacity` on `.face` keeps both
faces on their own compositor layers from the first paint, so a flip no longer promotes and then
demotes a layer. A layer's raster can differ from the main frame's by a sub-pixel, which is what a
slight shift of detailed artwork looks like. Still a hypothesis; it is flagged as such.

### PowerShell mangled `main.mjs` again

`Get-Content -Raw` followed by `Set-Content` destroyed every Chinese string literal in the file -
the exact trap already written down in these notes, ignored because it was "only a mechanical
line-range replacement". The file was restored with `git checkout --` and the edits were re-applied
with the edit tool.

**Rule, with no exceptions: never round-trip a source file through PowerShell.** Not for a
one-line change, not for a whole-file rewrite. Use the editor tools, or `node` with
`writeFileSync(..., 'utf8')`.

## 2026-09-15 (7) — a check that depended on the environment

`npm run check` went red with seventeen `fetch failed` lines and nothing in the diff to explain
them. The cause was that `check:ui` talks to a *running* host on port 8788, and no host was
running. It had been passing for hours purely because a leftover host from an earlier session was
still holding the port - the check had never been self-contained, and nobody had noticed because
the machine happened to be in the right state.

That is the worst property a check can have: it is believed. It now probes the UI port and, when
nothing answers, starts its own host - with `stdio` pointed at a log file rather than a pipe, since
the sandbox refuses piped stdio - waits for it, and stops only the host it started. Verified that
it leaves no listener behind.

A second file, `MEMORY.md`, was started the same day as a maintainer's local notebook: the current rules,
constraints, invariants and traps, as opposed to this file, which is the chronological record of how they
were learned. It is deliberately **not** in the repository (see `.gitignore`) - a clone gets the record,
not someone else's scratchpad - so anything here that refers to it is referring to a local file.

## 2026-09-15 (8) — a jump reads as slow, and a window that grew while being dragged

### Cutting the delay did not make the roll-up feel faster

Reducing the delay from 600ms to 300ms helped, but the user still reported it as slow - and their
own suggested fix was the right one: add a fast animation. That is the actual diagnosis. A resize
with no motion gives the eye nothing to judge the speed by except the pause before it, so the pause
is all that gets perceived. The roll-up now tweens over **140ms** with an ease-out curve, and reads
as a quick movement rather than a wait followed by a jump.

Two things had to change with it, or the motion would have looked wrong:

* **The stage is anchored to the window's top** instead of being centred. The window's top edge
  stays put and its bottom edge comes up, so the card is *eaten from below* - which is the roll-up.
  A centred stage would have shrunk the card towards its middle from both ends.
* **The mode threshold moved to the collapsed height.** It used to be `expanded - 40`, so a
  collapse would have swapped the card for the strip 40px into the animation and popped. The card
  now stays the card until the window is essentially the strip, and the clipping does the work.
  `ui/test/layout.test.mjs` pins that, because it is invisible from the tooling side and
  unmistakable on screen.

Both also removed the last `transform` from an ancestor of the card, which the flip work had
already been suspicious of.

### The card grew while it was dragged

`dragTarget` was fed `getBounds()` every frame and its result written back with the same size -
which looks obviously harmless and is not. `getBounds()` and `setBounds()` round-trip through
physical pixels; on a display whose scale factor is not a whole number (125% and 150% are the common
Windows ones) each round trip can land a fraction of a pixel out, so every frame can write a size
slightly larger than it read. At 60 frames a second that compounds into visible growth, ending in
whatever resizes the window next - which is why the "sudden shrink" always arrived with it.

The size is now captured once, at the press, and reused for the whole drag. `endDrag` compares the
window against it and warns if anything else resized the window mid-drag, so if the capture was not
the whole story the terminal names who else was involved. The resize tween steps from values
captured once, for the same reason.

**Generalised**: never feed a window's own geometry back into the next `setBounds`.

## 2026-09-15 (9) — a timer is not a frame clock, and two luminance measures with one name

### The drag stuttered because the shell polled the cursor on a timer

The window was moved from a `setInterval(16)` in the main process. That fires *near* every frame,
not on it: sometimes twice within one frame, sometimes not at all. Every individual step was the
same size, but the irregularity is what the eye reads as 卡顿.

The cursor position now comes from the renderer's `pointermove`, which is delivered in step with
the compositor and carries the position as of the frame being drawn, and the shell is sent absolute
screen coordinates at most once per animation frame. Two smaller things went with it:

* the 3px movement threshold before a drag started is gone. It existed to stop a click nudging the
  window, which the shell already handles - and it cost the first few pixels of every drag, which
  is felt as lag at exactly the moment responsiveness is being judged;
* `getDisplayMatching` is no longer called per move. It is a synchronous query, and it was on the
  cursor path.

**Generalised**: `setInterval` is not a frame clock. Anything that has to look smooth should be
driven by `pointermove` or an animation frame.

### A dark-blue cover came out with a dark-grey swatch

The user reported it precisely: ロンググッドバイ's cover is mostly deep blue, including broad dark
blue areas at the edges, and the darkest swatch was dark **grey**.

The cause was a unit mismatch that had been sitting in `palette.js` all along. The "too dark to be
worth showing" guard in `isUsable` was written against the **WCAG relative luminance** with a 0.06
cut. That is the measure for *contrast*: it weights blue at 0.0722 and then linearises. A rich dark
blue like `#203060` measures 0.034 there - below the cut - while the same colour is 48 on the 0-255
luma. So the guard threw away exactly the swatches the artwork was made of, and the darkest band
had to be filled with whatever grey survived.

Three things were wrong together, and all three are now fixed:

* the filter uses `luma255`, and judges on *hue* rather than brightness: only a colour that is both
  extreme **and** colourless is dropped, so a dark saturated blue is kept;
* `detectExtremes` uses the same threshold. The old pair (luma 32 for "extreme", WCAG 0.06 for
  "usable") left a band of mid-dark colours that both halves dropped;
* saturation is HSL saturation, not `(max - min) / max`. The old form divides by `max`, so a colour
  at 20% brightness could never report more than 0.2 of "saturation" however strong its hue was -
  which is precisely the case a dark cover presents.

`ui/test/palette.test.mjs` is new and encodes the report: for a mostly-dark-blue cover, the darkest
swatch must be blue (hue 200-260°, saturation > 0.25) and at least three of the five swatches must
be blue. It also pins the cases that were already working - a greyscale ramp, a black-and-white
cover showing both extremes - so the fix cannot be "make everything blue".

**Generalised**: choosing a colour and judging contrast are different jobs with different measures.

## 2026-09-15 (10) — `map` passed the index, and a timer is still not a frame clock

### The grey swatch was `Array.prototype.map`

The user's description was exact: the first swatch was a deep grey that appeared nowhere in the
cover, blue showed up only as a *lighter* blue in positions three and four, and the bug affected
both blue and red covers.

The line responsible was one word long:

```js
return chosen.map(boostSaturation);
```

`Array.prototype.map` calls its callback with `(element, index, array)`, and `boostSaturation`'s
second parameter is `factor`. So the first swatch was boosted by **0** - which collapses every
channel onto the midpoint of the colour, i.e. **a pure grey** - the second was boosted by **1**,
leaving it untouched, and the third, fourth and fifth were multiplied by 2, 3 and 4, blowing the
darkest blues out to a saturated primary. On a light cover the midpoint of a bright colour is a
plausible-looking light neutral, which is why it survived unnoticed for so long and why the user
could still say most covers looked fine.

The diagnostic that found it: `tools/…`-style scratch script running the real pipeline over a
synthetic cover and printing every stage. The candidate list was *entirely blue* and the output's
first entry was still `#232323` - and `#232323` is the midpoint of the darkest candidate, so the
`factor` had to be 0. Reconstructing the other four from factors 1, 2, 3, 4 matched the observed
output exactly.

**The test that should have caught this did not.** "The darkest swatch is blue" passed with the bug
present, because the swatch with factor 4 had two channels driven to zero and was therefore
*darker* than the fabricated grey. The new assertions are about the first slot, and about the
palette as a whole: no neutral swatch when the artwork has no neutral colour, no hue the artwork
does not contain, and no saturation far beyond the artwork's own. Reverting the fix now fails five
of them, including `rgb(35,35,35)`.

**Generalised**: `map`, `filter` and `forEach` pass the index. Wrap the callback.

### The resize tween was still on a timer

The drag was made smooth by driving it from `pointermove` instead of a `setInterval`, and the
roll-up tween was left behind on the very same pattern - so it stayed 一顿一顿的 for the same
reason. `requestAnimationFrame` lives in the renderer and nowhere else in this app, so the shell
now *asks* for a tick and the renderer answers once per frame for the length of the tween. The
values stay in the shell: it computes each step from its own clock, so a late tick delays the
motion but cannot distort the curve. A token per tween means a straggler cannot move the window
after a newer animation has started, and a timer backstop finishes the move if the renderer stops
answering.

### Three ways the roll-up could stall, all now bounded

"偶尔鼠标移开却一直没有收缩" has three candidates, and all three were reachable:

* a **leaked drag**. The pointer watcher skips every tick while a drag is open, so a renderer that
  never sees the `pointerup` leaves the card unable to collapse - for the 30 seconds the stale
  guard allowed. Now 4 seconds, which is safe because the renderer re-arms on the next move with
  the button held, so ending a live gesture by mistake costs nothing;
* **suppression after a drag**, which was 2.5 seconds of "never collapse" starting from the moment
  the drag ended. The watcher already skips while the drag is open, so the per-move suppression was
  redundant; the settle window is now 350ms;
* a **bad pointer sample**, which called `hoverState.reset()` and so restarted the "pointer has been
  away" timer. An error every other tick could therefore keep the collapse from ever reaching its
  delay. A failed tick is now skipped without touching the state.

And because a stall may still have a cause none of this covers, the watcher now reports one: if the
pointer has been outside for a second longer than the delay and the card is still expanded - with
every guard already passed - it prints the state machine's own view along with `locked` and
`ready`.

## 2026-09-15 (11) — the tray is not a control panel

Asked for directly: "windows 右下角小图标那里不需要那么多选项，只需要更改尺寸和退出的选项即可".
It had accumulated show/hide, expand, centre, a lock checkbox and a collapse item - a control panel
in the notification area.

Cut to three sizes and 退出. What matters is that **nothing became unreachable**, and the check
asserts each of those separately rather than trusting that the menu shrank:

* show/hide, and recovery from a rolled-up card, are the tray icon's own left-click. `showWindow`
  un-collapses, so a card stuck as a strip comes back expanded;
* the lock is on the card and on `L`, and is still owned and persisted by the shell - removing the
  checkbox did not move the state anywhere;
* centre was only ever a convenience for a window someone had dragged somewhere odd.

The menu is also built once now instead of being rebuilt whenever the lock changed, since nothing
in it is stateful any more. `trayTemplate` survives as a function only so the check can read the
menu's contents out of the source and assert what is *not* in it.

## 2026-09-15 (12) — the biggest button on the card was dead

Asked what to do next, so: the transport deck. It turned out to be broken, and the way it was
broken is worth recording.

Three pieces of the same feature, each of which looked right on its own:

| Piece | Said |
| --- | --- |
| `packages/shared/src/types.ts` | `ControlCommand` includes `{ type: 'playPause' }` |
| `ui/src/main.js` | the button and the space bar send `{ type: 'playPause' }` |
| `packages/host/src/bridge-script.ts` | the switch handles `play`, `pause`, `stop`, `next`, `previous` … **and has no `playPause` case** |

So every press fell through to `default: throw new Error('unsupported command: playPause')`. The
bridge *did* implement `setAudioPlayerPlay`/`Pause`; the UI simply never reached them. Two halves
that each look plausible, and a seam nobody was looking at. `docs/contracts.md` had it filed as
"not yet pinned down" the whole time.

It was also invisible from the outside, because the UI flipped the button optimistically and then
ignored the `ControlResult` entirely - so the button appeared to work for one frame and then undid
itself. That is worse than a dead button: it is a dead button that lies.

Three things came out of it:

* the bridge reads the client's own `playingState` (1 = paused, 2 = playing) and calls the right
  function, on the module rather than on a destructured reference;
* **the host confirms the outcome.** `ok` only ever meant "the command reached the page and did not
  throw", which is not the same as the client reacting - and the difference is the whole bug. After a
  transport command the host reads `playingState` again for up to 900 ms and the log says `成功`,
  `未确认` or `失败`. `ControlResult.confirmed` carries it to the overlay, which reverts its
  optimistic flip when the client did not follow;
* `tools/check-bridge-script.mjs` now cross-checks the whole contract: every type in the
  `ControlCommand` union must have a `case` in the bridge's `execute` switch, and every command the
  overlay sends - literals in the UI plus the buttons' `data-action` - must be both declared and
  handled. Deleting the `playPause` case fails it, which is the point.

**The generalisable lesson**: a command has three ends - the contract, the sender, the handler - and
checking only two of them proves nothing.

### The audio module call runs and changes nothing

Wiring the case up fixed the *first* half and proved the second: the command now reaches the page,
`setAudioPlayerPlay(null, null)` runs without throwing, and the client's `playingState` does not
move. The confirmation the host gained in the same change is what made that visible - `成功` vs
`未确认` - and without it the second half would have looked exactly like a working button.

The signature is not knowable from disk: the install directory has no `.js` at all (the web bundle
is packed into `orpheus.ntpk`, 35 MB, whose contents do not include the export names as readable
text). So the transport now falls back through a ladder, and the ladder reports which rung worked:

1. the audio module, as above;
2. **a media key** - `VK_MEDIA_PLAY_PAUSE` injected with `keybd_event` from `tools/media-key.ps1`.
   This is the client's own global hotkey, i.e. the path a keyboard's play button uses, so it does
   not depend on the client's internals. Because the key *toggles*, it is pressed only after
   re-reading `playingState`: a pipeline call that was merely slow followed by a toggle would land
   the client back where it started;
3. **a page-side diagnostic** (`{ type: 'diagnoseTransport' }`) reporting the play/pause exports and
   their arity, every dva action whose name mentions playing, and the client's own transport
   buttons in the DOM. It is requested when both paths fail, so the next attempt is not a guess.

`tools/media-key.ps1` is verified as far as this machine allows without pressing a key that would
reach whatever else is playing: PowerShell parses it, and its `keybd_event` declaration compiles
under 5.1. Whether Windows delivers the key to the client is the one step only the user can test -
if the client's global-hotkey option is off, nothing will.

`tools/check-encoding.mjs` grew a rule while adding it: **every `.ps1` must be ASCII-only**, because
PowerShell 5.1 reads them as ANSI unless they carry a BOM and silently corrupts non-ASCII literals.
Both scripts already said so in their headers; now it is enforced.


### A string that is not a template

The bridge script is generated by *string assembly* inside one big template literal, and its header
says so: "Pure string assembly; do not add template holes below." I added `${...}` holes and
backticked comments, which terminated the outer literal and turned the rest of the file into
TypeScript. `npm run typecheck` caught it immediately, but the failure message was
`ERR_INVALID_TYPESCRIPT_SYNTAX` from a file that is *valid* TypeScript - because the damage was
inside a string. Worth remembering: when a generated script breaks, the error is reported at the
wrong level.


## 2026-09-15 (13) — the handler was there and the page was running the old one

The user tested the transport and pasted the host log. Every line still read
`unsupported command: playPause`, for a case that had been added and verified in the source. The
bridge had `case 'playPause'`; the client was executing a script that did not.

The guard meant to prevent exactly this compared a hand-written `version: 2`:

```js
if (window.__moBridge && window.__moBridge.version === 2) return;   // "already installed"
```

Nobody had bumped it when the switch gained a case, so the stale bridge - with its subscriptions and
its command timer - was kept and the new one never installed. **A hand-maintained version number is a
promise to remember; a hash of the script is a fact.** It is now:

* `hashScript(source)` (FNV-1a) over the script body, substituted at `__MO_BRIDGE_ID__`;
* an installed bridge whose id differs is `dispose()`d before the new one starts, so there is never a
  moment with two command timers running;
* `tools/check-bridge-script.mjs` asserts the id is an 8-hex hash **of the script's own body**, that
  different content yields a different id, that the dispose path exists, and that no placeholder
  survives. The last one matters because a silently unsubstituted placeholder would ship a bridge
  that never replaces itself again.

The lesson under the lesson: the previous round's diagnosis ("the client ignores the audio-module
call") was drawn from a log produced by code that was never running. Measuring is not enough if what
is being measured is not what was built.

### A fallback ladder was the wrong shape

The ladder from the previous round - audio module, then media key, then diagnostic - was rebuilt as
**media key primary**. A media key is the client's own global hotkey, so it does not depend on
internals that a client update can rebuild; the bridge route stays for `setVolume`, `toggleMute` and
`setMode`, which have no media-key equivalent.

The important part is what was *removed*: a ladder implies trying the next rung when the current one
is unconfirmed, and for a toggling key that is a double action. Press play, watch for 900 ms, decide
it did not take, press again - and the user's music starts and stops. So there is now exactly one
`pressMediaKey` call and exactly one entry into `controlViaBridge`, from the `!key` branch. Both are
asserted in `tools/check-interaction.mjs`, next to the mapping table, because that is the kind of
invariant that a well-meaning "and if that fails, also try…" edit would quietly destroy.

### `432x740` instead of `432x744`

The same log had a line the size check had been printing all along:

```
拖动中窗口尺寸被系统改动: 请求 432x740，实际 432x741
```

One pixel, from DIP rounding - but the requested pair was not a card at all. 432 wide implies 744
tall; 740 is 4 short. `animateGeometryTo` writes the target width immediately and interpolates the
height, so a drag that began mid-tween captured a width from one size and a height from another, and
then held that mismatched pair for the whole drag. The fix is to land the tween *before* reading the
bounds, and the order is the entire fix, so the check compares the two offsets in the `drag-start`
handler rather than just looking for the lines.

### Assertions verified by breaking them

Three of the new checks were run against deliberately mutated sources in a throwaway
`.scratch/mutate.mjs` (gitignored) - delete the `playPause` mapping, add a bridge call after a failed
media key, read the size before landing the tween - and each one failed the corresponding check. A
check that has never failed is not known to be a check, and one of these rounds already produced a
palette test that passed for the wrong reason. The mutation script restates a couple of the
predicates to do that, so it is a scratch artefact rather than a second check: what it proves is that
the *shape* being asserted is capable of going red, not that the shipped check is complete.














## 2026-09-15 (14) — three controls the media keys could not reach

The transport works now (the owner confirmed play/pause and skipping), so the next three controls all
had the same problem: **there is no media key for "play this mode", "this volume" or "this position"**,
so unlike play/pause they have to go through the client — and the client's internals are packed.

The rule from the previous round applies with full force: `ok` is not evidence. So each of the three
was established by *driving the client's own control and reading the result*, and then implemented as
the thing the client itself does. Three instruments, all still in `tools/`:

- `probe-controls.mjs` (read-only): the mode enum, every `audioplayer.*` call, and — the useful one —
  `Function.prototype.toString` of the `AudioPlayer` wrapper's own methods. A class instance keeps its
  methods on the prototype, so no exports-scanning trick can see them; asking the object itself can.
- `probe-client-ui.mjs` (**mutating**): real CDP `Input` events on the client's own buttons and
  sliders, with `store.dispatch` tapped and the wrapper's methods wrapped. It moves the user's
  playback, so it also restores mode and volume when it is done.
- `host-smoke.mjs --control type=setVolume,volume=0.4`: the whole stack — host routing, the injected
  bridge, the client's audio wrapper, and the confirmation logic.

### The mode button dispatches nothing observable

Clicking the client's own mode button changes `playingMode` and records **zero** store actions. That
is not because there is no action: it is because the dva models captured their own reference to
`dispatch` when they were built, so replacing `store.dispatch` sees only what React components send.
An instrument that silently misses the thing you are looking for is worse than no instrument — the
first reading said "the mode is not a dispatch at all", which is the opposite of the truth.

What worked was trying a candidate and reading the client's own footer icon, which is rendered from
the store. The action is the last thing the client's own effect does:

```js
dispatch({ type: 'playing/onUpdate', payload: { playingMode: next, lastPlayingMode: current } });
```

`lastPlayingMode` is the mode we came *from*, which the client's own click confirmed:
`playRandom` → `playCycle` produced `{playingMode: 'playCycle', lastPlayingMode: 'playRandom'}`.

Four modes, and their Chinese names came from the button's own tooltip as it cycled:
`playOrder` 顺序播放 → `playCycle` 列表循环 → `playOneCycle` 单曲循环 → `playRandom` 随机播放.

### The volume action that works, runs, and changes nothing

`playing/setVolume` is a real action. It runs. `playing.playingVolume` changes to exactly what was
asked for. **And the sound does not change** - `AudioPlayer.getApplicationVolume()` stayed at 0.5
while the store went to 0.35.

This is the same shape as `next`/`previous` returning `ok: true`: a receipt that describes the
*command*, not the *world*. The difference is that the store field moved, which is what makes it
seductive — the card would have shown the right number and the music would have ignored it.

The client's own volume slider dispatches nothing at all (dragging 0.42 → 0.30 recorded zero
actions, and the store followed anyway, through the client's native-to-store subscription). The call
is `AudioPlayer.setVolume(v)`, the same one the client's `stepVolume` effect makes.

### `muteVolume` does not mean muted

Latent, and found while wiring volume up: the host had been reporting
`muted: muteVolume > 0`. The client's mute effect *remembers* the current volume in `muteVolume`
before setting the volume to 0, and unmuting restores it without clearing the field. So
`muteVolume > 0` is true before a mute, during it, and after it — and the card would have drawn a
silenced speaker for a track playing at full volume. Muted is `playingVolume === 0`.

### Seeking: 109 means 109 seconds

`audioplayer.seek` takes three arguments and nothing on disk says what they are. Wrapping the
wrapper's `seek` (on the instance, which shadows the prototype method) and dragging the client's own
progress bar answered it in one shot:

```
seek({ playId: "2102424489_UOH3CY", seekId: "2102424489|seek|46YB26", value: 109 })
  → { playId, seekId, code: 0, position: 109 }   playhead: 125s → 131s
```

Whole seconds; `playId` from the progress stream; a fresh `seekId` per call because the reply is
matched by it. The reply is a genuine receipt — a code and the position the player moved to — so
`ControlResult.positionMs` carries it and the host can confirm a seek without waiting for the next
sample.

The conversion lives in the bridge (`Math.round(ms / 1000)`), which cannot import the shared helper
because it is string-assembled and carries no imports. So the rule is written twice, and
`packages/host/src/transport.test.ts` extracts the bridge's own line and *evaluates* it against the
shared function — the duplication is checked rather than trusted.

### The button felt slow because it was drawn twice

The owner's report was "暂停和播放按钮的切换反应时间有点慢", and the command was never slow: a media
key is immediate. The *drawing* was the problem. The client takes a moment to act on the key and
keeps publishing snapshots until it does, so a card that drew every snapshot verbatim flipped the
button, flipped it back, and flipped it again.

The optimistic flip is now **held**: it wins over incoming snapshots until the client agrees, the
host reports a failure, or 1.2s passes. That needs a `displayedStatus()` in one place and a
`setStatus()` on the card view, because the revert has to redraw the status alone — a whole snapshot
is not available at that moment, and rebuilding one to change one attribute is how a revert ends up
reverting something else too.

The same shape appeared again in the volume bar: the commit reaches the native player, and until it
reports back, snapshots still carry the *old* volume. So the chosen volume is held too, until the
client's own value arrives.

### Two gestures on two bars, one helper

The progress bar and the volume bar are the same gesture in two directions, so `ui/src/scrub.js`
handles both. The parts that are easy to get wrong are the parts that already went wrong once each
in this project: pointer capture (a drag that leaves the element must keep reporting), `pointercancel`
and `lostpointercapture` (**not** releases — Chromium fires them when the window moves under the
pointer, and committing there seeks to wherever the pointer was when the browser gave up), measuring
the ratio from the *strip* rather than the event target (the fill is a child, so a press on the fill
arrives with the fill as target), and committing once on release rather than once per frame.

Both bars take their hit area from a `::before` overlay rather than padding: a 1.48u bar is about 6px
tall on a 440px card, and a 6px target is not a target. The colour band solved the same problem with
padding plus a cancelling negative margin, but that moves everything measured after it — fine for the
band (nothing is measured below it), not fine here.

They also had to be added to the window-drag gesture's exclusion list, or pressing the progress bar
would move the window *and* scrub at the same time.

One more conflict, and it is the same double-action shape as a media key with a fallback: the arrow
keys are the card's skip keys, so an arrow pressed while the bar has focus would seek **and** change
track. The bar stops propagation for the keys it handles.

## 2026-09-15 (15) — the layout moved out from under the pointer

Two things happened in this round, and the first one is a bug that had been sitting in the drag
feedback since it was written.

### Thickening the bar moved the card

The scrubbing state said `height: calc(var(--u) * 2.1)` on `.progress-track`, up from 1.48u. The
track is an ordinary block in the face's column, so the moment the pointer went down on the progress
bar, the times line, the whole transport row, the colour band and the credit all dropped 0.62u - and
came back up on release. The control you are dragging moves the layout, which is the one thing a
control must never do.

It was invisible to every check, because no check looks at what a *state* changes; they all look at
what a rule declares. The fix is `box-shadow` with a spread of 0.31u, which paints the same colour the
track already uses and occupies nothing. The assertion is generic rather than a test for `height`:
**no in-flow property may be declared by a drag state** - height, margins, padding, borders, font
size, top/bottom - because any of them is the same bug. `box-shadow`, `opacity` and `transform` are
the ones that are not. Verified by putting the height rule back and watching it fail.

The generalisable form: a state change that happens *during* an interaction is not a style question.
It is a layout question, and it needs to be checked as one.

### Inset lives on the ancestor that has it

Writing `tools/transport-layout.mjs` - which computes where the five controls land, because there is
no browser here to look at them with - produced two mistakes of my own, and the play button's
position hid both:

- the horizontal inset comes from `section.face`, not `.card`. Reading only `.card` put the mode and
  volume buttons 7u further out than they are, with the row flush against the card's edges;
- `padding: 17.69u 7.04u 8u` is a three-value shorthand: top, left-and-right, bottom. Reading it by
  index (the way a four-value shorthand works) gave left 8 and right 7.04 - **and that asymmetry is
  what would have moved the play button half a unit off the centre line.**

Both survived because a symmetric inset puts the play button at 50u either way. So the check now
asserts the symmetry the centring depends on, not only the result: the two side slots must be the
same width, the left and right insets must be equal, and the middle must land at 50.00u.

### And then the bars were drawn

`npm run icons` drew the SVG glyphs; it now also draws the progress bar (0%, 50%, 100%, and while
scrubbing) and the volume panel, using the stylesheet's own numbers - they are ordinary boxes, not
SVG, and this is the only way to see them. That is how the thumb's behaviour at the ends is known
rather than assumed: it is centred on the end of the fill, so at 0% and 100% it overhangs the track by
1.3u, which is inside the card's 7.04u inset and therefore not clipped.

The renderer also measures itself and says plainly what that proves: the numbers it draws come *from*
the stylesheet, so measuring the pixels back is a check of the rasteriser, not a second opinion about
the design. The design's assertions live in `check-interaction.mjs`.

### A slider that never moved

Noticed while reading `card.js` for the above: the progress bar has `role="slider"` and was born with
`aria-valuenow="0"`, and nothing ever wrote to it again. It announced a position of 0 for the life of
the window - worse than having no role, because the role is a promise. It is updated from the frame
loop now (only when the whole percent changes), and from the scrub preview.

## 2026-09-18 — the client updated itself, and "the state changed" was not the same as "it worked"

The owner rebooted, and the overlay said `needs-relaunch`. That turned into the most useful round of
the project, for a reason nobody was looking for.

### The version moved under the session

`npm run relaunch` was made to print the exe version, and the very next run read:

```
EXE: cloudmusic.exe  (FileVersion 3.1.40.205461)
```

Three minutes earlier the same path reported `3.1.39.205426`. The client had downloaded an update on
09-07 and **applies it when it next exits** - which is what the reboot, and then the owner's repeated
"quit and start again", were doing. Every contract in `docs/contracts.md` was measured on 3.1.39.

So the whole dependency surface was re-checked with the channel back up. It survived: discovery still
finds the store and the audio pipeline by shape (module ids moved - `1186`→`1191`, `225`→`228`,
`11`→`8` - and no code did), the page target is unchanged, client lyrics work, the `AudioPlayer`
wrapper is still module `4` with byte-identical `seek`/`setVolume`, and the mode enum is unchanged.
The one thing not yet re-checked is a `seek` while a track is actually playing.

The lesson is not "the update broke something" - it is that **the client is a dependency that changes
itself**, and the only reason it was noticed is that a tool now prints the version on every run.

### The mode command changed the field and skipped the meaning

While re-reading the 3.1.40 bundle, the client's own mode change showed up in a place it had not been
seen before: its tray shortcut dispatches `playing/switchPlayingMode {playingMode, triggerScene,
HeartBeatFlage}`. The card was dispatching `playing/onUpdate {playingMode, lastPlayingMode}` - the
*last line* of the effect that `switchPlayingMode` runs.

Everything observable agreed that this worked: the mode changed, the client's own icon followed, the
confirmation came back true. What it skipped is the rest of the effect, which walks the play queue
and re-draws every entry's `randomOrder`. That re-draw is the shuffle. So 随机播放 replayed the
previous random order - a control that looked perfect and did not do the one thing its name promises.

The two are told apart by reading the **queue**, not the mode:

```
onUpdate → 随机    randomOrder 全是旧值      ← 没洗牌
switch   → 随机    randomOrder 全部重抽      ← 洗牌
```

`tools/probe-mode-action.mjs` does exactly that, through the host and the bridge, and puts the mode
back. It is the third time in this project that a command returned success while not doing its job -
after `next` returning `ok` and `playing/setVolume` writing the store without touching the volume - so
the general rule is now written down in MEMORY: ask what a control is **for**, not whether its state
changed.

### The volume control, cut back to the bar

The owner's note: no border, the bar on the volume button's axis, and the number shown above the
slider's dot when the pointer is on it. Removing the panel removed the thing that held the readout,
and the readout is what the whole geometry then hangs on:

- the bar is centred on the button because `.volume-pop` is `left: 50%` + `translateX(-50%)` and the
  bar is its only element **in flow** - so the number had to become absolutely positioned;
- `.thumb:hover ~ .value` only selects *forwards*, so the number has to come after the thumb in the
  markup;
- and that `:hover` cannot happen at all while the thumb is `pointer-events: none`, so the thumb
  became hoverable - which is safe because a press on it still reaches the bar, and the scrub handler
  always measures from the bar's own rect, never from the event target.

The arithmetic is checked rather than eyeballed: the bar is 10u centred at 90.66u, and the 3u readout
following the thumb reaches 84.16u at 0% and 97.16u at 100% - inside the card at both ends.

## 2026-09-18 (2) — an icon, chosen by looking at it at 16 pixels

The owner asked for an app icon, inspired by records/CDs, with no fixed idea. There is no browser in
the tooling shell, so "design an icon" could easily have meant "write some paths and hope" - which is
how two wrong icons shipped earlier in this project. Instead the paths went through the same
rasteriser the rest of the tooling uses, and the candidates were *looked at*.

Two things made the decision, and neither is visible in a normal icon preview:

**The 16px view, at pixel level.** A 16px rendering dropped into a large canvas is a flattering
picture: it is surrounded by white space. Blowing the *actual* 16 pixels up by copying whole pixels
shows what the tray will paint - and at that size the record grooves are moiré, the CD's highlight
becomes a broken notch, and the music note is a smudge.

**Three backgrounds, not one.** Windows draws tray icons on whatever the taskbar happens to be. On a
dark taskbar a bare black disc disappears into the background (only the white triangle survives) and
a black note vanishes completely. The design that survived all three - light, dark and mid - was a
rounded card holding a record and a play triangle: the card gives the mark its own background, the
triangle is still legible at 16px, and it depicts *this* app rather than music in general. Eight
candidates were drawn; the owner picked that one.

So `assets/` now holds `icon.svg` (the source), `icon.ico` with nine sizes from 16 to 256, and a
256px PNG for a README. `npm run icon` regenerates them; the tray loads the .ico **unresized**, so
Windows can pick the 16px frame instead of resampling the 256px one down. The in-memory drawing stays
as the fallback, because a missing file must not cost the tray again - that is how "the card never
rolls up" started.

`check-shell.mjs` parses the .ico: header, per-frame PNG signature, IEND, no frame running past the
end of the file, and - the one that matters - the pixel size *inside* each frame against the size the
directory claims. A truncated or mislabelled .ico would otherwise surface for the first time during
packaging.

One small trap worth recording: the icon was first written to `build/`, which is gitignored here
(that is where build *output* goes). The tray would have worked on the machine that generated it and
failed on every other checkout. It lives in `assets/` for that reason, and when `electron-builder` is
added its `buildResources` has to point there.

## 2026-09-18 (3) — the third icon, and why the first two were wrong

Two designs were drawn and rejected before this one. That is not a failure of the rasteriser - which
is what made each rejection *specific* - but it is worth writing down what the rejections were, because
neither was about taste alone.

**The first mark was an all-black card with a disc.** It was chosen because it survived all three
backgrounds, and that was true. What it was not is *liked*: the owner's answer was "颜色也不要用黑色"
- and looking again at the 16px zoom, the black version was legible but joyless, a silhouette rather
than a thing. Legibility is a floor, not a target.

**The second was built from a photograph they sent** of a teal player - rounded slab, round screen,
magenta play key, two pale pill keys - and it reproduced those features faithfully: sampled colours,
the slab's thickness suggested by a darker body peeking out at the bottom, the pill keys kept because
they are what makes it read as a *player*. Rejected too. The lesson there is narrower and more useful:
"reproduce the reference" and "the reference is what they want" are different claims, and only the
owner can settle the second.

**The third is the second reference they sent, with one change of their own** - the rounded square
outside made into a circle. A red disc, a dark navy disc, a white *outlined* play triangle with a
sliver of red at its tip, two white pause bars.

The outline is the part worth recording. The reference's stroke is about 1.2 units at 24; at 256px
that is beautiful, and at 16px - the size the tray actually paints - the triangle's interior closes up
and it reads as a filled triangle with a hole. The measurement that settled it was the same one used
for everything else here: draw it at 16 pixels, blow the pixels up eightfold, put it on a light, a dark
and a mid-grey strip, and look. At 1.4 the outline survives nine sizes without becoming a solid
triangle, which would have thrown away the one feature that makes the mark the owner's rather than a
generic play button. The navy disc is also a little larger than the reference's proportion, for the
same reason: at 16px, a unit of glyph is worth more than a unit of margin.

So the tooling earned its keep three times, and the commits hold all three families:
`npm run icon:candidates` redraws whichever family is current, and the rejected ones are in history.

## 2026-09-18 (4) — "用这个，不要动里面的图案": measuring a finished icon instead of designing one

The owner sent a third image and, with it, a constraint that changed the method: *use this, and do not
change the inner pattern or the colours*. That is not a design brief, it is a specification - and it
rules out exactly what I had been doing for the previous two icons, which was looking at a reference
and deciding.

So the numbers came out of the image. `tools/measure-icon.mjs` reads the PNG (through the new shared
`tools/lib/png.mjs` decoder), finds the red disc and the navy circle by colour class, measures the
white glyph as connected column-runs, and reports everything in a 24-unit box with the disc set to 24:

```
红盘   直径 840  颜色 208,39,34        → 半径 12.00, #d02722
蓝圆   直径 494  颜色 13,25,39         → 半径  7.06, #0d1927   （比例 0.5881）
白图形 x 7.34→12.43  y 8.49→15.49  描边 1.29
暂停条 x 13.03→14.31 与 15.37→16.63  y 8.66→15.31（圆头）
尖端红 x 9.06→13.54  y 10.94→13.03
```

The first run of that script was wrong twice, in ways worth remembering: `boundsOf` called its
predicate with the pixel only, while the predicates I handed it needed `(pixel, x, y)` - so "white
inside the navy circle" found nothing at all, silently. And "red inside the navy circle" measured the
circle's own antialiased rim, where navy meets red and the pixels are brownish, and reported the whole
circle as the tip. Both were found by *looking at the numbers and disbelieving them*, and the fix for
the second one is a probe that stays a few pixels inside the rim.

### What the measurements showed that the eye had not

My previous version of this same design had the navy circle at 0.664 of the disc and a 1.4 stroke,
because I had "improved" both for legibility at 16px. The reference is 0.588 and 1.29 - and enlarging
them is exactly the kind of change the owner was telling me to stop making. **A reference is not a
starting point when the person who drew it says it is the answer.**

The other thing only the pixels could say: **the red triangle is painted under the white outline, not
inside it.** Its apex reaches x=13.60 while the outline's outer edge stops at 12.43, so what looks
like two shapes - a small red triangle inside, a red crescent at the tip - is one shape with a white
band crossing it. I had modelled it as a red disc under the stroke, which is the same paint order and
the wrong geometry: the measured shape is *flat*, 2.0 units tall and 4.6 wide.

Its corners are rounded in the reference, which a filled path cannot express. Filling the triangle
*and* stroking it with the same colour at 0.45 with round joins does - the joins bulge the corners by
exactly that much.

### Verifying a reproduction with a number

`--compare` classifies both images' pixels (red / navy / white / other), aligns them by the red disc,
and counts disagreements: **4.6%**, spread evenly as single-pixel differences along every edge. The
first version of that number was 24.9%, which was the icon's transparent corners against the
reference's white page - a comparison that has to composite before it means anything.

Two more tools came out of this: the glyph printed as a character map (the fastest way to see a shape
exactly), and a side-by-side image with the disagreements marked. Both are in `.scratch`, and the
numbers they produced are in `tools/make-icon.mjs` next to the design they describe.

## 2026-09-18 (5) — the deviation was in the tip, and one line of output found it

The owner asked to see the final icon and check it for deviations. There was one, and it was not the
kind I had been looking for.

I had modelled the red as **one flat triangle** lying under the white outline, its apex overshooting so
that the outline crossed it and left red showing on both sides. It looked right in a side-by-side at
512px, and it had passed a pixel comparison at 4.6% - most of which is edge antialiasing, which is
exactly the kind of number that hides a shape error.

What found it was printing the **colour runs along one line** through the glyph:

```
参考  R 9.06–10.80 | N 10.86–11.43 | W 11.46–12.43 | R 12.49–13.57 | N 13.63–13.94 | W 13.97–14.34 ...
我    R 8.91–10.97 | W 10.97–12.38 | R 12.38–13.03 | W 13.03–14.25 ...
```

Two things are visible in the reference's line that no amount of looking had given me. The red comes
in **two pieces with a navy gap between them** (10.86–11.43), so it is not one triangle crossed by the
outline. And the second piece *overlaps the first pause bar*: white resumes at 13.97 instead of at the
bar's own left edge of 13.03, with navy in between.

The measured explanation: the tip piece is a **disc** of radius 1.05 centred at (12.50, 12.00) with a
**navy halo** of radius 1.40, and 12.50+1.05 and 12.50+1.40 land exactly on 13.57 and 13.94. Because
the halo is drawn before the white outline, the outline covers the disc's left part; because it is
drawn after the bars, the halo notches the first bar. So: bars, tip disc with halo, white outline,
inner red triangle. The comparison went from 4.6% to 4.09%, and the tip's boundaries now match the
reference's within 0.1 units.

### A correction that measurement refused

The remaining visible difference was the white apex, which read thicker than the reference's. The
obvious fix was to round the triangle's corners - the reference's apex is visibly rounded - so I wrote
a rounded-triangle path generator and tried radius 0.75 and then 0.3. Both were *worse*: the apex moved
to 11.72 and 12.19 against the reference's 12.43, and the disagreement rose to 4.59%. The reference's
apex is a sharp path; the roundness I was seeing is what half a stroke width of round *join* already
produces.

The generator is still in `tools/make-icon.mjs`, unused, with those three numbers in its comment - a
small piece of dead code that is worth more as a record than as a deletion. The rule it illustrates is
the one this project keeps re-learning: a plausible correction is not a measured one.

What is still different is now written down in the source rather than left for the next person to
rediscover: my apex band reads 10.97–12.19 across the centre line against the reference's 11.46–12.43,
about half a unit thicker. Everything else - the navy circle's ratio, the bars, the tip disc and its
halo, the inner triangle's left edge - lands within a pixel.

## 2026-09-18 (6) — "an extra patch of black and red": the apex was truncated

The owner looked at the finished icon and described a defect precisely: on the play triangle's upper
right there was an extra patch of black and an extra patch of red. They were right, and the cause was
not something any of my previous checks could see.

A colour-run scan along y=11.0 - one unit above the glyph's centre - said it in a line:

```
参考  ...  W 10.46–12.31  |  R 12.34–12.83  |  N 12.94–13.51  |  W 13.54–14.34  ...
我    ...  W  9.75–11.53  |  R 11.72–13.03  |  W 13.03–14.25  ...
```

The reference's white is still solid out to x=12.31 at that height. Mine stops at 11.53. So the
reference's apex is **truncated** - it ends in a short, nearly vertical edge - while mine came to a
point, and the stroke's round join made a small beak. Everything around the beak was therefore wrong in
a way that reads as debris: navy where the reference is white, and the tip disc's red showing where the
reference's white still covers it.

The fix is two numbers: a flat apex at x=11.90 with a half-height of 0.7. A search over both, judged by
`--compare` rather than by eye, took the disagreement from **4.09% to 3.17%**. The earlier attempt to
fix the same area by rounding the triangle's *corners* had made it worse (4.59%); the shape was not
too sharp, it was the wrong shape.

### What this round says about checking

Three rounds of side-by-side images and a 4%-of-pixels metric all failed to surface it, because a
4% disagreement spread along every edge looks the same whether or not one feature is the wrong shape.
What found it was asking a **narrow question of the numbers**: "what is the colour sequence along this
one line?". That is now the third time in this project that a precise question beat a broad
measurement - after the mode command that changed state without shuffling, and the paused seek that
was silently dropped.

The `.scratch` tools that did it are worth keeping: `map-tip.mjs` (character map of a region, both
images, mismatches marked), `scan-centre.mjs` (colour runs along chosen lines), `search-apex-compare.mjs`
(parameter search scored by the pixel comparison).

One sandbox note for whoever runs the search next: it originally shelled out to `measure-icon.mjs` and
captured its stdout, which fails with EPERM under the file sandbox (no named pipes). The fix is to do
the comparison *in-process*, not to retry the spawn another way - rendering with `stdio: 'ignore'` is
allowed and is all that has to be a subprocess.

## 2026-09-18 (7) — the export that only looked transparent, and the hybrid icon

The owner sent the mark again, exported with a transparent background, and asked whether it met the
requirements. Measured, it met most of them and not the one it was sent for:

```
尺寸        1024x1024                                    ✓
左上角像素  [209, 209, 209, 255]                          ✗ 不是透明，是不透明的灰
半透明像素  0                                             ✗ 完全没有任何 alpha 过渡
红盘        844x832 in 1024, 留白 左90 上91 右90 下101     ✗ 占画面 82%，不是贴边
红盘边缘    白→粉→红，约 2px 过渡                          ✓ 边缘是平滑的
文字/阴影   无                                             ✓
```

So: a viewer draws a checkerboard for transparency, but the file this end received had none - alpha 255
everywhere, on a grey frame around a white page. That is worth writing down because it is invisible
from the preview: the only way to know is to read the alpha channel, and it took one line of script.

Two things follow. The disc has to be **cut out geometrically** rather than trusted to an alpha
channel: alpha becomes the coverage of the circle, and the colour averages only the samples *inside*
it - which also avoids the white page bleeding a light fringe around the rim. And cropping to the disc
gives the full-bleed shape an icon wants, since the export sat at 82% of its canvas.

### The split, and why it is not a compromise

`assets/icon-source.png` now drives **48, 64, 128 and 256** - the owner's own pixels, radial gradients
included - and the vector in `tools/make-icon.mjs` drives **16, 20, 24, 32, 40**. The reason is
arithmetic: the pause bars are 1.29 units, which is **1.4 pixels at the 16px a Windows tray draws**.
Downscaling a 1024px export to that size averages each bar with its neighbours and turns three crisp
marks into grey smudges; rasterising the vector *at* 16px keeps them. Above 48px there is room for the
gradient and no reason not to have it.

Both halves are the same design, so they agree: the vector reproduces the export to 3.17% of pixels,
which at 40px is invisible. `npm run icon` prints which sizes came from where, so the split cannot
quietly change.

## 2026-09-18 (8) — the checkerboard was real, and my circle was the wrong instrument

The owner looked at the shipped icon and said there was still a little grey-white checker left below
the circle. There was, and the cause is a neat illustration of assuming a shape:

I had cut the mark out of their export **with a circle**, derived from the red pixels' bounding box -
844px across, so radius 422, centre from the top edge. But the disc measures 844px across and only
*833px* down: its bottom edge is darkened, so the red ends early. A circle taken from the width
therefore reached about 13px past the real bottom, and that strip - y=925 to 935, which the sampling
showed is **white and 207-grey** - went into every large frame with it.

And the background really is a checkerboard: alternate squares of grey (207) and white (254), baked
into the pixels, with every pixel at alpha 255. The viewer was honest; the file was not transparent.

So the cut is now made **by flood fill**, not by geometry: everything reachable from the border through
"neutral and light" pixels is background, everything else is the mark. That needs no assumption about
the shape at all, and it copes with the darkened bottom edge, with the shadow, and with a checkerboard
of any square size. The white glyph cannot be swallowed by it, because the disc surrounds it. Colour is
then averaged from the mask's *core* - pixels that do not touch the background - so the export's own
antialiasing against the checkerboard cannot leave a pale ring at the rim. The crop is the mask's
square bounding box, so scaling to a square frame cannot squash a mark that is not perfectly round.

### The check that should have existed first

`check-shell.mjs` now asserts four things about the 256px frame: nothing opaque outside the disc's
radius, transparent corners, an opaque interior (a shrunken disc would pass "reaches the edge" but not
this), and full bleed. The first of those is precisely where the strip sat - the failing build would
have been caught by it, because the residue lay at radius ~132 in a 128px frame.

That is the real lesson of this round, and it is the same one as the apex before it: the eye found
what the measurements did not, because I had chosen the instrument (a circle, a side-by-side) before
asking what could go wrong. The cheap general fix is a **structural assertion** - "there is nothing
outside the disc" - which does not care how the cut is implemented.

## 2026-09-18 (9) — the red is the client's own, read out of the client

"Change every red in this icon to the same code as the NetEase client's icon." That is a measurement
request, not a taste one, so nothing here came from memory or from a palette:

```
C:\Program Files\Netease\CloudMusic\resource\format.ico
  → 4 frames (16/32/48 as BMP, 256 as PNG)
  → its coloured pixels:  #fc3c49 (252,60,73)  61.1%
                          #fe245b (254,36,91)  13.3%      <- the gradient's two ends
                          mean #fd364e (253,54,78)
```

The client's mark is itself a gradient, so "the same colour code" needed a decision: the mean `#fd364e`
is the one code that represents it, and it is what the icon now uses - in the vector (so the 16-40px
frames, the inner triangle and the tip disc are all that red) *and* in the large frames cut from the
owner's export, which had been `#e51600`.

### Re-mapping a gradient onto one colour without wrecking the edges

The export's red had to be replaced, and a naive "pixels that look red become the new red" turns every
antialiased edge into a hard one - the disc's rim against the page, the tip disc against the navy, the
triangle against the white. So a pixel is first asked *how much* of it is the art's red:

```
t = (r - max(g, b)) / (sourceRed.r - max(sourceRed.g, sourceRed.b))
```

which is exactly 1 for the export's body red and falls away through the blends. With `t` known, the
colour behind the pixel can be recovered - `(value - sourceRed * t) / (1 - t)` - and the pixel rebuilt as
`newRed * t + behind * (1 - t)`. Edges keep whatever they were blending into, and no halo of the old red
survives. Where that recovery goes negative the pixel was a *darker red* rather than a blend (the
export's disc has a subtle gradient), so it is scaled instead, which keeps the depth without inventing
a colour. Body pixels, `t >= 0.9`, are set to the code exactly: **91.5% of the red in the shipped frames
is now the single value `#fd364e`**, and the rest is the antialiasing that has to vary.

`check-shell.mjs` asserts the code in both families - the 256px frame from the export and the 16px
frame from the vector - so "all the reds are the same red" is a checked property rather than a claim
about a constant someone remembered to change.

## 2026-09-18 (10) — a cover of your own, and the flag that could not see a second picture

The owner asked for a feature rather than a fix: choose an image and let it stand in for the song's
cover, switchable. Three decisions had to be made, and each has a reason:

**The image is not the host's business.** The client's cover is still mirrored faithfully; this is a
*presentation* override, so it lives in the shell, which already owns the things that have to survive a
restart. The host does not learn about it at all.

**The image is a file, the choice is a flag.** `userData/custom-cover.png` beside the state file, and
only `coverEnabled` in the JSON - a data URL in there would make the state file megabytes. A chosen
photo is downscaled to 1600px before it is kept, because the card draws it at ~880 and a 4000px
original would be a ~12MB string in the renderer.

**The renderer asks for it.** The page is served over http and cannot read a local file, so it fetches
the image as a data URL through one invoke - not through the state broadcast, which fires on every
lock toggle and every collapse. `has`/`enabled` travel on the broadcast; the bytes are fetched once.

### The bug that the three flags could not express

The obvious state is `{ has, enabled }`: draw the custom cover when both are true. Then the owner picks
a *second* picture. `has` is still true. `enabled` is still true. The broadcast is byte-for-byte the
same as the last one, so the renderer - quite reasonably - decides nothing has changed and goes on
drawing the first picture. Forever.

The fix is a revision counter the shell bumps whenever the image is replaced or cleared, and a pure
function that compares it:

```js
shouldRefetchCover(previous, incoming)
  incoming.has !== true            -> false   (nothing chosen)
  previous.has !== true            -> true    (first sight of a cover)
  previous.rev !== incoming.rev    -> true    (a different picture)
```

It is unit-tested, including the case that matters: same flags, different revision, fetch again. That
class of bug - state that looks unchanged but is not - has now appeared in this project four times
(the mode command that changed the field without shuffling, the volume command that wrote the store
without changing the sound, the deferred seek that reported nothing, and this), which is why the rule
is written down rather than re-derived each time.

### The button

Left click does the obvious thing for the state it is in - pick a file, switch on, switch off - and
right click clears the picture and hands the cover back to the song. Right-click is the only way back,
so the tooltip names it in all three states. `cover-choice.js` decides both the state and the tooltip,
so the button cannot describe an action different from the one it performs.

The glyph is drawn with *filled* paths like every other icon on the card: a stroked rectangle was the
obvious way to draw a picture frame and rendered as a solid black block in `tools/render-icons.mjs`,
which only draws fills. A preview that lies is worse than no preview.

## 2026-09-18 (11) — two small things, one of which was a layout assumption

**"This button is not in the middle."** It was not, and the reason is worth keeping: I had added the
cover button as a *third* child of `.top-bar`, which is `justify-content: space-between`. With three
children of different widths that does not centre the middle one - it equalises the gaps, so the button
lands near the middle and visibly off it. The owner first read it as "should be centred", then settled it
in one line: put it next to the flip button. It now lives in `.top-bar__left` with the flip, and
`check-interaction.mjs` asserts the containment rather than trusting the class name.

The lesson is smaller than the previous ones but the same shape: an element inherits whatever the
container's layout rule means for *its* child count, and "I added it in the right place in the file" is
not the same as "it renders where I meant".

**Tooltips.** The owner asked for plain wording, and then widened it: shorten the text elsewhere too. So
the cover button is now `自选封面（左键选图，右键清除）`, or `（左键切换，右键清除）` once something is
chosen - the first click really does choose rather than switch, and that is the only difference the two
states need to express. `锁定（L）` lost "不自动收起", `关闭到托盘` became `关闭`, and the tooltip test was
rewritten to assert the *shape* (names the control, names both gestures, at most 20 characters) instead of
three separate phrases, so a future rewording does not fail for the wrong reason.

The same pass went over the host's status strings, because those are drawn in the card's status line
rather than only logged. Fifteen strings changed, all in the same direction:

```
客户端正在运行，但没有开启同步通道；需要重启一次客户端以启用同步   ->  客户端没开同步通道，重启一次即可
通道已开启，但还没找到播放页面（客户端可能仍在启动）                ->  通道已开，没找到播放页面（客户端可能还在启动）
还没有拿到 playId（进度流尚未推送），无法跳转                      ->  还没拿到 playId，无法跳转
读不到 playingState，无法判断该播放还是暂停                        ->  读不到 playingState，判断不了播放/暂停
）；可能是客户端的「全局快捷键」被关闭，或按键被其它程序接收          ->  ）；可能被全局快捷键或其它程序接管
```

What was kept: the *action* ("重启一次即可"), and the state words that say what the state is (`已锁定`,
`已静音`). What went: the narration. Console diagnostics and test names were left alone - nobody reads
those in the UI, and shortening them only makes a failure harder to read.

## 2026-09-18 (12) — the shadow's margin was fixed, and the shadow was not

Two complaints, one cause each, and both were measurable rather than a matter of taste.

**"The gradient does not complete, and it is abrupt."** The shadow was written in `u` - a unit derived
from the card's width - while the transparent margin the window leaves for it is a fixed 24px. At the
default card (u = 4px) the largest layer reaches 2.2u + 5.2u ≈ 30px, already past 24; at the large
preset (u = 6.2px) it reaches ~46px. So the shadow was **cut off flat at the window edge** on every
size, which is what "the gradient does not complete" describes exactly.

The abruptness was the layer stack: two heavy drops (0.42 and 0.34) whose combined density fell from
0.60 at the card edge to 0.26 within 7px, then trailed thinly for another 13. A dark core with a fast
shoulder reads as a hard edge even when nothing is clipped. The fix is four graduated layers in **px**
(so they can never outgrow a fixed margin) plus a 0.5px rim instead of a 1.1px one. The profile the
check now prints:

```
before  0.596 0.255 0.210 0.145 0.000 ...    (a step at 7px, then a long tail)
after   0.479 0.225 0.143 0.091 0.050 0.029 0.014 0.000 ...
```

`check-interaction.mjs` no longer only asks whether the extent fits. It builds the falloff from the
layers and asserts it is **monotone** (a rise or a shelf is the step) and that it reaches ~0 **inside**
the margin (anything still dark at the edge is being cut). It also asserts the shadow contains no
`var(--u)` at all - the invariant that actually prevents this coming back at another card size.

**"The card cannot be placed against the edge of the screen."** `clampToWorkArea` pinned the whole
*window* inside the work area, and the window is the card plus a 24px transparent margin on each side -
so the card could never get closer than 24px to the edge, no matter what the shadow did. The owner's
preference was the other fix: let the card move mostly off the screen, like other clients. So the clamp
is now about the *card*: `KEEP_VISIBLE` (48px) of it must overlap the work area in each axis, and
everything else, shadow included, may hang off. The two axes are independent (a card can hang off a
corner leaving a grabbable corner), and `keep` shrinks for a card smaller than it, because the rolled-up
strip is only ~40px tall.

Never zero, though: a card with nothing on screen can only be recovered from the tray, and "it
vanished" is a worse surprise than "it stopped at the edge". Both rules are unit-tested with the actual
numbers (dragging 100000px away leaves exactly 48x48 visible, on a monitor with negative coordinates
too).

## 2026-09-19 — the app becomes an app: packaging, auto-start, and one button that unblocks everything

The owner asked whether this could be a real client or only something started from a terminal. It could,
and the interesting part was how little had to change - plus one thing that had to be added.

### What was already true

The icon was ready (`assets/icon.ico`, nine sizes, checked by `check-shell.mjs`), and the shell already
launched the host through `process.execPath` with `ELECTRON_RUN_AS_NODE=1` - i.e. on **Electron's own
Node**, not a system install. A packaged app therefore needs no Node on the machine. Single-instance was
already there too (`requestSingleInstanceLock` + `second-instance` → `showWindow`). The state file and the
custom cover already live in the app's `userData`.

So the work was: a config, a startup latch, and the missing action.

### The config, and the three things that bite

`electron-builder.yml` writes an NSIS installer and a portable exe. Three choices there are not defaults:

* **`buildResources: assets`, not `build`.** The conventional path for build resources *is* `build/`, and
  this repo gitignores `build/` (it holds build output). The first version of the icon went there and
  would have worked on this machine and nowhere else - the same trap, one level up.
* **`asar: false`.** The host is a separate Node process that serves `ui/` from disk and writes a module
  cache beside its user data. An asar would have meant proving that the fs shim applies in
  `ELECTRON_RUN_AS_NODE` mode before shipping; a plain directory means never having to find out. It is
  also why every runtime path is a real file, which the packaging check can then verify.
* **`npmRebuild: false`.** There are no native modules anywhere, so `@electron/rebuild` has nothing to do
  but fork a child. Skipping a step that has no work is not a workaround, it is the correct config - and
  it happened to be the first thing the restricted shell could not run.

`check-shell.mjs` now checks the config against the filesystem: the `files` list must cover the host
entry, the host's TypeScript sources, `ui/`, and the icon; the icon path must exist; the installer must
be per-user with a choosable directory; both targets must be present. A missing `files` entry is
invisible until someone installs the app and it opens a window with nothing in it, which is exactly the
kind of failure worth a static check.

### Auto-start as a latch

Start-with-Windows is applied on the first **packaged** launch and recorded (`autoStartApplied`) in the
state file, and then never touched again. The latch matters: auto-start is also editable in Windows' own
startup settings, and an app that re-enabled itself every launch would be fighting its own user - the
same mistake as re-applying a default on every start. In development it does nothing at all, because a
checkout must not register itself to run at login.

### The button that unblocks everything

The overlay exists because the client's loopback debug port is open, and that port opens **only at
launch**. Every "the card cannot find the client" in this project's history has been that, one way or
another - including the round where the client updated itself and the user restarted it several times
before it came back.

So the status line, which already says *what* is wrong, now offers the *fix*: when the host reports
`client-not-running` or `needs-relaunch`, a button appears (启动客户端 or 重启客户端 - the label follows
the state, because "restart" would be a small lie when nothing is running). Pressing it kills the client's
two processes, waits 900ms for the port to be released, and launches the client detached with the debug
flags. Nothing kills anyone's music without that press.

### Building it under the sandbox, for the record

Four separate walls, all environmental, none of them the config's fault: npm needs `npm_config_cache`
overridden *in the environment* (a workspace `.npmrc` loses to the harness's preset) and
`--ignore-scripts`; electron-builder needs `ELECTRON_BUILDER_CACHE` and
`--config.electronDownload.cache=…` because `ELECTRON_CACHE` is not the variable it reads; and the npm
collector and `makensis` steps spawn children with piped stdio, which the confined sandbox refuses with
EPERM. The last one needed the unconfined mode, twice, for exactly that reason.

The output: `dist\NCM Trackpic Card-0.1.0-setup.exe` and `…-portable.exe`, 106MB each, with
`resources/app/{ui,packages,tools,apps,assets}` verified inside. Whether the installed app *runs* is the
owner's test - nothing here can launch Electron and keep the client alive.

## 2026-09-19 (2) — verifying the *build*, not the config

`check-shell.mjs` checks the packaging config: the `files` list covers the host entry, the host sources,
the UI and the icon. That is a check of my *intentions*. A file added to an import chain since the list
was written would be missing from the build, and nothing would notice until someone installed it and got
a window with nothing in it.

So `tools/check-package.mjs` inspects the built payload instead. Two things make that possible without
launching Electron:

* **The host is plain Node.** The shell starts it as `ELECTRON_RUN_AS_NODE`, so
  `resources/app/tools/host-run.mjs` runs under `node` directly. The check starts it on spare ports
  (18787/18788, and a bogus CDP port so it cannot touch the client's real channel), waits for the card
  page over HTTP, fetches a module as well, and kills it - which verifies the half that a bad `files`
  list breaks, with no window involved.
* **The import graph is walkable.** Walking imports from the four runtime entries found a "missing"
  `packages/host/src/cdp.js`. It was not missing: TypeScript's ESM style writes `./cdp.js` for a file that
  is `cdp.ts` on disk, and Node strips the types at run time. The resolver has to try the rewrite before
  it is allowed to call something missing - a check that cries wolf gets ignored, which is worse than no
  check.

Both halves now pass: 17 files in the graph, and a packaged host that serves `index.html` and
`/src/main.js` (`HTTP 426` on the WebSocket port is the host answering with "Upgrade Required", which is
exactly right).

Two smaller lessons from writing it: `process.exit()` while sockets are still closing provokes
`Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)` from libuv, so the script sets `exitCode` and
lets Node end on its own; and killing a child and returning immediately does the same thing, so it waits
400ms.

What is left is the part only the owner can do: install it and see whether a card appears, the tray icon
is there, auto-start shows up in Windows' startup settings, and the uninstaller leaves nothing behind.

## 2026-09-19 (3) — verifying the exe's icon, and a bug the README had already promised against

Two things this round, both about not trusting a config to have done what it says.

### The icon is in the exes, and now provably so

`electron-builder.yml` says `icon: assets/icon.ico`. The installer, the desktop shortcut, the taskbar and
Explorer all take their icon from the **executable's own resources** - so a wrong path, or an .ico the
tool could not read, ships Electron's default look. Nothing else in this project looks at the built exe,
and this is the detail the owner has cared about most across a dozen rounds; "it is in the config" is not
evidence.

So `tools/lib/exe-icon.mjs` walks the PE resource directory to the icon group with the lowest id, and
`check-package.mjs` asserts both the app exe and the installer carry nine sizes including 16 and 256, and
that the largest frame's dominant colour is the client's own `#fd364e`. Both pass, and the portable exe
does too:

```
应用 exe 带我们的图标（9 个尺寸，含 16 与 256）  16 20 24 32 40 48 64 128 256
应用 exe 图标的主色是客户端的红  #fd364e
```

Writing the parser produced a mistake worth keeping: **the resource tree's offsets are relative to the
start of the resource directory, not to the parent level.** My first version added the parent's offset at
each level, which produced a tree that looked *almost* right - every other entry decoded, the rest were
garbage - and ended with "this executable has no icon resources" for a file with nine of them. A flat
debug script that used the root base throughout worked, which is what gave it away.

### The README promised something the code did not do

`README.md` says the portable build does not set up auto-start. The code did not implement that: it set
auto-start on the first packaged launch, and the portable target **unpacks itself into a temporary
directory per run** - so the startup entry would point at a path that is gone by the next boot. A broken
entry in the user's own startup list, created by us, from a feature whose documented behaviour was the
opposite.

The fix is four lines (`PORTABLE_EXECUTABLE_DIR` is how electron-builder marks a portable run), and the
lesson is the older one: prose in a README is a claim, not a test. It is now a claim the check suite
covers.

The build was redone after the fix, so the artifacts in `dist/` include it - which matters because the
owner will install *these* files, not the next build's.

## 2026-09-20 — the owner installed it, and two things were wrong

The install test did its job immediately: the card never appeared, and the small icon sizes had visible
flaws. Both were mine, and both had a specific cause.

### "正在启动…" for ever

`loadUi()` called `mainWindow.loadURL(UI_URL)` **once**. The UI is served by the host, which is a separate
process that has to start, load its TypeScript modules, find the client's modules and bind two sockets -
seconds, on a first run with no cache. The load was attempted before the port was open, refused, and never
retried, so the window sat on its startup page. The owner saw a transparent, unclickable rectangle in the
middle of the screen, which is exactly what a 400x725 transparent window showing grey text looks like.

The fix is to ask the question the load is about to ask: `waitForPort` probes the UI port with a TCP
connect (cheapest honest check, and it leaves no error page behind), retries for 20 seconds, then loads -
and retries the load itself three times. In development the race was there too; it just usually won.

**The larger failure was that nobody could tell.** A packaged Windows GUI app has no console, so every
`console.error` about the failed start went nowhere, and the owner had nothing to report but the symptom.
So the shell now logs to `userData/overlay.log` (previous run kept as `.1`), captures the renderer's own
console messages, and hooks `did-fail-load` / `did-finish-load`. When the host does not come up, the window
now *says so* and prints the log path instead of waiting silently. The console is patched rather than
routed through a helper, because there are dozens of existing `console.*` calls and a helper would only
catch the ones someone remembered to convert.

The mechanism itself was never in doubt - `ELECTRON_RUN_AS_NODE=1` on the packaged exe works, which I
confirmed by running the packaged host that way (it ran as a server and my command timed out, which is the
success signal for a server).

### The small icon sizes were bad because two things were wrong

The owner pushed back on my "the vector is better at 16px" claim, and they were right - the redraw they
were seeing had visible flaws. Looking at what I had actually built:

* **I sampled only 4x4 points per destination pixel.** Going from an 846px mark to a 16px frame is a 53x
  reduction, so 16 samples per pixel skipped almost everything under it. That is what made the small sizes
  mottled, and it had nothing to do with the export being a bitmap.
* **I averaged sRGB values directly.** sRGB is not proportional to light, so averaging it darkens thin
  light features - and the pause bars are 1.4 pixels wide at 16px.

Both are fixed: the sample count now follows the scale (one sample per source pixel covered, capped at 64),
and averaging happens in linear light. And **every size now comes from the owner's art**, including 16px -
the vector remains only as the fallback for when there is no export to build from. `.ico` went from 70KB to
51KB as well, because the small frames stopped being vector approximations.

The lesson is the one the owner stated plainly: I had been treating "the export is 1024px" as the reason
the small sizes had to be redrawn, when the actual reason was two implementation mistakes in my own
downscaler.

## 2026-09-20 (2) — the installer's host could not start, and my check had walked past it

The second install test produced a log, which is the only reason this was findable at all:

```
INFO  [shell] 界面资源(...\resources\app\ui): index.html ...
ERROR [shell] 宿主退出，代码 1          ← 300ms after launch
ERROR [shell] 界面服务未就绪 ...
```

That is all it said, because the host's own stderr went through `process.stdout.write`, and a packaged
Windows GUI app has no stdout. Running the *installed* exe by hand - `ELECTRON_RUN_AS_NODE=1` plus the
host entry - printed the missing line immediately:

```
Error [ERR_MODULE_NOT_FOUND]: Cannot find package '@ncm-trackpic-card/shared'
  imported from ...\resources\app\packages\host\src\index.ts
```

A workspace package, reached in development through the npm junction in `node_modules`, and
`node_modules` is not shipped. Three of those imports were values (the rest are `import type`, which
Node's type stripping erases, so they never mattered). The host now imports `packages/shared/src/index.ts`
by relative path, that directory is in `files`, and `ws` - the only real npm dependency - moved into the
root `package.json`'s `dependencies`, because electron-builder's module collector is what copies
`node_modules`, and an explicit `files` glob for `node_modules/**` is simply ignored.

### The check that was supposed to catch this

`check-package.mjs` exists to walk a *built* payload and prove it can start. It walked `./` and `../`
imports only, so it reported a complete graph - 17 files - for a payload whose host could not load its
first module. Bare specifiers are now resolved against `node_modules/<name>` and the workspace packages,
and it fails loudly:

```
ok   导入图完整（每个相对引用都在包里）  20 个文件
ok   每个裸包名都在包里（node_modules 或工作区）  ws
```

Getting that matcher right took three attempts, which is its own small lesson: "import or export, then
the next quoted string" also matches `export const MEDIA_KEY_FOR = { playPause: 'playpause' }` and prose
inside log messages, and reported `playpause`, `0.1.0` and a sentence fragment as missing packages. The
version that works anchors on `from` (allowing multi-line import lists by running to the first `;`),
handles dynamic `import()`, and ignores `node:` and `electron`.

### And the test that was rescued by the wrong directory

After shipping `ws`, the packaged host started in my check - because the payload sits *inside the
checkout*, where Node walks up and finds the repo's own `node_modules`. The installed app has no such
ancestor. The faithful test is to copy the payload somewhere else first, which is now what I do: the
isolated copy serves `index.html` (with `id="card"`) and `/config.json`, from a directory whose ancestors
contain no `node_modules` at all.

The lesson is the same shape as the icon one from the previous round: **the test agreed with me because
of an accident of the environment, not because the thing worked.**

Version bumped to 0.1.1 so the owner can tell which installer they are running.

## 2026-09-20 (3) — deleting the dead tools, and the four that almost went with them

The owner asked for the unused scripts to go. A reachability walk - every entry point in `package.json`,
the app's own runtime entries, and every relative import from those - found 33 files under `tools/` that
nothing could reach. That number was wrong in both directions:

* **Four were libraries of tools being kept.** `lib/probe-{app,audio,bridge,deep}.mjs` are imported by
  `inspect-player`, `audio-streams`, `find-bridge` and `find-progress` - all four named in
  `docs/contracts.md` as things a reader may run. The walk never saw those imports because it started from
  `package.json`, and the manual tools are called by hand. Checking the *reverse* direction (who imports
  this file?) saved them.
* **Three were false positives** for the same reason: `relaunch-ncm.ps1` and `debug-launch.ps1` are
  invoked by npm scripts as PowerShell (the walk only understood `node`/`electron`), and the
  `.lnk` shortcut is the owner's own way to start the client.

So the rule became: delete a file only when nothing reaches it **and** no document names it. Two lyrics
instruments (`audit-lyrics`, `diagnose-lyrics`) failed the second test by a hair - they are the tools I
had offered for auditing the lyrics page - so they were kept and added to the tool table instead. Eight
went: `dump-actions`, `fetch-electron`, `lyric-shape`, `lyrics-race`, `tap-dispatch`, `trackpic-canvas`,
`trackpic-design`, `verify-progress`.

`docs/contracts.md` gained a row for the two kept instruments, so the next person does not repeat this
exercise from scratch. The suite is green afterwards, and a scan for the deleted names across every
tracked file finds nothing - the check that "no documentation now points at nothing".

### And the files the owner asked about

Neither file is **packaged**: the `files` list excludes `**/*.md`, and the payload contains no markdown at
all (verified against the built app, not the config).

The owner then asked that a future clone not receive `MEMORY.md` at all. First step: remove it from the
index and add it to `.gitignore`, which leaves the file on this machine and keeps it out of every clone's
working tree from that commit on.

Then they said the history could go too - nobody had cloned - so every commit was rewritten to drop the
path. All 76 commits were rebuilt with `git commit-tree`, preserving author, committer, dates and
messages; the branch was moved only after the new chain passed its own checks (same commit count, no
commit anywhere in it carrying the path, the tip's tree clean). The old objects were then expired and
garbage-collected locally, and the remote was force-pushed with an explicit lease.

The result, verified from the remote's own tree: 116 files, no `MEMORY.md`, and `git log origin/main --
MEMORY.md` returns nothing. Every commit hash changed, which is the cost - old links and bookmarks break.
Two caveats worth stating plainly: GitHub can keep unreachable objects reachable *by SHA* for a while (a
support request purges them), and anyone who had cloned or forked before the rewrite still has them. The
owner confirmed nobody had.

### Two PowerShell traps, one of which nearly cost the history

`git filter-branch` cannot run in this sandbox at all: its filters are executed by `sh.exe`, which is
refused a signal pipe ("couldn't create signal pipe, Win32 error 5"). The same job was done with plumbing
instead - read each commit's tree into the index, drop the path, write the tree, re-create the commit.

The first attempt at that script did two things wrong, and both are worth keeping:

* **PowerShell 5.1 reads a `.ps1` without a BOM as ANSI/GBK.** The script's Chinese output text was
  therefore mis-decoded, and the mis-decoding corrupted the quoting of everything after it - part of the
  script was *printed* instead of executed, which is how `git update-ref` silently did nothing. The fix is
  ASCII-only output in generated scripts, or write them with a BOM.
* **`git rev-list --parents -n 1 <sha>` prints one line, `<sha> <parent>...`.** Piping that through
  `Select-Object -Skip 1` skips the entire line and yields no parents at all - so the first rewrite built a
  single **parentless** commit containing the final tree, which would have thrown away all 76 commits.

What caught it was refusing to move the ref until the result had been checked against the old chain. The
script now ends with that check and aborts without touching `refs/heads/main` if the commit count changed,
if any commit still carries the path, or if the tip's tree does. **A destructive script needs its
verification between the work and the commit of the work** - not after.

## 2026-09-20 (4) — the drag stuttered again, and it was the shadow I had just smoothed

The owner reported two things at once: dragging had become stuttery, and letters were being cut off at the
bottom. They asked whether I had reverted something to an older version, which is the right question - both
symptoms had been fixed before - so the first move was to read the old fixes rather than guess.

### What the old fix said

`NOTES.md` already had the answer to the stutter, from months of commits earlier:

> The window was moved from a `setInterval(16)` in the main process. That fires *near* every frame, not on
> it ... the irregularity is what the eye reads as 卡顿.

That path is intact: `ui/src/drag.js` still coalesces to one send per animation frame, and the shell still
captures the work area at the start of the drag instead of querying the display per move. So the stutter was
not that.

### What it actually was

Four commits earlier I had replaced the card's two-layer shadow with a **four-layer** one, because the old
pair read as a hard shoulder rather than a gradient. The profile improved and nothing looked wrong - until
the card started *moving*. Every frame of a drag repaints the whole window surface, and this window is
transparent, frameless and always-on-top; four blurred layers per frame is four blur passes per frame, where
two used to be. It cost nothing while the card was still and doubled the per-frame work while it was being
dragged, which is exactly where a person notices.

The fix is not to give up the smooth shadow, it is to stop paying for it while it moves:
`ui/src/drag.js` sets `data-dragging` on `<html>` on the *press* (not the first move - the first frames are
the expensive ones) and clears it on every way out of the gesture, and the stylesheet swaps in a single cheap
layer for the duration. The rule is checked (`一层廉价阴影`), the flag is unit-tested for press, pointerup,
pointercancel and lostpointercapture, and the guard is written so the gesture still works against the test
harness's fake DOM, which has no document at all - that gap is what made six drag tests fail the first time.

**Generalised**: a cost that is invisible while something is still can be the whole story while it moves.
When a visual change makes motion worse, the profile of the change is the first suspect.

### The clipped letters

Not this round's fix, and worth being precise about: the two elements that had this bug before - the title
and the artist, where a tight line box under `-webkit-line-clamp` sliced descenders - still carry their fix
(a 1.6 line-height with a documented compensating margin), and the geometry of every other text box checks
out on paper: the rolled-up bar has 11.8u of content room for ~8.9u of text, the lyric block keeps
`overflow: visible` so a tail cannot be sliced, and the only text-bearing addition of recent rounds is the
status line's restart button, which has neither a height nor an `overflow` and so cannot clip. Which means
the symptom is somewhere I have not thought of, and the next step is asking rather than guessing again.

## 2026-09-20 (5) — the shadow counted as the card, and a text bug with two possible shapes

Two more reports, and this time one of them is settled.

### The hover test used the window, not the card

The roll-up watcher asked whether the cursor was inside `mainWindow.getBounds()`. The window is the card
*plus* `SHADOW_PAD` (24px) of transparent margin on every side, so all of that margin counted as the card:
the pointer could sit a visible distance outside the edge and the card would stay open, and rolling up
only began once it had left the shadow too. `cardRect(bounds)` insets the window by the margin, the watcher
uses it, and `check-shell.mjs` checks both the arithmetic and that the old window-bounds test is gone - a
point two pixels inside the window but outside the card is no longer "on the card".

### The title and artist, which are always cut somehow

The owner says these two lines have *always* been cut, which rules out a regression and makes it a
long-standing layout fact. Reading the old records found why the check never caught it:

> The critical one. The content must fit inside the card: `overflow: hidden` clips whatever runs past the
> bottom, which is exactly how the title and artist disappeared in an earlier revision.

That check measures the stack with a **one-line** title. But `.title` carries `-webkit-line-clamp: 2`, so a
long title is two lines - and the stack was never measured for that. Two things followed:

* `tools/check-layout.mjs` now checks the two-line case as well. It passes with 4.8u to spare, so the
  column does *not* overflow today - but the arithmetic that decides that is now in the check instead of in
  someone's head.
* `.title` and `.artist` are now `flex: none`. A flex item shrinks by default, and a *shrunk* line box
  under `overflow: hidden` slices the bottom off its glyphs - which is the exact shape of the complaint.
  There is room for two lines, so refusing to shrink costs nothing and removes the mechanism entirely.

What is *not* settled is which mechanism the owner is actually seeing, because "显示不全" has two shapes
with opposite fixes: text cut off at the **right** (ellipsis, or the clamp stopping at two lines - both by
design, both adjustable) or glyphs cut across the **bottom** (a line box taller than the space it is given).
The arithmetic says the bottom case should not be happening, so the next step is a screenshot rather than a
third guess - this project has already paid twice for fixing the wrong mechanism.

## 2026-09-20 (6) — the buttons were dead because a script was never packaged

Three reports arrived together - text still cut, the transport buttons doing nothing, and the card
sometimes changing size while dragged - plus a suspicion from the owner: "did you package the wrong
version?" The suspicion was half right, and worth stating plainly.

### The installed build was 0.1.1 and so was the repository

I bumped to 0.1.1 for the first working installer and then kept committing fixes **without bumping again**,
so the version number could not tell the owner which build they had. Comparing the two trees directly
settled it: the installed payload has the wait-for-host fix, the log file and `ws`, and lacks every change
made since - so it is a correct build of an *older* commit, not a mis-packaged one. It is now 0.1.2, and
the 0.1.1 artifacts are deleted so there is nothing to install by mistake.

### The buttons

`packages/host/src/media-key.ts` does not import anything for this. It resolves a path:

    const SCRIPT = resolve(HERE, '..', '..', '..', 'tools', 'media-key.ps1');

and the packaging shipped exactly one file from `tools/`: `host-run.mjs`. So play, pause, next and previous
all ran PowerShell against a file that was not in the installed app. In development the file is simply
there, which is why the buttons worked every time I tried them and never once for the owner.

Two things came out of it:

* `tools/media-key.ps1` is now in `files`, and running it by hand confirms the mechanism is fine
  (`SENT: playpause (VK 0xB3)`, exit 0, 881ms) - the missing file was the whole story;
* `check-package.mjs` gained a **second** category of check: resolve every `resolve(HERE, ...)` in the
  payload and assert the target exists. Imports and path-opened files are different ways for a payload to
  be incomplete, and only the first was being checked. Run against the owner's installed 0.1.1 it reports
  exactly the defect:

      FAIL 按路径打开的文件也在包里（import 图看不见的那一类）  缺 tools\media-key.ps1 ← packages\host\src\media-key.ts

**Generalised**: a feature that works in development and fails after install is a *packaging* question
before it is a logic question. Anything reached by a path rather than an import is invisible to an
import-graph check, and `files` in electron-builder has no way to know about it.

### The cut text, settled by the screenshot

The owner sent a crop of "bubu6 / iVy" and it was decisive: the `y` had **no tail at all** and the bottom
of "bubu6" was flat. That is not ellipsis and not a squeezed box - it is a glyph's descender leaving the
line box and being clipped by `overflow: hidden`. The stack falls back to CJK-capable families (MiSans,
Noto Sans SC, 微软雅黑) whose natural line box is near 1.5em, and at `line-height: 1.6` there is almost no
room left for a tail. The fix is room *below* the line box, which is what padding gives (the clip is at the
padding edge): `padding-bottom` with an equal negative `margin-bottom`, so the descender has somewhere to
go and nothing below moves. `.title` and `.artist` both carry it.

`check-layout.mjs` had to be taught to see it, too - it read `line-height` and nothing else, so padding
could be added, doubled or left uncompensated without a word. It now models the padding and the cancelling
margin, which is what makes the report "positions unchanged, 12.21u of bottom inset" mean something.

Still open: the card occasionally changing size during a drag. `overlay:drag-start` already lands an
in-flight resize tween before capturing the size, so it is something else - and the installed build logs
`拖动中窗口尺寸被系统改动: 请求 WxH，实际 ...` when it happens, which is the next thing to read.

## 2026-09-20 (7) — every button press started a PowerShell, and that was the delay

With the packaging fixed the transport buttons worked, and the owner immediately reported the next
problem: play/pause now had an obvious delay, while the *icon* switched instantly. The icon being instant
is the clue - the UI updates optimistically, so the delay was between the press and the music, and there is
only one thing on that path.

`media-key.ts` spawned PowerShell per press. Measured: **880ms**.

Divided up: about 380ms is Windows PowerShell starting; most of the rest is `Add-Type` compiling the
P/Invoke declaration for `keybd_event` *again on every press*; and 30ms is the script's own gap between
key-down and key-up, which is deliberate. So one button press paid for a compiler.

The fix is to stop paying it repeatedly. `media-key.ps1` gained `-Serve`: the type is compiled once, and
after that each press is a line on stdin answered with an ack. The host keeps one of these alive (started
and pinged at host start, so even the first press is fast) and shuts it down with the host, so nothing is
left running. Measured on the PowerShell side, 51 round trips took 762ms in total - less than the start
plus compile alone, i.e. under a millisecond each - so a real press is now dominated by that deliberate
30ms key gap: **about 35ms instead of 880ms**.

Three details that matter and are now checked:

* `spawn`, not `spawnSync`. The old call blocked the host's event loop for most of a second, which froze
  snapshots and progress along with it.
* The one-shot path is kept as a **fallback**: it runs if the session cannot start or dies, and it is also
  the only path that works where a child with piped stdio cannot be created at all - a confined build
  shell, where the checks run. Without it the test suite could not exercise this file.
* `tools/media-key.ps1` stays **ASCII-only**. Windows PowerShell 5.1 reads a `.ps1` without a BOM as ANSI,
  and non-ASCII bytes corrupt the quoting of everything after them. That trap already cost a history
  rewrite this session; there is now a check for it.

The version number was left at 0.1.2 at the owner's request. To keep two builds of the same version
tellable apart, the log header now records the build stamp - the exe's own timestamp:

    === 2026-09-20T...  version 0.1.2  packaged true  built 2026-09-20 19:41 ===

## 2026-09-20 (8) — renamed to NCM Track Card

The owner asked for the tool to be called **NCM Track Card** everywhere, including the credit line at the
bottom of the card. Twenty lines changed across fourteen files: the two package files, the three workspace
packages and their scope, the TypeScript path mapping, the `LOCALAPPDATA` cache directory the host derives,
the packaging product name and uninstall label, the README, the card's credit (`NCM · TRACK CARD`), the SVG
title, and the checks.

Three places deliberately keep the old spelling, and each is a judgement rather than an oversight:

* **`appId` is still `com.hehy.ncm-trackpic-card`.** An app id is an identity, not a label - NSIS uses it to
  recognise an existing installation, so renaming it would make this build install *beside* the previous
  one instead of upgrading it, leaving two entries in "Apps & features" and two auto-start entries. The
  name the user sees is `productName`, and that is what was renamed. The file says so in a comment.
* **`NOTES.md`'s four historical quotes keep the old name.** One is the installer that was actually built
  at the time, one is the exact text of an error the app really printed, and two are the file names of
  tools that were deleted. Rewriting them would turn a record into fiction.
* **The tray tooltip (`网易云同步卡片`) and the Start-menu shortcut (`NCM 同步卡片`)** are Chinese
  descriptors rather than the product name, so they were left alone - and flagged to the owner in case they
  want them renamed too.

Two consequences worth knowing. Electron derives the user data directory from the package `name`, so the
log moved from `%APPDATA%\ncm-trackpic-card\overlay.log` to `%APPDATA%\ncm-track-card\overlay.log`, and the
saved window position, lock state and cover choice start fresh - a small, one-time cost of the rename. And
`check-package.mjs` no longer hardcodes the product name: it reads `productName` out of
`electron-builder.yml`, because a hardcoded copy would have gone on looking for an exe that no longer
exists.

## 2026-09-20 (9) — the tray, the shortcut, and no more auto-start

Three more requests after the rename, and one of them explained a report that had looked like a miss.

### "The card still says NCM Trackpic Card"

It does not, in the source: the credit is one line in `ui/index.html` and nothing in the JavaScript or CSS
composes it, which is why the previous commit's rename was complete. What the owner was looking at was the
**installed 0.1.2 build**, which predates the rename - the string only changes once the new installer is
installed. Worth writing down because "I changed it and they still see the old text" has two very different
causes, and checking the *built payload* rather than the source is what tells them apart.

### The tray tooltip and the shortcut

`tray.setToolTip` said `网易云同步卡片（单击显示/隐藏）` and the Start-menu shortcut was `NCM 同步卡片`. Both
were Chinese descriptions rather than the product name, which is why they had been left alone in the rename;
the owner asked for them too, so they are now `NCM Track Card（单击显示/隐藏）` and `NCM Track Card`.

### Auto-start is gone

The shell used to call `setLoginItemSettings` with auto-start on, once, after a packaged install - a mirror
of what is playing is only useful if it is there when the music starts. The owner does not want it, so the
call and its latch are removed, along with the state field and the now-unused portable guard.

Removing the feature is not the whole job: the **entry our earlier builds created is still in their startup
list**, and the obvious way to clean it up - "if our state file says we were the one who added it, remove
it" - cannot work here, because the state file moved when the rename changed the package name (Electron
derives userData from it). So the login item is removed by *targeting the old executable's path*, once, and
only when that path actually has an entry: nothing the user set up themselves is touched, and there is no
guessing from a stale latch.

The checks were rewritten to match: nothing enables auto-start, the cleanup targets the legacy path and is
packaged-only, and the state file no longer carries a latch.

**A small trap in that rewriting**: the assertion "nothing enables auto-start" greps the shell for the
literal, and the first version of my *comment* about the removal contained that literal - so the check
failed on its own explanation. The comment now describes the call without spelling it, which keeps the
assertion strict instead of loosening it to accommodate prose.