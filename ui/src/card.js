/**
 * DOM rendering for the card. Pure-ish: takes state, writes to elements that are
 * looked up once. All per-frame work goes through `tick()`.
 */

import { formatTime } from './clock.js';
import { css, paletteFor } from './palette.js';

const $ = (id) => document.getElementById(id);

export class CardView {
  constructor() {
    this.el = {
      card: $('card'),
      glow: $('glow'),
      cover: $('cover'),
      title: $('title'),
      artist: $('artist'),
      fill: $('progress-fill'),
      timeNow: $('time-now'),
      timeTotal: $('time-total'),
      palette: $('palette'),
      status: $('status-text'),
      flip: $('flip'),
    };

    this.currentCoverUrl = null;
    this.currentSongKey = null;
    this.swatches = [];
    this.lastFraction = -1;
    this.lastSecond = -1;
  }

  /* ------------------------------------------------------------- connection */

  setConnection(info) {
    const connected = info.state === 'ready';
    this.el.card.dataset.connected = String(connected);
    this.el.status.textContent = info.detail || info.state;
  }

  /* -------------------------------------------------------------- playback */

  /**
   * Apply a snapshot. Returns true when the track itself changed, so the caller can
   * reset per-track state.
   */
  setSnapshot(snapshot) {
    const song = snapshot.song;
    const songKey = song ? `${song.id ?? ''}|${song.name}` : null;
    const trackChanged = songKey !== this.currentSongKey;
    this.currentSongKey = songKey;

    this.el.title.textContent = song?.name?.trim() || '未检测到播放';
    this.el.artist.textContent = song?.artists?.length
      ? song.artists.map((a) => a.name).join(' / ')
      : '等待网易云音乐';

    const status = snapshot.playback?.status ?? 'unknown';
    this.el.card.dataset.status = status;
    this.el.timeTotal.textContent = formatTime(song?.durationMs ?? 0);

    if (trackChanged) {
      this.applyCover(song?.coverUrl ?? null);
    }

    return trackChanged;
  }

  /* ----------------------------------------------------------------- cover */

  applyCover(url) {
    if (url === this.currentCoverUrl) return;
    this.currentCoverUrl = url;

    if (!url) {
      this.el.cover.classList.remove('is-loaded');
      this.el.cover.removeAttribute('src');
      this.applyPalette(null);
      return;
    }

    // The palette is extracted from the same image; do both off one load.
    void paletteFor(url).then((palette) => {
      // Guard against a slower response for a cover we already moved past.
      if (this.currentCoverUrl !== url) return;
      this.applyPalette(palette);
    });

    this.el.cover.onload = () => this.el.cover.classList.add('is-loaded');
    this.el.cover.onerror = () => this.el.cover.classList.remove('is-loaded');
    this.el.cover.src = url;
  }

  /* --------------------------------------------------------------- palette */

  applyPalette(palette) {
    const root = document.documentElement;
    if (!palette) {
      root.removeAttribute('data-scheme');
      this.el.palette.replaceChildren();
      this.swatches = [];
      return;
    }

    root.dataset.scheme = palette.scheme;
    root.style.setProperty('--accent-dominant', css(palette.dominant));
    root.style.setProperty('--accent-top', css(palette.glowTop));
    root.style.setProperty('--accent-bottom', css(palette.glowBottom));
    root.style.setProperty('--accent-soft', css(palette.dominant, 0.22));

    this.swatches = palette.colors;
    const fragment = document.createDocumentFragment();
    for (const color of palette.colors) {
      const swatch = document.createElement('span');
      swatch.style.background = css(color);
      fragment.append(swatch);
    }
    this.el.palette.replaceChildren(fragment);
  }

  /* ------------------------------------------------------------------ tick */

  /** Per-frame update; only touches what changed. */
  tick(positionMs, fraction) {
    if (fraction !== this.lastFraction) {
      this.lastFraction = fraction;
      // Width is the cheap option here and the element is a single small bar.
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
