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
