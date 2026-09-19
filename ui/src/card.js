/**
 * DOM rendering for the card.
 *
 * Two things changed when the layout became 9:16 portrait:
 *
 *  - The palette strip is now interactive. Its five swatches are the background
 *    picker (tap to paint the card, tap again for frosted glass), which is the six
 *    background options from the reference design.
 *  - Text polarity is recomputed per background, not just per cover, because a flat
 *    palette colour and a translucent glass panel need different contrast handling.
 */

import { formatTime } from './clock.js';
import { loadBackgroundChoice, REFERENCE_PALETTE, relayout, saveBackgroundChoice, schemeFor } from './layout.js';
import { css, paletteFor } from './palette.js';

/** Chinese labels for the client's four user-facing play modes. */
export const MODE_LABELS = {
  playOrder: '顺序播放',
  playCycle: '列表循环',
  playOneCycle: '单曲循环',
  playRandom: '随机播放',
};

/**
 * The order the mode button cycles in, and the order the client's own button uses.
 *
 * Local constant rather than an import: `ui/` deliberately knows nothing about the host's
 * modules, and this list is the *client's* behaviour, which is what the card is mirroring.
 * `ui/test/mode.test.mjs` pins it to the same four values as the shared contract.
 */
export const MODE_CYCLE = ['playOrder', 'playCycle', 'playOneCycle', 'playRandom'];

const $ = (id) => document.getElementById(id);

/** #RRGGBB for a 0-255 channel triple. */
function toHex({ r, g, b }) {
  const part = (value) => Math.max(0, Math.min(255, Math.round(value))).toString(16).padStart(2, '0');
  return `#${part(r)}${part(g)}${part(b)}`.toUpperCase();
}

/**
 * Which swatch a click at `clientX` selects.
 *
 * The five swatches are equal columns of the band, so the index is just the position divided
 * into five. Extracted and exported because this is the path that runs whenever a click lands
 * in the band's padded hit area rather than on a swatch box, and an off-by-one there silently
 * paints the neighbouring colour. `ui/test/card.test.mjs` pins it down.
 *
 * @param {number} clientX pointer position in viewport coordinates
 * @param {number} left band's left edge
 * @param {number} width band's width
 * @param {number} count number of swatches
 */
export function bandIndexFromX(clientX, left, width, count) {
  if (!(width > 0) || !(count > 0)) return 0;
  const ratio = (clientX - left) / width;
  return Math.min(count - 1, Math.max(0, Math.floor(ratio * count)));
}

export class CardView {
  constructor(options = {}) {
    this.el = {
      card: $('card'),
      cover: $('cover'),
      title: $('title'),
      artist: $('artist'),
      fill: $('progress-fill'),
      progress: $('progress'),
      progressTrack: $('progress-track'),
      progressThumb: $('progress-thumb'),
      timeNow: $('time-now'),
      timeTotal: $('time-total'),
      palette: $('palette'),
      paletteLabels: $('palette-labels'),
      status: $('status-text'),
      stage: $('stage'),
      miniCover: $('mini-cover'),
      miniTitle: $('mini-title'),
      miniArtist: $('mini-artist'),
      miniFill: $('mini-fill'),
      lock: $('lock'),
      fixClient: $('fix-client'),
      coverPick: $('cover-pick'),
      mode: $('mode'),
      volume: $('volume'),
      volumeWrap: $('volume-wrap'),
      volumePop: $('volume-pop'),
      volumeBar: $('volume-bar'),
      volumeFill: $('volume-fill'),
      volumeThumb: $('volume-thumb'),
      volumeValue: $('volume-value'),
    };

    this.onBackgroundChange = options.onBackgroundChange ?? (() => {});
    /**
     * Called with the extracted palette so the caller can hand it to the lyrics view,
     * which orders its own ramp. Passed as a callback rather than imported to keep the two
     * views decoupled.
     */
    this.onPalette = options.onPalette ?? (() => {});
    this.currentCoverUrl = null;
    this.currentSongKey = null;
    /** @type {{r:number,g:number,b:number}[]} */
    this.palette = REFERENCE_PALETTE;
    /** Index into the palette. */
    this.backgroundChoice = loadBackgroundChoice();

    this.lastFraction = -1;
    this.lastSecond = -1;
    /** Non-null while a scrub preview is being drawn instead of the clock. */
    this.scrubFraction = null;
    /** Set by setIdle() so the reason for an empty card is visible. */
    this.idleReason = null;

    this.renderBand();
    this.applyBackground();
    this.bindBand();

    // Keep the layout unit and the expanded/collapsed mode in step with the stage's rendered
    // size. A ResizeObserver catches cases a window resize event misses (the shell resizing
    // us is exactly that case).
    const stage = this.el.stage;
    const onResize = () => relayout(stage);
    window.addEventListener('resize', onResize);
    if (stage && typeof ResizeObserver !== 'undefined') {
      new ResizeObserver(onResize).observe(stage);
    }
  }

