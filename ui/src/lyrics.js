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
/** Depth at which an entry has faded out completely. Keep in sync with --d-max in CSS. */
const DEPTH_LIMIT = 3.6;

/**
 * Identity of a lyric document.
 *
 * The view rebuilds only when this changes. It must include the song id: the earlier guard
 * compared node counts and timings only and never stored the incoming id, so a new track
 * whose lyrics had the same line count was treated as "already rendered" and the previous
 * track's lyrics stayed on screen.
 *
 * Exported so `ui/test/lyrics.test.mjs` can verify it directly instead of relying on a
 * browser.
 */
export function documentSignature(doc) {
  if (!doc) return 'none';
  const lines = doc.lines ?? [];
  const first = lines[0]?.startMs ?? 'x';
  const last = lines[lines.length - 1]?.startMs ?? 'x';
  return `${doc.songId ?? 'null'}|${lines.length}|${first}|${last}`;
}

/** WCAG relative luminance, 0..1. */
function relativeLuminance({ r, g, b }) {
  const channel = (value) => {
    const v = value / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** WCAG contrast ratio between two luminances, 1..21. */
function contrastRatio(a, b) {
  const high = Math.max(a, b);
  const low = Math.min(a, b);
  return (high + 0.05) / (low + 0.05);
}

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
    /** Signature of what is currently rendered, so a rebuild only happens when needed. */
    this.renderedSignature = null;
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
   * Apply the track's palette to the lyric text.
   *
   * Colours are chosen by **contrast against the current background**, not by luminance
   * order. Ordering by luminance and using the darkest swatch made the text vanish whenever
   * the chosen background was itself dark: the "most legible" swatch was the one closest to
   * the background. So the palette is sorted by contrast ratio against the background, the
   * highest-contrast colour is used for the current entry, and each subsequent depth step
   * takes the next best contrast.
   *
   * @param {{r:number,g:number,b:number}[]} colors palette from the cover
   * @param {{r:number,g:number,b:number}} [background] the colour currently painted behind
   */
  setPalette(colors, background) {
    if (!Array.isArray(colors) || !colors.length) return;

    const backgroundRgb = background ?? colors[0];
    const bgLuma = relativeLuminance(backgroundRgb);

    // Highest contrast first, so depth 0 gets the most readable colour.
    const ranked = [...colors]
      .map((color) => ({ color, ratio: contrastRatio(bgLuma, relativeLuminance(color)) }))
      .sort((a, b) => b.ratio - a.ratio)
      .map((entry) => entry.color);

    const root = document.documentElement;
    for (let i = 0; i < 4; i++) {
      const swatch = ranked[Math.min(i, ranked.length - 1)];
      const ratio = contrastRatio(bgLuma, relativeLuminance(swatch));
      /*
       * If even the best swatch is weak against this background (a mid-tone cover can
       * produce no usable light or dark colour), fall back to plain white or near-black,
       * which is what the text-scheme decision already uses elsewhere.
       */
      const usable = ratio >= 3;
      const rgb = usable ? swatch : bgLuma < 0.42 ? { r: 237, g: 241, b: 243 } : { r: 28, g: 32, b: 36 };
      root.style.setProperty(`--lyric-${i}`, `rgb(${rgb.r}, ${rgb.g}, ${rgb.b})`);
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

  /**
   * Show a placeholder instead of lyrics.
   *
   * Clears the document so a previous track's lines can never linger, and hides the
   * title/artist header - with no lyrics the header would overlap the placeholder, which is
   * what produced a large "title - artist" line sitting on top of "暂无歌词".
   */
  clear(message) {
    this.songId = null;
    this.lines = [];
    this.nodes = [];
    this.headerCount = 0;
    this.activeIndex = -1;
    this.stack.replaceChildren();
    this.#setEmpty(message);
  }

  #setEmpty(message) {
    if (!this.empty) return;
    const text = message?.trim();
    if (text) {
      this.empty.textContent = text;
      this.empty.style.display = '';
    } else {
      this.empty.style.display = 'none';
    }
  }

  /** Replace the document. Rebuilt whenever the song or the line set changes. */
  setDocument(doc) {
    const songId = doc.songId ?? null;

    /*
     * Rebuild when the song changes, or when its lines change.
     *
     * The previous guard compared only the *count* of nodes and the timings, and never
     * stored the incoming song id. A new track whose lyrics happened to have the same line
     * count was therefore treated as "already rendered" and the previous track's lyrics
     * stayed on screen.
     */
    const signature = documentSignature(doc);
    if (signature === this.renderedSignature) return;

    this.songId = songId;
    this.renderedSignature = signature;
    this.lines = doc.lines;
    this.activeIndex = -1;
    this.nodes = [];
    this.headerCount = 0;
    this.stack.replaceChildren();

    if (!doc.lines.length) {
      // No lyrics: show the placeholder alone. No header entry, or the two overlap.
      this.#setEmpty(doc.instrumental ? '纯音乐，请欣赏' : '暂无歌词');
      return;
    }
    this.#setEmpty(null);

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
