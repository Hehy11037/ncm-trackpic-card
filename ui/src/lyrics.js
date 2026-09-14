/**
 * Lyrics page.
 *
 * Design, from review feedback:
 *  - The current line sits in the *middle* of the card, not at the bottom.
 *  - Seven lines per page. The document is never stacked into one masked strip, because
 *    that made the text too small to read.
 *  - The current line is the largest, darkest and sharpest; lines above and below recede
 *    steeply (much smaller, lighter, blurred) for a strong near-large/far-small effect.
 *  - Type is larger than the front face's song title.
 *
 * Two details that caused visible bugs before:
 *
 *  1. Lines are **not** uniform height: a line with a translation is taller, and long
 *     lines wrap to two rows. Centring by `index * lineHeight` therefore drifted and
 *     overlapped, so each line's measured offset is used instead.
 *  2. Before the first lyric starts there is no current line. Treating that as "distance
 *     0 for every line" made the whole page uniform (the reported "all lines the same
 *     colour" at the beginning of a track). The document now also gets a leading
 *     "曲名 / 艺术家" entry so there is always a current line to centre on.
 *
 * No karaoke sweep: the client only provides line-level timings (its yrcInfo is empty on
 * every track measured), so a per-word fill would be invented rather than measured.
 */

/** Lines per page, including the current one. Odd, so the current line can centre. */
const VISIBLE_LINES = 7;
/** Lines farther than this are hidden rather than blurred into mush. */
const MAX_DISTANCE = Math.floor(VISIBLE_LINES / 2);
/** How much further each step away recedes. Larger = stronger depth. */
const RECEDE_ABOVE = 0.55;
const RECEDE_BELOW = 0.15;

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
    /** Used for the leading header line, so the start of a track is never uniform. */
    this.songTitle = '';
    this.songArtist = '';
  }

  /**
   * Record the current track's title and artist.
   *
   * The header line is rebuilt in place rather than by reloading the document, so a
   * metadata update never interrupts the lyric scroll. Returns true when the caller should
   * reload the document (the song changed while a document was already loaded).
   */
  setSongInfo(title, artist) {
    if (title === this.songTitle && artist === this.songArtist) return false;
    this.songTitle = title ?? '';
    this.songArtist = artist ?? '';
    // The header node exists only when a document has been rendered.
    const header = this.nodes[0];
    if (header?.classList.contains('lyric-line--header')) {
      const label = header.querySelector('.text');
      if (label) label.textContent = [this.songTitle, this.songArtist].filter(Boolean).join('\n');
    }
    return false;
  }

  /** Replace the document. Cheap when the same song is re-sent unchanged. */
  setDocument(doc) {
    const sameSong = this.songId === doc.songId;
    this.songId = doc.songId;

    if (sameSong && this.nodes.length === doc.lines.length && this.#sameTimings(doc)) return;

    this.lines = doc.lines;
    this.activeIndex = -1;
    this.nodes = [];
    /** Number of leading nodes that are not lyric lines (the title/artist header). */
    this.headerCount = 0;
    this.stack.replaceChildren();

    if (this.empty) {
      const isEmpty = !doc.lines.length;
      this.empty.style.display = isEmpty ? '' : 'none';
      if (isEmpty) this.empty.textContent = doc.instrumental ? '纯音乐，请欣赏' : '暂无歌词';
    }

    /*
     * A leading "title / artist" line.
     *
     * Before the first lyric starts there is no current line, and treating every line as
     * distance 0 made the whole page uniform (the reported "all lyrics the same colour at
     * the beginning"). Giving the document a first entry means there is always a current
     * line to centre on: the header sits in the middle, the first lyrics recede below it,
     * and when the singing starts it scrolls away naturally.
     */
    const headerItems = [];
    if (doc.songTitle) {
      headerItems.push(doc.songTitle);
      if (doc.songArtist) headerItems.push(doc.songArtist);
    }

    const fragment = document.createDocumentFragment();
    const build = (text, translation, className) => {
      const node = document.createElement('div');
      node.className = `lyric-line is-offscreen${className ? ` ${className}` : ''}`;

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

    if (headerItems.length) {
      build(headerItems.join('\n'), null, 'lyric-line--header');
      this.headerCount = 1;
    }
    for (const line of doc.lines) build(line.text, line.translation, null);

    this.stack.replaceChildren(fragment);

    // Re-apply the depth classes once layout is measurable.
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
    const lyricIndex = this.indexAt(positionMs);
    // Node index = header offset + lyric index; -1 (before the first line) means the
    // header is current, which is what keeps the page from looking uniform at the start.
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

      // Lines above the current one recede faster than lines below it; that asymmetry is
      // what makes the stack read as receding into the distance rather than as a list.
      const depth = distance < 0 ? Math.abs(distance) + RECEDE_ABOVE : distance + RECEDE_BELOW;
      node.style.setProperty('--d', Math.max(0, depth).toFixed(2));
      node.classList.toggle('is-active', i === index);
      node.classList.toggle('is-offscreen', Math.abs(distance) > MAX_DISTANCE);
    }
  }

  /**
   * Centre the current line by translating the stack.
   *
   * Uses each line's measured offset rather than `index * lineHeight`, because a line with
   * a translation is taller and a long line may wrap - uniform arithmetic drifted and made
   * adjacent lines overlap.
   */
  #centreOn(index, dtMs, animate) {
    let target = 0;

    const active = index >= 0 ? this.nodes[index] : null;
    if (active) {
      const containerHeight = this.container.clientHeight || 0;
      const activeTop = active.offsetTop;
      const activeHeight = active.offsetHeight;
      if (containerHeight && activeHeight) {
        // Stack centre is already at the container's middle, so shift by the active
        // line's own centre relative to the stack's midpoint.
        const stackCentre = this.stack.offsetHeight / 2;
        target = -(activeTop + activeHeight / 2 - stackCentre);
      }
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