  get background() {
    return this.backgroundChoice;
  }

  /** 'expanded' | 'mini' - which of the two subtrees the stage is showing. */
  get mode() {
    return this.el.stage?.dataset.mode ?? 'expanded';
  }

  /* -------------------------------------------------------------- playback */

  setSnapshot(snapshot) {
    const song = snapshot.song;
    const songKey = song ? `${song.id ?? ''}|${song.name}` : null;
    const trackChanged = songKey !== this.currentSongKey;
    this.currentSongKey = songKey;
    this.idleReason = null;

    const title = song?.name?.trim() || '未检测到播放';
    const artist = song?.artists?.length
      ? song.artists.map((a) => a.name).join(' / ')
      : '等待网易云音乐';

    this.el.title.textContent = title;
    this.el.artist.textContent = artist;
    // The rolled-up bar carries the same information, so it is updated from the same place.
    this.el.miniTitle.textContent = title;
    this.el.miniArtist.textContent = artist;

    this.setStatus(snapshot.playback?.status ?? 'unknown');    this.el.timeTotal.textContent = formatTime(song?.durationMs ?? 0);
    this.setMode(snapshot.playback?.mode ?? null);
    this.setVolume(snapshot.playback?.volume ?? null, snapshot.playback?.muted ?? null);

    if (trackChanged) this.applyCover(song?.coverUrl ?? null);
    return trackChanged;
  }

  /**
   * Reflect the transport status on the card.
   *
   * Separate from `setSnapshot` because the play button is also driven by the optimistic flip: the
   * card has to be able to draw "playing" *before* the client says so, and put it back if the host
   * reports the command did not land - without touching anything else in the snapshot.
   */
  setStatus(status) {
    const next = status ?? 'unknown';
    if (this.el.card.dataset.status !== next) this.el.card.dataset.status = next;
  }

  /**
   * Reflect the client's play mode on the mode button.
   *
   * The button only knows the four modes the card offers; anything else (`playAi`, `playFm`) is
   * shown as the nearest of them so the button is never blank, but the card will not *set* those.
   */
  setMode(mode) {
    const button = this.el.mode;
    if (!button) return;
    const known = MODE_CYCLE.includes(mode) ? mode : MODE_CYCLE[0];
    if (button.dataset.mode === known) return;
    button.dataset.mode = known;
    button.title = `${MODE_LABELS[known]}（点击切换）`;
  }

  /**
   * Draw a volume the *user* is choosing, bypassing the drag guard below.
   *
   * `setVolume` deliberately ignores snapshot updates while a drag is live, or the client's own
   * value would yank the bar out from under the pointer. The preview is the exception: it is the
   * thing the drag is producing.
   */
  setVolumePreview(volume) {
    const level = Math.max(0, Math.min(1, Number.isFinite(volume) ? volume : 0));
    const percent = Math.round(level * 100);
    if (this.el.volumeFill) this.el.volumeFill.style.width = `${percent}%`;
    if (this.el.volumeThumb) this.el.volumeThumb.style.left = `${percent}%`;
    this.setVolumeReadout(percent);
    if (this.el.volume) {
      this.el.volume.dataset.level = level <= 0.001 ? 'mute' : level < 0.5 ? 'low' : 'high';
    }
    if (this.el.volumeBar) this.el.volumeBar.setAttribute('aria-valuenow', String(percent));
  }

