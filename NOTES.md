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

`MEMORY.md` is new: the current rules, constraints, invariants and traps, as opposed to `NOTES.md`,
which is the chronological record of how they were learned.

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

**Generalised**: never feed a window's own geometry back into the next `setBounds`. Invariant 13 in
`MEMORY.md`.

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
Invariant 16 in `MEMORY.md`.

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