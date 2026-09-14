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
import { applyLayoutUnit, loadBackgroundChoice, REFERENCE_PALETTE, saveBackgroundChoice, schemeFor } from './layout.js';
import { css, paletteFor } from './palette.js';

const $ = (id) => document.getElementById(id);

/** #RRGGBB for a 0-255 channel triple. */
function toHex({ r, g, b }) {
  const part = (value) => Math.max(0, Math.min(255, Math.round(value))).toString(16).padStart(2, '0');
  return `#${part(r)}${part(g)}${part(b)}`.toUpperCase();
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
      flip: $('flip'),
      credit: $('credit'),
      stage: $('stage'),
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
    /** 'glass' or a palette index. */
    this.backgroundChoice = loadBackgroundChoice();

    this.lastFraction = -1;
    this.lastSecond = -1;
    /** Set by setIdle() so the reason for an empty card is visible. */
    this.idleReason = null;

    this.renderBand();
    this.applyBackground();

    // Keep the layout unit in step with the stage's rendered size. A ResizeObserver
    // catches cases a window resize event misses (e.g. the shell resizing us).
    const stage = this.el.stage;
    const relayout = () => applyLayoutUnit(stage);
    window.addEventListener('resize', relayout);
    if (stage && typeof ResizeObserver !== 'undefined') {
      new ResizeObserver(relayout).observe(stage);
    }
  }

  get background() {
    return this.backgroundChoice;
  }

  /* -------------------------------------------------------------- playback */

  setSnapshot(snapshot) {
    const song = snapshot.song;
    const songKey = song ? `${song.id ?? ''}|${song.name}` : null;
    const trackChanged = songKey !== this.currentSongKey;
    this.currentSongKey = songKey;
    this.idleReason = null;

    this.el.title.textContent = song?.name?.trim() || '未检测到播放';
    this.el.artist.textContent = song?.artists?.length
      ? song.artists.map((a) => a.name).join(' / ')
      : '等待网易云音乐';

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
      this.setPalette(REFERENCE_PALETTE);
      return;
    }

    void paletteFor(url).then((palette) => {
      if (this.currentCoverUrl !== url) return;
      if (palette?.colors?.length) this.setPalette(palette.colors);
    });

    this.el.cover.onload = () => this.el.cover.classList.add('is-loaded');
    this.el.cover.onerror = () => this.el.cover.classList.remove('is-loaded');
    this.el.cover.src = url;
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
      segment.addEventListener('click', () => this.setBackground(index));
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
      this.el.fill.style.width = `${(fraction * 100).toFixed(2)}%`;
    }
    const second = Math.floor(positionMs / 1000);
    if (second !== this.lastSecond) {
      this.lastSecond = second;
      this.el.timeNow.textContent = formatTime(positionMs);
    }
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