  /**
   * Reflect volume and mute on the speaker button and its bar.
   *
   * `muted` comes from the client, but the level shown is derived from the volume itself: the
   * client's `muteVolume` is the *remembered* volume while muted, so trusting it alone would draw
   * a full speaker next to a silenced player.
   */
  setVolume(volume, muted) {
    const button = this.el.volume;
    if (!button) return;
    const level = volume == null ? 0 : Math.max(0, Math.min(1, volume));
    const silent = muted === true || level <= 0.001;
    const state = silent ? 'mute' : level < 0.5 ? 'low' : 'high';
    if (button.dataset.level !== state) button.dataset.level = state;

    const percent = Math.round(level * 100);
    const bar = this.el.volumeBar;
    if (bar && bar.dataset.scrubbing !== 'true') {
      this.el.volumeFill.style.width = `${percent}%`;
      this.el.volumeThumb.style.left = `${percent}%`;
    }
    this.setVolumeReadout(percent);
    if (bar) bar.setAttribute('aria-valuenow', String(percent));
    if (button) button.title = silent ? '已静音（点击恢复）' : `音量 ${percent}%（点击静音）`;
  }

  /**
   * Put the number above the thumb, and keep it the same number the slider reports.
   *
   * Positioned by the same percentage as the thumb rather than at a fixed spot, because it belongs
   * to the thumb: the card shows it when the pointer is over the thumb, and it has to be *there*.
   */
  setVolumeReadout(percent) {
    const value = this.el.volumeValue;
    if (!value) return;
    if (value.textContent !== String(percent)) value.textContent = String(percent);
    value.style.left = `${percent}%`;
  }

  /**
   * Draw a scrub preview, or return to following the clock.
   *
   * `null` hands the bar back to the playback clock. While a fraction is given, the tick loop
   * leaves the bar alone: a preview that the next frame overwrites is the same as no preview, and
   * the user is dragging precisely because they want to see where they are going.
   */
  setScrub(fraction, positionMs = null) {
    const progress = this.el.progress;
    if (!progress) return;
    if (fraction == null) {
      progress.removeAttribute('data-scrubbing');
      this.scrubFraction = null;
      this.lastFraction = -1;
      this.lastSecond = -1;
      return;
    }
    const clamped = Math.max(0, Math.min(1, fraction));
    this.scrubFraction = clamped;
    progress.dataset.scrubbing = 'true';
    const percent = `${(clamped * 100).toFixed(2)}%`;
    this.el.fill.style.width = percent;
    this.el.progressThumb.style.left = percent;
    this.setProgressValue(clamped);
    if (positionMs != null) this.el.timeNow.textContent = formatTime(positionMs);
  }

  /**
   * Keep the bar's `aria-valuenow` in step with what it shows.
   *
   * The element is a `role="slider"`, and until this existed the attribute sat at the `0` it was
   * born with: the bar looked like a slider to assistive technology and reported a position that
   * never changed. Updated only when the whole percent changes, because it is written from the
   * frame loop.
   */
  setProgressValue(fraction) {
    const track = this.el.progressTrack;
    if (!track) return;
    const percent = Math.round(Math.max(0, Math.min(1, fraction)) * 100);
    if (this.lastProgressPercent === percent) return;
    this.lastProgressPercent = percent;
    track.setAttribute('aria-valuenow', String(percent));
  }

  /**
   * Show why nothing is playing. Distinguishing "host unreachable" from "client has
   * no track" matters: previously both rendered as 未检测到播放 and the real cause was
   * invisible.
   */
  setIdle(reason) {
    if (this.currentSongKey || this.idleReason === reason) return;
    this.idleReason = reason;
    this.el.title.textContent = reason;
    this.el.artist.textContent = '检查宿主是否在运行（npm run host）';
    this.el.miniTitle.textContent = reason;
    this.el.miniArtist.textContent = '检查宿主是否在运行';
  }

