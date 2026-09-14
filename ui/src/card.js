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

    this.el.card.dataset.status = snapshot.playback?.status ?? 'unknown';
    this.el.timeTotal.textContent = formatTime(song?.durationMs ?? 0);

    if (trackChanged) this.applyCover(song?.coverUrl ?? null);
    return trackChanged;
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

  setConnection(info) {
    this.el.card.dataset.connected = String(info.state === 'ready');
    this.el.status.textContent = info.detail || info.state;
  }

  /* ----------------------------------------------------------------- cover */

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
    if (fraction !== this.lastFraction) {
      this.lastFraction = fraction;
      const percent = `${(fraction * 100).toFixed(2)}%`;
      this.el.fill.style.width = percent;
      this.el.miniFill.style.width = percent;
    }
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
    button.title = locked ? '已锁定：不会自动收起（L）' : '锁定：不自动收起（L）';
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
