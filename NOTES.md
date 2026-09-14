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