  /**
   * Reflect the host's connection state, and offer the one fix that exists.
   *
   * Two of the host's states mean "the client is there but the overlay cannot see it", and both are
   * cured by the same action: restarting the client with its debug channel open. `client-not-running`
   * is a launch, `needs-relaunch` a restart, so the button says which - a button labelled 重启 when
   * nothing is running would be a small lie.
   */
  setConnection(info) {
    this.el.card.dataset.connected = String(info.state === 'ready');
    this.el.status.textContent = info.detail || info.state;

    const fix = this.el.fixClient;
    if (!fix) return;
    const launch = info.state === 'client-not-running';
    const wanted = launch || info.state === 'needs-relaunch';
    // What the button is *for*; the pending state only changes its wording.
    this.fixLabel = launch ? '启动客户端' : '重启客户端';
    if (wanted && fix.hidden) fix.hidden = false;
    else if (!wanted && !fix.hidden) fix.hidden = true;
    if (wanted) {
      fix.textContent = this.fixPending ? '正在启动…' : this.fixLabel;
      fix.disabled = this.fixPending === true;
    }
  }

  /** While the shell is starting the client, the button must not be pressed a second time. */
  setFixPending(pending) {
    this.fixPending = pending === true;
    const fix = this.el.fixClient;
    if (!fix || fix.hidden) return;
    fix.disabled = this.fixPending;
    fix.textContent = this.fixPending ? '正在启动…' : this.fixLabel ?? '重启客户端';
  }

  /* ----------------------------------------------------------------- cover */

  /**
   * Reflect the custom cover's state on its button.
   *
   * `empty` and `off` are both "not showing your picture", but a click does different things, so the
   * state is on the element (`data-state`) rather than inferred from `aria-pressed`, and the tooltip
   * comes from the same function that decides it - see ui/src/cover-choice.js.
   */
  setCoverState(state, title) {
    const button = this.el.coverPick;
    if (!button) return;
    if (button.dataset.state !== state) button.dataset.state = state;
    const pressed = state === 'on' ? 'true' : 'false';
    if (button.getAttribute('aria-pressed') !== pressed) button.setAttribute('aria-pressed', pressed);
    if (title && button.title !== title) button.title = title;
  }

  applyCover(url) {
    if (url === this.currentCoverUrl) return;
    this.currentCoverUrl = url;

    if (!url) {
      this.el.cover.classList.remove('is-loaded');
      this.el.cover.removeAttribute('src');
      this.el.miniCover.removeAttribute('src');
      this.setPalette(REFERENCE_PALETTE);
      return;
    }

    void paletteFor(url).then((palette) => {
      if (this.currentCoverUrl !== url) return;
      if (palette?.colors?.length) this.setPalette(palette.colors);
    });

    /*
     * The card fades its cover in over a gradient placeholder; the rolled-up thumbnail keeps
     * its own gradient until the image paints instead, so a strip that has not loaded yet
     * shows a colour rather than a hole.
     */
    this.el.cover.onload = () => this.el.cover.classList.add('is-loaded');
    this.el.cover.onerror = () => this.el.cover.classList.remove('is-loaded');
    this.el.cover.src = url;
    this.el.miniCover.src = url;
  }

  /* --------------------------------------------------------------- palette */

  setPalette(colors) {
    if (!colors?.length) return;
    this.palette = colors.slice(0, 5);
    this.renderBand();
    this.applyBackground();

    // Accent colours drive the wash and the primary button.
    const root = document.documentElement;
    const sorted = [...this.palette].sort((a, b) => (a.r + a.g + a.b) - (b.r + b.g + b.b));
    root.style.setProperty('--accent-top', css(sorted[sorted.length - 1]));
    root.style.setProperty('--accent-bottom', css(sorted[0]));
    root.style.setProperty('--accent-dominant', css(this.palette[0]));
    root.style.setProperty('--accent-soft', css(this.palette[0], 0.24));
    // Hand the palette plus the colour actually painted behind it, so the lyrics view can
    // pick text colours by contrast rather than assuming the palette is legible.
    const background = this.palette[this.backgroundChoice] ?? this.palette[0];
    this.onPalette(this.palette, background);
  }

