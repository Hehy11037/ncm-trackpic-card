/**
 * Lyrics page.
 *
 * Structure: seven *entries* per page, where an entry is either the artist line or one
 * lyric line. The current entry is centred; the rest recede in opacity, blur, scale and Z
 * depth and disappear past a hard limit.
 *
 * Why entries are one line each: an earlier version attached the translation as a sub-line
 * under every lyric, so entries had two possible heights. Centring then drifted and long
 * entries overlapped. Here the translation is shown only on the current entry (which is
 * centred anyway), so every entry is one line of text and the geometry stays predictable.
 *
 * Details that took a few attempts and are worth keeping:
 *
 *  - The stack is anchored to the container's top edge (`top: 0` in CSS), so centring is
 *    the direct relation `offset = containerHeight/2 - (activeTop + activeHeight/2)`.
 *    Mixing that with `offsetTop` relative to a centred stack displaced everything off
 *    screen.
 *  - Each entry gets a small, stable `--stagger` delay. The stack moves as one block but
 *    the entries settle a few milliseconds apart, which reads as motion rather than a
 *    rigid sheet sliding.
 *  - `--d-max` bounds the depth: past it, entries are fully transparent and hidden. Without
 *    a bound, a very long entry several rows away still contributed a visible smudge.
 *  - The current entry's type is curved slightly per character, for the "noticeably nearer"
 *    feel. Wrapped text would break that, which is why entries are nowrap.
 */

/** Entries per page, including the current one. Odd, so the current entry can centre. */
const ENTRIES_PER_PAGE = 7;
/** Entries farther than this are hidden outright. */
const MAX_DISTANCE = Math.floor(ENTRIES_PER_PAGE / 2);
/** Depth at which an entry has faded out completely. */
const DEPTH_LIMIT = 3.4;

export class LyricsView {
  /** @param {HTMLElement} container */
  constructor(container) {
    this.container = container;
    this.stack = document.createElement('div');
    this.stack.className = 'lyrics-stack';
    container.append(this.stack);
    this.empty = container.querySelector('.lyrics-empty');

    /** @type {HTMLElement[]} */
    this.nodes = [];
    /** @type {{startMs:number}[]} */
    this.lines = [];
    this.activeIndex = -1;
    this.scrollCurrent = 0;
    this.scrollTarget = 0;
    this.songId = null;
    /** Leading nodes that are not lyric lines (the title/artist header). */
    this.headerCount = 0;
    /** Show translations on the current entry. */
    this.showTranslation = true;
  }

  /** Toggle translations (kept as an option rather than always on). */
  setTranslationVisible(visible) {
    this.showTranslation = visible;
    document.documentElement.dataset.lyricTranslation = visible ? 'on' : 'off';
  }

  /**
   * Apply the track's palette.
   *
   * Each depth step gets its own colour from the ramp, ordered by luminance so the current
   * entry takes the darkest (most legible) swatch and the rows around it lighten outward.
   * That makes the depth read as a single colour family rather than uniform grey.
   */
  setPalette(colors) {
    if (!Array.isArray(colors) || !colors.length) return;
    const ramp = [...colors]
      .map((c) => ({ c, luma: 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b }))
      .sort((a, b) => a.luma - b.luma)
      .map((entry) => entry.c);

    const root = document.documentElement;
    root.style.setProperty('--lyric-0', `rgb(${ramp[0].r}, ${ramp[0].g}, ${ramp[0].b})`);
    for (let i = 1; i < 4; i++) {
      const swatch = ramp[Math.min(i, ramp.length - 1)];
      root.style.setProperty(`--lyric-${i}`, `rgb(${swatch.r}, ${swatch.g}, ${swatch.b})`);
    }
  }

  /**
   * Record the current track's title and artist, used as the leading header entry so the
   * start of a track always has a current entry to centre on.
   */
  setSongInfo(title, artist) {
    const nextTitle = title ?? '';
    const nextArtist = artist ?? '';
    if (nextTitle === this.songTitle && nextArtist === this.songArtist) return;

    this.songTitle = nextTitle;
    this.songArtist = nextArtist;
    const header = this.nodes[0];
    const label = header?.querySelector('.text');
    if (label) label.textContent = [this.songTitle, this.songArtist].filter(Boolean).join(' — ');
  }

