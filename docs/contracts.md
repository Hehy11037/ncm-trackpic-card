# Verified contracts — NetEase Cloud Music client 3.1.39.205426

Everything below was **measured on this machine**, not inferred from
documentation. Each item says how it was verified so a future client update can
be re-checked quickly.

Client under test:

```
ProductName    : NetEase Cloud Music
ProductVersion : 3.1.39.205426
Engine         : CEF (libcef.dll), not Electron
Install path   : C:\Program Files\Netease\CloudMusic
Profile data   : %LOCALAPPDATA%\Netease\CloudMusic  (CEF dir: webapp91x64)
```

---

## 1. How to reach the client

```powershell
# Must be started from a NON-sandboxed shell, with the client fully exited first
# (the client enforces a single instance).
& "C:\Program Files\Netease\CloudMusic\cloudmusic.exe" `
    --remote-debugging-address=127.0.0.1 --remote-debugging-port=9223
```

| Fact | Value / behaviour |
| --- | --- |
| Debug endpoint | `http://127.0.0.1:9223/json` |
| Page target | `type=page`, `url=orpheus://orpheus/pub/app.html`, `title=网易云音乐` |
| WebSocket handshake | must send `Origin: http://localhost`, else Chromium rejects it |
| Windows SMTC | **not registered** — `GlobalSystemMediaTransportControlsSessionManager.GetSessions()` returns 0 even while playing. Do not use. |
| Launch from a sandboxed shell | **crashes the client**: `FATAL:platform_channel.cc(85) Check failed: Access is denied. (0x5)`. See `NOTES.md`. |

Verification tool: `node tools/probe-cdp.mjs`

---

## 2. Webpack bootstrap and module discovery

The bundle registers chunks as
`(this.webpackJsonp = this.webpackJsonp || []).push([[chunkId], {moduleId: fn, ...}])`.

Pushing a synthetic chunk yields the real `require`:

```js
// chunk id 990001 was accepted; 1824 modules were already in require.c
webpackJsonp.push([[990001], { 990001: function (m, e, require) { window.__moRequire = require; } }, [[990001]]]);
```

