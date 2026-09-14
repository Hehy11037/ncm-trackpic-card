/**
 * Lyrics page.
 *
 * Design, from review feedback:
 *  - The current line sits in the *middle* of the card, not at the bottom.
 *  - Seven lines per page. The document is never stacked into one masked strip, because
 *    that made the text too small to read.
 *  - The current line is the largest, darkest and sharpest; lines above and below
 *    recede (smaller, lighter, blurred) for a near-large/far-small effect.
 *  - Type is at least as large as the front face's song title.
 *
 * Implementation: all lines are built once per document, and `#setActive` gives each one
 * a `--d` value for its distance from the active line. CSS turns `--d` into opacity,
 * blur, scale and a Z translation inside a perspective. Lines beyond the visible window
 * are hidden, so a 1000-line document costs nothing per frame.
 *
 * No karaoke sweep: the client only provides line-level timings (its yrcInfo is empty
 * on every track measured), so a per-word fill would be invented rather than measured.
 */

/** Lines per page, including the current one. Odd, so the current line can centre. */
const VISIBLE_LINES = 7;
/** Lines farther than this are hidden rather than blurred into mush. */
const MAX_DISTANCE = Math.floor(VISIBLE_LINES / 2);

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
    this.lineHeight = 0;
    this.songId = null;
  }

  /** Replace the document. Cheap when the same song is re-sent unchanged. */
  setDocument(doc) {
    const sameSong = this.songId === doc.songId;
    this.songId = doc.songId;

    if (sameSong && this.nodes.length === doc.lines.length && this.#sameTimings(doc)) return;

    this.lines = doc.lines;
    this.activeIndex = -1;
    this.nodes = [];
    this.stack.replaceChildren();

    if (this.empty) {
      const isEmpty = !doc.lines.length;
      this.empty.style.display = isEmpty ? '' : 'none';
      if (isEmpty) this.empty.textContent = doc.instrumental ? '纯音乐，请欣赏' : '暂无歌词';
    }

    const fragment = document.createDocumentFragment();
    doc.lines.forEach((line) => {
      const node = document.createElement('div');
      node.className = 'lyric-line is-offscreen';

      const text = document.createElement('span');
      text.className = 'text';
      text.textContent = line.text;
      node.append(text);

      if (line.translation) {
        const translation = document.createElement('span');
        translation.className = 'translation';
        translation.textContent = line.translation;
        node.append(translation);
      }

      fragment.append(node);
      this.nodes.push(node);
    });

    this.stack.replaceChildren(fragment);

    // Measure after layout so the centring maths is exact.
    requestAnimationFrame(() => {
      this.lineHeight = this.nodes[0]?.offsetHeight ?? 0;
      // Force a re-application of the depth classes for the measured layout.
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

  /** Index of the line containing `positionMs`, or -1 before the first line. */
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
    const index = this.indexAt(positionMs);
    if (index !== this.activeIndex) this.#setActive(index);
    this.#centreOn(index, dtMs, animate);
  }

  #setActive(index) {
    this.activeIndex = index;

    for (let i = 0; i < this.nodes.length; i++) {
      const node = this.nodes[i];
      if (!node) continue;
      const distance = index < 0 ? 0 : i - index;
      const magnitude = Math.abs(distance);

      /*
       * Lines after the current one are closer together than lines before it, so the
       * upward direction recedes faster - that is what sells the depth.
       */
      const depth = distance < 0 ? magnitude + 0.4 : magnitude;
      node.style.setProperty('--d', depth.toFixed(2));
      node.classList.toggle('is-active', i === index);
      node.classList.toggle('is-offscreen', magnitude > MAX_DISTANCE);
    }
  }

  /** Keep the active line vertically centred by translating the whole stack. */
  #centreOn(index, dtMs, animate) {
    const lineHeight = this.lineHeight || this.nodes[0]?.offsetHeight || 0;

    // The stack's origin is the container's vertical centre, so shifting by the active
    // line's own offset puts that line in the middle.
    const target = index < 0 || !lineHeight ? 0 : -(index * lineHeight) - lineHeight / 2;
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
