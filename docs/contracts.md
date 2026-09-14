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
| Skip to next / previous | **solved** — clicking next in the UI dispatches `playing/onUpdate` + `playing/onUpdateCurPlaying` carrying the full new `curPlaying` object. Dispatching these (or the equivalent player action) reproduces a track change. |
| Play / pause / mute / mode | **not yet pinned down** |

Why play/pause is still open: they do **not** appear on `store.dispatch`, and
wrapping the audio module's exported `setAudioPlayerPlay/Pause/Stop` captured zero
calls even when the buttons were clicked. Reason: the consumer destructured the
function reference before we wrapped it, so replacing the export did not affect
the call site.

Candidate approaches for the next session, in order of preference:

1. Hook `Function.prototype.apply`/`call` with a stack-based module lookup and
   invoke a transport command indirectly, so the app's own path is reused.
2. Intercept at the native boundary (the CEF message channel) and learn the
   native command names.
3. Ship **media-key input** (`keybd_event` on `VK_MEDIA_PLAY_PAUSE` / `NEXT` /
   `PREV` / mute) as the baseline control path. It is version-proof and cannot
   break on client updates, at the cost of being fire-and-forget (no confirmation).
4. Enumerate more of the `playing/*` action namespace and attempt replay through
   `dispatch` with observed payload shapes.

Also useful: `state['@@dva']` holds the dva model table; enumerating its keys
yields every registered action name and is the cheapest place to look next.

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
| `tools/arm-dispatch-tap.mjs` | Persistent dispatch recorder: `--install`, `--dump`, `--clear`. |
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

