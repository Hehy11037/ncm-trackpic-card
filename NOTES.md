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