  /**
   * Build the colour band and its hex labels.
   *
   * Five equal segments sampled from the cover, with the hex code printed under each.
   * There is no sixth "frosted glass" option: the translucent surface rendered as plain
   * white rather than a tinted panel, so it was dropped in favour of the five colours.
   */
  renderBand() {
    const band = document.createDocumentFragment();
    this.palette.forEach((color, index) => {
      const segment = document.createElement('button');
      segment.type = 'button';
      segment.className = 'band-segment';
      segment.style.background = css(color);
      const hex = toHex(color);
      segment.title = `${hex} — 点击设为背景色`;
      segment.setAttribute('aria-label', `背景色 ${hex}`);
      segment.setAttribute('aria-pressed', String(this.backgroundChoice === index));
      segment.dataset.index = String(index);
      band.append(segment);
    });
    this.el.palette.replaceChildren(band);

    const labels = document.createDocumentFragment();
    this.palette.forEach((color) => {
      const label = document.createElement('span');
      label.className = 'band-label';
      label.textContent = toHex(color);
      labels.append(label);
    });
    this.el.paletteLabels.replaceChildren(labels);
  }

  /**
   * Pick a colour from a press anywhere on the band.
   *
   * Delegated on the container rather than bound per swatch, and the index falls back to the
   * pointer's position. Four reasons, all of which bit in practice:
   *
   *  - The swatches are rebuilt by renderBand() on every palette change, so per-swatch
   *    listeners are thrown away and re-created; a container listener is stable.
   *  - The band's clickable box is padded out beyond the visible strip (see `.band` in
   *    card.css) so it is a comfortable target. Presses in that padding land on the
   *    container, not on a swatch.
   *  - `pointerdown`, not `click`: a click is only delivered if press and release land on the
   *    same element, and the band is rebuilt from inside this very handler, which is exactly
   *    the kind of thing that can eat a click. Selecting on press is also what a colour picker
   *    should do.
   *  - If the press never reaches the page at all, the hit-test self-check below says so - see
   *    `reportHitTargets`.
   */
  bindBand() {
    const band = this.el.palette;
    if (!band) return;

    const choose = (event) => {
      const segment = event.target instanceof Element ? event.target.closest('.band-segment') : null;
      let index;
      if (segment) {
        index = Number(segment.dataset.index);
      } else {
        // Pressed the padding rather than a swatch: map x onto the five equal columns.
        const rect = band.getBoundingClientRect();
        index = bandIndexFromX(event.clientX, rect.left, rect.width, this.palette.length);
      }
      this.setBackground(index);
      console.info(`[overlay] 背景色 -> ${toHex(this.palette[index] ?? this.palette[0])}（第 ${index + 1} 块）`);
    };

    band.addEventListener('pointerdown', choose);
  }

  /**
   * Report what is actually on top of every interactive control.
   *
   * There is no browser available to the tooling that maintains this, so "the band cannot be
   * clicked" had to be diagnosed from the outside. `elementFromPoint` answers the one question
   * reasoning cannot: is the control the topmost element at its own coordinates, or is
   * something covering it? The shell forwards this to its terminal.
   *
   * Controls that are deliberately not hit-testable yet are reported as `inert` rather than
   * `BLOCKED`: the top-bar buttons are `pointer-events: none` until the card is hovered, and
   * the mini bar is `display: none` until the card is rolled up. Only a control that CSS says
   * is clickable *and* is covered by something else is a real fault.
   */
  reportHitTargets() {
    const describe = (element) => {
      if (!element) return 'nothing';
      if (element === document.documentElement) return 'html';
      if (element === document.body) return 'body';
      const id = element.id ? `#${element.id}` : '';
      const cls =
        typeof element.className === 'string' && element.className.trim()
          ? `.${element.className.trim().split(/\s+/).join('.')}`
          : '';
      return `${element.tagName.toLowerCase()}${id}${cls}`;
    };

    const targets = [
      ...this.el.palette.children,
      ...document.querySelectorAll('.ctrl'),
      ...document.querySelectorAll('.icon-btn'),
      ...document.querySelectorAll('.mini-action'),
    ];

    const rows = [];
    for (const element of targets) {
      const rect = element.getBoundingClientRect();
      const box = `${Math.round(rect.width)}x${Math.round(rect.height)} @ ${Math.round(rect.left)},${Math.round(rect.top)}`;
      const label = describe(element);

      if (rect.width < 1 || rect.height < 1) {
        rows.push({ label, box, top: '-', state: 'not-rendered' });
        continue;
      }
      if (getComputedStyle(element).pointerEvents === 'none') {
        rows.push({ label, box, top: '-', state: 'inert' });
        continue;
      }

      const top = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      const reachable = top === element || element.contains(top) || top?.contains(element);
      rows.push({ label, box, top: describe(top), state: reachable ? 'ok' : 'BLOCKED' });
    }

    const clickable = rows.filter((row) => row.state === 'ok' || row.state === 'BLOCKED');
    const blocked = clickable.filter((row) => row.state === 'BLOCKED');
    console.info(
      `[overlay] 命中自检: ${clickable.length - blocked.length}/${clickable.length} 个可点击控件在最上层` +
        `（色带 ${Math.round(this.el.palette.getBoundingClientRect().height)}px 高，共 ${this.el.palette.children.length} 块）`,
    );
    for (const row of rows) {
      console.info(`  ${row.state.padEnd(12)} ${row.label.padEnd(30)} ${row.box.padEnd(22)} 顶层=${row.top}`);
    }
    if (blocked.length) {
      console.warn(
        `[overlay] ${blocked.length} 个控件被遮挡，按压不会到达它们: ${blocked
          .map((row) => `${row.label} <- ${row.top}`)
          .join('; ')}`,
      );
    }
    return rows;
  }