**Do not hardcode module ids.** The community implementation
([cloudmusic-desktop-mcp](https://github.com/Seraph310/cloudmusic-desktop-mcp))
uses ids `987660` and `12`; verified absent from this build (grepped all 231
unpacked bundle files). Discovery must be runtime:

| What | How to find it | Result on this build |
| --- | --- | --- |
| dva store singleton | any module export with callable `getStore` **and** `getDispatch` | exactly one: module **`11`** |
| Redux store object | `__moDva.app._store` | `getState()` / `dispatch()` |
| Audio pipeline | module exporting a key named `audioPlayerPlayProgress$` | module **`1186`** |

Verification tools: `node tools/discover.mjs`, `node tools/find-bridge.mjs`

---

## 3. Playback state — exact field names and units

Read with `__moDva.app._store.getState()` (or `__moDva.getStore()`, which returns
the same state tree via `app._store.getState()`).

### `state.playing`

| Meaning | Field | Type / unit | Sample |
| --- | --- | --- | --- |
| Song id | `resourceTrackId` | **string** | `"2102424488"` |
| Song title | `resourceName` | string | `"Madoromi Chronoscope (2023 Remaster)"` |
| Cover image | `resourceCoverUrl` | string (https) | `https://p3.music.126.net/...jpg` |
| Artists | `resourceArtists[].name` | array of objects | `"新目鳥"` |
| Duration | `resourceDuration` | **seconds** | `165` |
| Play state | `playingState` | number | `1` = paused/stopped, `2` = playing |
| Playback mode | `playingMode` | string | `"playOrder"` |
| Volume | `playingVolume` | float 0–1 | `0.5` |
| Mute | `muteVolume`, `volumeDelta` | — | note: there is **no** `mute` field |
| Current lyric line | `playingLyricLineNumber` | number (frozen when paused) | `10` |
| Current lyric payload | `playingLyric` | array (often empty) | `[]` |
| Loudness placeholder | `playId` | string, can be `""` | `""` |
| Buffering | `loadingSeekRatio`, `loadingSeekDuration` | number | — |

### `state.playingList`

| Meaning | Field |
| --- | --- |
| Queue | `curPlayingList[].resourceId` (**number**) |
| Chorus ranges | `curPlayingListChorusMap[<songId>] = { startTime, endTime }` in **milliseconds** |

### Unit trap (important)

`resourceDuration` is in **seconds**, while `curTrack.duration` and the chorus map
are in **milliseconds**. Mixing them is off by 1000×. Normalize at the boundary.

### Artist objects

`resourceArtists[]` entries are heavyweight objects (30+ keys). Only `name` and
`id` are useful for display.

Verification tool: `node tools/dump-state.mjs`

---

## 4. Playback progress — the authoritative clock

This was the hardest thing to find, because progress is **not** in the Redux
store and the bundle creates **no `<audio>` element** (audio is decoded natively
in `cloudmusic.dll`).

Progress is a stream exported by the audio pipeline module:

```js
const mod = __moRequire('1186');
mod.audioPlayerPlayProgress$.subscribe(([playId, seconds, playState]) => { ... });
```

| Aspect | Measured value |
| --- | --- |
| Emission rate | ~**30 Hz** (314 events in 10 s) |
| Payload | array `[playId, seconds, playState]` |
| `playId` | string like `"2102424489_1COWG4"` = `songId_randomSuffix` |
| `seconds` | **seconds with 2 decimals** (`10.2`, `20.07`) — ×1000 for ms |
| `playState` | `1` while playing in the sample above; treat as opaque, use `playingState` from the store for state |
| Initial value | `null` — only emits once playback is running |
| When paused | emits nothing |

Other observables on the same module (all silent while paused; not yet fully
characterised): `audioPlayerVolume$`, `audioPlayerLoad$`, `audioPlayerPlayState$`,
`audioPlayerLiteralPlayState$`, `audioPlayerSeek$`, `audioPlayerSeekSeconds$`,
`audioPlayerEnd$`, `audioPlayerBuffering$`, `muteRcoverd$`.

**Design consequence**: the overlay should treat this as a high-rate tick source
and re-anchor its clock on every event, rather than polling the store. The store
is the source for *what* is playing; this stream is the source for *how far along*.

Verification tool: `node tools/watch-progress.mjs` (run while music is playing)

---

## 5. Lyrics

### Available from the client

`state['async:lyric']` exposes the parsed lyric document:

| Field | Meaning |
| --- | --- |
| `lyricLines[]` | original lyrics |
| `tlyricLines[]` | translation |
| `romaLyricLines[]` | romanisation |
| `currentUsedLyric` | e.g. `"none"` |
| `currentUsedLyricVersion` | number, `-1` when unavailable |
| `offset` | lyric offset setting |
| `yrcInfo` | word-by-word metadata |
| `isLoading`, `isLyricFetchFailed` | status flags |

These arrays were empty in the session we probed (the track had no lyric cached at
that moment), so field *presence* is confirmed but array *shape* is not yet
captured. Capture it on a track with lyrics before relying on it.

### Available directly, verified working

```js
// Node fetch, headers: Referer: https://music.163.com/ , UA: Mozilla/5.0
GET https://music.163.com/api/song/lyric/v1?id=<songId>&cp=false
    &lv=-1&kv=-1&tv=-1&rv=-1&yv=-1&ytv=-1&yrv=-1
```

Three shapes observed, all real samples:

1. Word-by-word, per-line JSON:
   `{"t":0,"c":[{"tx":"编曲: "},{"tx":"钱雷","li":"...","or":"orpheus://..."}]}`
2. Word-by-word, compact:
   `[16960,3560](16960,240,0)一(17200,350,0)双(17550,470,0)迷...`
3. Line-level only: `lrc` present, `yrc` absent (older catalogue entries).

Response keys: `lrc`, `klyric`, `tlyric`, `romalrc`, `yrc`, `ytlrc`, `yromalrc`.
**`yv=-1` is required** to receive `yrc`. Without it you only get `lrc`/`klyric`.

Caveat: `yrc` frequently opens with credit lines ("作词/作曲/编曲: …") carrying
`li`/`or` rich-text links. These must be filtered or they appear as lyrics.

Also note: `curl.exe` failed against this endpoint on this machine (TLS), while
Node's `fetch` worked. Use Node.

---

## 6. Playback control — current status

| Capability | Status |
| --- | --- |
| Read state and progress | **solved** |
| Play / pause | **solved** — media key, confirmed by the client (the user has verified it) |
| Skip to next / previous | **solved** — media key. The bridge dispatch returns `ok: true` and changes nothing; an earlier version of this table called it *solved* on the strength of that receipt. |
| Play mode | **solved** — `playing/onUpdate {playingMode, lastPlayingMode}`; see below |
| Volume / mute | **solved** — `AudioPlayer.setVolume`; see below |
| Seek | **solved** — `AudioPlayer.seek({playId, seekId, value})`; see below |

### The confirmation rule

Two different questions, and conflating them cost a lot of time here:

- `ControlResult.ok` — the command was delivered and executed without throwing.
- `ControlResult.confirmed` — the client was **observed** to change: `playingState` reached the
  expected value, or the song id changed, or the playhead jumped backwards by more than a second
  (a repeat-one skip changes neither of the first two). Bounded by `CONTROL_CONFIRM_MS = 900`.

Only `confirmed` is a working control. The host logs `成功` / `未确认` / `失败` with the `via` route and
the `playingState` transition, so a dead button is visible in the terminal instead of looking wired up.

### Why play/pause looked dead twice, for two different reasons

**First reason: the bridge had no `playPause` case.** The type was legal, the button sent it, and every
press fell to `default` and threw `unsupported command: playPause`.

**Second reason: the client kept running the previous injection.** After that case was added, the log
*still* said `unsupported command: playPause`. The guard that was meant to replace an old bridge
compared a hand-written `version: 2`, which nobody had bumped. It is now a content hash:
`hashScript(body)` (FNV-1a) is substituted into the script at `__MO_BRIDGE_ID__`, an installed copy
whose id differs is `dispose()`d before the new one takes over, and `tools/check-bridge-script.mjs`
asserts that the id really is the script's own hash and that it changes with the content. A
hand-maintained version number is a promise to remember; a hash is a fact.

**What was actually measured about the audio module.** With the fresh bridge in place, the call was
made on the audio module (`setAudioPlayerPlay` / `setAudioPlayerPause`, chosen from the bridge's own
read of `playingState`, 1 = paused / 2 = playing) rather than on a destructured reference. It runs
without throwing and `playingState` does not move. The real signature is not knowable from disk: the
install directory has no `.js` files and `orpheus.ntpk` does not contain the export names as readable
text.

### How a transport command is sent now

Routing lives in `Session.control()` (`packages/host/src/session.ts`):

1. **Media key is primary**, not a fallback: `VK_MEDIA_PLAY_PAUSE` (0xB3), `VK_MEDIA_NEXT_TRACK`
   (0xB0), `VK_MEDIA_PREV_TRACK` (0xB1), injected system-wide with `keybd_event` from
   `tools/media-key.ps1` via `packages/host/src/media-key.ts` (`stdio: 'ignore'`, spawn errors are
   reported not thrown). This is the client's own global hotkey — the path a keyboard's play button
   uses — so it does not depend on the client's internals and survives client updates.
   The keys *toggle/skip*, so **exactly one press is sent and there is no retry**: a fallback that
   pressed the key and then also dispatched through the bridge would skip two tracks whenever the
   confirmation merely arrived late. `tools/check-interaction.mjs` asserts `pressMediaKey` appears
   once and that `controlViaBridge` is reachable from exactly one branch.
2. **The bridge route** stays for everything with no media-key equivalent — `seek`, `setVolume`,
   `toggleMute`, `setMode` — and for `diagnoseTransport`. Each of those *is* confirmed now, against
   its own observable field: volume against `playing.playingVolume`, mode against `playingMode`,
   position against the playhead (or the client's own seek reply).
3. **A page-side diagnostic**, `{ type: 'diagnoseTransport' }`, requested when a key had no
   observable effect. It reports the play/pause exports with their arity, every dva action whose name
   mentions playing, and the client's own transport buttons in the DOM; the answer goes in the log
   line that explains the failure.

If the media key also proves inert, the remaining candidates are, in order:

1. Dismiss the media key as a *setting*: the client has a global-hotkey option that may be off, and
   `keybd_event` reaches nothing if nothing registered the key. `pressMediaKey` succeeding only means
   the key was injected; delivery is a separate fact that only a real press can establish.
2. Click the client's own transport button, which `diagnoseTransport` now lists. That is the one
   control path already known to work, and it is what "reuse the app's own path" amounts to.
3. Hook `Function.prototype.apply`/`call` with a stack-based module lookup to find the *reference*
   the client's own button uses, and call that.
4. Enumerate more of the `playing/*` action namespace and replay through `dispatch` — with the
   caveat that a dispatch returning `ok: true` is not evidence, per the confirmation rule above.

Also useful: `state['@@dva']` holds the dva model table; enumerating its keys yields every
registered action name, and `diagnoseTransport` prints the play/pause ones.

### Play mode, volume and position — all three measured

These are the controls with **no media-key equivalent**, so unlike play/pause they have to go
through the client. Each was established by driving the client's own control and reading the
result, not by reading the bundle — the bundle is packed, and the two most useful surfaces here
(an object instance's prototype methods and a module-level object literal) are invisible to any
"scan the exports" trick.

**Play mode.** Four user-facing values, and their order was obtained by clicking the client's own
mode button four times and reading `playing.playingMode` plus the button's own tooltip:

| `playingMode` | Tooltip | Client's own icon class |
| --- | --- | --- |
| `playOrder` | 顺序播放 | `cmd-icon-order` |
| `playCycle` | 列表循环 | `cmd-icon-loop` |
| `playOneCycle` | 单曲循环 | `cmd-icon-singleloop` |
| `playRandom` | 随机播放 | `cmd-icon-shuffle` |

(`playAi` and `playFm` are in the client's enum — module `6`, export `i` — but switching into them
rewrites the play queue, so the card does not offer them.)

Setting it is a plain store write, with the mode we came *from* passed along:

```js
store.dispatch({ type: 'playing/onUpdate', payload: { playingMode: next, lastPlayingMode: current } });
```

That is the last thing the client's own mode effect does, and the client's own footer icon follows
it. A `store.dispatch` tap records **nothing** while clicking that button, because the models hold
their own reference to dispatch — so none of the slider or mode paths are observable that way, and
the action had to be found by trying it.

**Volume.** `playing.playingVolume` is the store's copy, but writing it does not change the sound:
dispatching `playing/setVolume {volume: 0.35}` moved the store to 0.35 and left
`AudioPlayer.getApplicationVolume()` at 0.5. The client's own slider dispatches *nothing at all* —
dragging it from 0.42 to 0.30 recorded zero actions and the store followed anyway. The real call is:

```js
AudioPlayer.setVolume(0.42)   // module 4, export `AudioPlayer`
```

which is what the client's `stepVolume` effect uses; the store then follows on its own through the
client's native-to-store `subscribeVolume` subscription, which is also the receipt the host
confirms against.

Mute is *not* a flag. The client's own effect mutes by remembering the volume and setting it to
zero, and unmuting restores the remembered value without clearing it:

```js
// mute:   put({type:'onUpdate', payload:{muteVolume: playingVolume}}); setVolume(0)
// unmute: setVolume(muteVolume || 0.1)
```

So `muteVolume > 0` means "not muted", and the correct test for muted is `playingVolume === 0`.

**Position.** `audioplayer.seek` takes `(playId, seekId, value)` and `value` is **whole seconds**.
The shape comes from the client's own progress bar, captured by wrapping the wrapper's method (its
methods live on a prototype, so an exports scan cannot see them) and dragging:

```
seek({ playId: "2102424489_UOH3CY", seekId: "2102424489|seek|46YB26", value: 109 })
  → { playId, seekId, code: 0, position: 109 }
```

- `playId` comes from the progress stream: `audioPlayerPlayProgress$` publishes
  `[playId, seconds, state]`.
- `seekId` is a fresh unique id per call — the reply is matched by it.
- The reply is a real receipt (`code` plus where the player ended up), which is what
  `ControlResult.positionMs` carries.

**The native player's whole vocabulary**, from `call("audioplayer.<name>", ...)` literals:
`load`, `play`, `pause`, `stop`, `seek`, `getPlayedTime`, `getPlaybackInfo`, `setVolume`,
`setPlaybackRate`, `getApplicationVolume`, `getSystemMasterVolume`, `isDeviceMute`. Volume is a
method on the `AudioPlayer` instance rather than one of these named calls — which is why
`audioplayer.*` alone looks like it has no volume control.

---

## 7. Things that looked promising but are dead ends

| Lead | Verdict |
| --- | --- |
| Module `716` exporting `play/pause/setSpeed/goToAndStop` | It is the **Lottie** animation library (`version: 5.13.0`), not the player. |
| `<audio>` / `HTMLMediaElement` | The bundle creates none; audio is native. |
| `navigator.mediaSession.metadata` | Not exposed. |
| `store.dispatch` tap for play/pause/mute | Silent for those actions. |
| `playing.playId` | Present but empty string; the real id lives in the progress tuple. |
| localStorage progress keys | None found. |

---

## 8. Tooling map

| Tool | Purpose |
| --- | --- |
| `tools/probe-cdp.mjs` | Is the channel up? Three-state diagnosis. |
| `tools/discover.mjs` | Phase-0 gate: bootstrap + find dva singleton + snapshot. |
| `tools/dump-state.mjs` | Full field dump (state, lyric slice, audio probe, api search). |
| `tools/find-progress.mjs` | Hunt for progress across the state tree and streams. |
| `tools/find-bridge.mjs` | Find player/native bridges and control surfaces. |
| `tools/inspect-player.mjs` | Introspect the dva app and specific module exports. |
| `tools/audio-streams.mjs` | Sample audio pipeline streams; find call sites. |
| `tools/watch-progress.mjs` | **Progress acceptance test** — run while playing. |
| `tools/capture-controls.mjs` | Tap `store.dispatch` for a fixed window and capture actions. |
| `tools/arm-dispatch-tap.mjs` | Persistent dispatch recorder: `--install`, `--dump`, `--clear`. Records nothing for the client's own sliders or mode button: those models hold their own dispatch reference. |
| `tools/probe-controls.mjs` | **Read-only reconnaissance for mode / volume / seek**: the mode enum, the `audioplayer.*` vocabulary, the `AudioPlayer` wrapper and the source of its methods. |
| `tools/probe-client-ui.mjs` | **Mutating reconnaissance**: drives the client's own controls with real CDP input events and records what they call, so argument shapes are measured instead of guessed. Restores mode and volume afterwards. |
| `tools/host-smoke.mjs` | Live end-to-end harness. `--control type=setVolume,volume=0.4` pushes a command through host → bridge → client and prints whether the client was confirmed to change. |
| `tools/render-icons.mjs` (`npm run icons`) | Draws the card's own SVG icons into PNGs in `.scratch/icons/`, together with the states a stateful icon has. The tooling shell cannot launch a browser, so this is how an icon gets *looked at*. Found the invisible sound waves and the four-diamond mute cross. |
| `tools/svg-path.mjs` | The path parser and rasteriser behind it, plus the shared fill/stroke resolver. Used by `check-interaction.mjs` for the assertions that can run in `npm run check`. |
| `tools/transport-layout.mjs` | Where the five transport controls land, computed from the stylesheet (flexbox, two equal side slots, a gapped centre group). Used by the check and by the row pictures. |
| `npm run icons` (row pictures) | The same numbers drawn: `.scratch/icons/row-*.png` shows the whole transport row - one picture per play mode and per volume state - so the arrangement can be looked at without a browser. |
| `tools/tap-controls.mjs` | Wrap pipeline functions to capture call arguments. |
| `tools/host-smoke.mjs` | **Phase-1 end-to-end test**: host + fake overlay client. |
| `tools/host-run.mjs` | Run the host in the foreground with a live track view. |
| `tools/debug-launch.ps1` | Create the debug-channel launcher shortcut. |

All read-only except `debug-launch.ps1` (creates a .lnk), `relaunch-ncm.ps1`
(stops/starts the client), and the tap modes (page-memory only, no client files).

---

## 9. Phase status

**Phase 0 — closed.** Channel, discovery, state, progress, lyrics-from-public-API
and track-change control are all measured and working.

**Phase 1 — closed.** The host runs end to end:

```
node tools/host-smoke.mjs
→ hello=1  connection=2  snapshot=2  playhead=313 (~31/s)  ready ✅
```

Verified in that run: song id `2102423618`, duration `281654 ms`, cover present,
status `playing`, queue index 8/11, chorus 36500–85000 ms, playhead
`206310 ms / playId=2102423618_JUO8B7`.

**Still open.** Play/pause/mute/mode have no confirmed command path. Track change
is solved (`playing/onUpdate` + `playing/onUpdateCurPlaying`, verified by capturing
real dispatches). Next options are listed in section 6.

### Bonus discovery

The client already extracts a colour palette from the cover and broadcasts it:

```
store.dispatch({ type: 'page:vinylPage/setColor', payload: {
  dominantColor: { r: 184, g: 208, b: 224 },
  topColor:      { r: 184, g: 208, b: 224 },
  bottomColor:   { r: 176, g: 200, b: 224 },
}})
```

That is free material for the overlay's palette engine — no image decoding needed
for the common case — and it matches the visual language of the reference design.
The host does not consume it yet.

