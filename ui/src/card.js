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
      status: $('status-text'),
      flip: $('flip'),
      credit: $('credit'),
    };

    this.onBackgroundChange = options.onBackgroundChange ?? (() => {});
    this.currentCoverUrl = null;
    this.currentSongKey = null;
    /** @type {{r:number,g:number,b:number}[]} */
    this.palette = REFERENCE_PALETTE;
    /** 'glass' or a palette index. */
    this.backgroundChoice = loadBackgroundChoice();

    this.lastFraction = -1;
    this.lastSecond = -1;

    this.renderSwatches();
    this.applyBackground();

    window.addEventListener('resize', () => {
      applyLayoutUnit();
    });
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

    this.el.title.textContent = song?.name?.trim() || '未检测到播放';
    this.el.artist.textContent = song?.artists?.length
      ? song.artists.map((a) => a.name).join(' / ')
      : '等待网易云音乐';

    this.el.card.dataset.status = snapshot.playback?.status ?? 'unknown';
    this.el.timeTotal.textContent = formatTime(song?.durationMs ?? 0);

    if (trackChanged) this.applyCover(song?.coverUrl ?? null);
    return trackChanged;
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
    this.renderSwatches();
    this.applyBackground();

    // Accent colours drive the glow and the primary button.
    const root = document.documentElement;
    const sorted = [...this.palette].sort((a, b) => (a.r + a.g + a.b) - (b.r + b.g + b.b));
    root.style.setProperty('--accent-top', css(sorted[sorted.length - 1]));
    root.style.setProperty('--accent-bottom', css(sorted[0]));
    root.style.setProperty('--accent-dominant', css(this.palette[0]));
    root.style.setProperty('--accent-soft', css(this.palette[0], 0.24));
  }

  /**
   * Build the swatch strip. Five palette colours plus nothing else: the glass option
   * is "no swatch selected", which keeps the row short and matches the reference,
   * where the palette is exactly five colours.
   */
  renderSwatches() {
    const fragment = document.createDocumentFragment();
    this.palette.forEach((color, index) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'swatch';
      button.style.background = css(color);
      button.title = `背景色 ${index + 1}（再次点击回到毛玻璃）`;
      const active = this.backgroundChoice === index;
      button.setAttribute('aria-pressed', String(active));
      button.addEventListener('click', () => {
        // Tapping the active swatch toggles back to frosted glass.
        this.setBackground(this.backgroundChoice === index ? 'glass' : index);
      });
      fragment.append(button);
    });
    this.el.palette.replaceChildren(fragment);
  }

  setBackground(choice) {
    this.backgroundChoice = choice;
    saveBackgroundChoice(choice);
    this.renderSwatches();
    this.applyBackground();
    this.onBackgroundChange(choice);
  }

  /** Paint the card and pick a text scheme that actually contrasts with it. */
  applyBackground() {
    const root = document.documentElement;
    const color = this.backgroundChoice === 'glass' ? null : this.palette[this.backgroundChoice] ?? null;

    this.el.card.dataset.bg = color ? 'palette' : 'glass';
    root.style.setProperty('--bg', color ? css(color) : 'transparent');

    const { scheme, scrim, contrast } = schemeFor(color);
    root.dataset.scheme = scheme;
    root.style.setProperty('--scrim', scrim);

    // Exposed for the devtools console; handy when tuning palette choices.
    root.dataset.bgContrast = contrast ? contrast.toFixed(2) : '';
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