  /** Replace the document. Cheap when the same song is re-sent unchanged. */
  setDocument(doc) {
    const sameSong = this.songId === doc.songId;
    this.songId = doc.songId;

    if (sameSong && this.nodes.length === doc.lines.length + this.headerCount && this.#sameTimings(doc)) {
      return;
    }

    this.lines = doc.lines;
    this.activeIndex = -1;
    this.nodes = [];
    this.headerCount = 0;
    this.stack.replaceChildren();

    if (this.empty) {
      const isEmpty = !doc.lines.length;
      this.empty.style.display = isEmpty ? '' : 'none';
      if (isEmpty) this.empty.textContent = doc.instrumental ? '纯音乐，请欣赏' : '暂无歌词';
    }

    const fragment = document.createDocumentFragment();
    const build = (text, translation, className) => {
      const node = document.createElement('div');
      node.className = `lyric-line is-offscreen${className ? ` ${className}` : ''}`;
      // A stable per-entry delay; assigned once so scrolling does not reshuffle it.
      node.style.setProperty('--stagger', `${(this.nodes.length % 5) * 22}ms`);

      const label = document.createElement('span');
      label.className = 'text';
      label.textContent = text;
      node.append(label);

      if (translation) {
        const sub = document.createElement('span');
        sub.className = 'translation';
        sub.textContent = translation;
        node.append(sub);
      }

      fragment.append(node);
      this.nodes.push(node);
    };

    if (this.songTitle) {
      build([this.songTitle, this.songArtist].filter(Boolean).join(' — '), null, 'lyric-line--header');
      this.headerCount = 1;
    }
    for (const line of doc.lines) build(line.text, line.translation, null);

    this.stack.replaceChildren(fragment);

    // Re-apply depth once layout is measurable.
    requestAnimationFrame(() => {
      const current = this.activeIndex;
      this.activeIndex = -1;
      this.#setActive(current);
    });
  }

  #sameTimings(doc) {
    if (!this.lines.length || !doc.lines.length) return this.lines.length === doc.lines.length;
    return (
      this.lines[0]?.startMs === doc.lines[0]?.startMs &&
      this.lines[this.lines.length - 1]?.startMs === doc.lines[doc.lines.length - 1]?.startMs
    );
  }

  /** Index of the lyric containing `positionMs`, or -1 before the first line. */
  indexAt(positionMs) {
    const lines = this.lines;
    if (!lines.length) return -1;
    let low = 0;
    let high = lines.length - 1;
    let found = -1;
    while (low <= high) {
      const mid = (low + high) >> 1;
      if (lines[mid].startMs <= positionMs) {
        found = mid;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }
    return found;
  }

  /**
   * Per-frame update.
   * @param {number} positionMs current playback position
   * @param {number} dtMs elapsed since the previous frame
   * @param {boolean} animate whether to ease the scroll (false while hidden)
   */
  tick(positionMs, dtMs, animate = true) {
    const lyricIndex = this.indexAt(positionMs);
    // Node index = header offset + lyric index. Before the first line, the header is
    // current, which stops the page looking uniform at the start of a track.
    const nodeIndex = lyricIndex < 0 ? 0 : lyricIndex + this.headerCount;
    if (nodeIndex !== this.activeIndex) this.#setActive(nodeIndex);
    this.#centreOn(nodeIndex, dtMs, animate);
  }

  #setActive(index) {
    this.activeIndex = index;

    for (let i = 0; i < this.nodes.length; i++) {
      const node = this.nodes[i];
      if (!node) continue;
      const distance = index < 0 ? i + 1 : i - index;

      let depth;
      if (i === index) depth = 0;
      else if (distance < 0) depth = Math.abs(distance) + 0.55; // above recedes faster
      else depth = distance + 0.15;

      node.style.setProperty('--d', Math.min(depth, DEPTH_LIMIT).toFixed(2));
      node.classList.toggle('is-active', i === index);
      node.classList.toggle('is-offscreen', Math.abs(distance) > MAX_DISTANCE);
      // Bucketed depth drives the per-depth palette colour in CSS.
      node.dataset.depth = String(Math.min(Math.round(Math.abs(depth)), 3));
    }
  }

  /**
   * Centre the current entry by translating the stack.
   *
   * Measured per entry rather than `index * lineHeight`, because heights differ (the
   * current entry shows a translation). An earlier version also mixed coordinate systems
   * and displaced everything off screen - see tools/check-lyric-centring.mjs.
   */
  #centreOn(index, dtMs, animate) {
    let target = 0;

    const active = index >= 0 ? this.nodes[index] : null;
    const containerHeight = this.container.clientHeight || 0;
    if (active && containerHeight) {
      target = containerHeight / 2 - (active.offsetTop + active.offsetHeight / 2);
    }

    this.scrollTarget = target;

    if (!animate) {
      this.scrollCurrent = target;
    } else if (this.scrollCurrent !== target) {
      const k = 1 - Math.exp(-dtMs / 90);
      this.scrollCurrent += (target - this.scrollCurrent) * k;
      if (Math.abs(target - this.scrollCurrent) < 0.4) this.scrollCurrent = target;
    }

    this.stack.style.transform = `translate3d(0, ${this.scrollCurrent.toFixed(2)}px, 0)`;
  }
}