  setBackground(choice) {
    const index = typeof choice === 'number' && choice >= 0 && choice < this.palette.length ? choice : 0;
    this.backgroundChoice = index;
    saveBackgroundChoice(index);
    this.renderBand();
    this.applyBackground();
    this.onBackgroundChange(index);
  }

  /** Paint the card and pick a text scheme that actually contrasts with it. */
  applyBackground() {
    const root = document.documentElement;
    const color = this.palette[this.backgroundChoice] ?? this.palette[0];

    this.el.card.dataset.bg = 'palette';
    root.style.setProperty('--bg', color ? css(color) : 'transparent');

    const { scheme, scrim, contrast } = schemeFor(color);
    root.dataset.scheme = scheme;
    root.style.setProperty('--scrim', scrim);

    // Exposed for the devtools console; handy when tuning palette choices.
    root.dataset.bgContrast = contrast ? contrast.toFixed(2) : '';

    // The lyrics view picks its text colours by contrast against this background, so it
    // must be told whenever the background changes.
    this.onPalette(this.palette, color);
  }

  /* ------------------------------------------------------------------ tick */

  tick(positionMs, fraction) {
    /*
     * While a scrub preview is on screen the expanded bar belongs to the pointer, not the clock.
     *
     * The rolled-up bar is still updated: it is a different surface (and not even visible while the
     * card is expanded), and leaving it stale would mean the strip shows a position from before the
     * seek the moment the card rolls up.
     */
    if (fraction !== this.lastFraction) {
      this.lastFraction = fraction;
      const percent = `${(fraction * 100).toFixed(2)}%`;
      this.el.miniFill.style.width = percent;
      if (this.scrubFraction == null) {
        this.el.fill.style.width = percent;
        this.el.progressThumb.style.left = percent;
        this.setProgressValue(fraction);
      }
    }
    if (this.scrubFraction != null) return;
    const second = Math.floor(positionMs / 1000);
    if (second !== this.lastSecond) {
      this.lastSecond = second;
      this.el.timeNow.textContent = formatTime(positionMs);
    }
  }

  /** Reflect the "do not auto-collapse" state on the lock button. */
  setLocked(locked) {
    const button = this.el.lock;
    if (!button) return;
    button.setAttribute('aria-pressed', String(!!locked));
    button.title = locked ? '已锁定（L）' : '锁定（L）';
  }

  /* ------------------------------------------------------------------- face */

  get face() {
    return this.el.card.dataset.face ?? 'front';
  }

  setFace(face) {
    this.el.card.dataset.face = face;
  }

  flip() {
    this.setFace(this.face === 'front' ? 'back' : 'front');
  }
}
