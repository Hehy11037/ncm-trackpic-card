/**
 * Scrolling lyrics.
 *
 * Deliberately simple: no karaoke sweep. The active line is highlighted and the
 * stack scrolls to keep it in view; that is the whole effect. Line-level timing is
 * what the client actually provides (its yrcInfo is empty on every track measured),
 * so a per-word sweep would mostly be faked from line times.
 *
 * Rendering strategy:
 *  - Lines are built once per document and never re-created while scrolling.
 *  - The stack moves with a single `transform: translate3d`, so scrolling is one
 *    composited property rather than a layout change.
 *  - Only lines near the viewport stay visible; a 1000-line document costs nothing
 *    per frame.
 */

const LINE_HEIGHT_GUESS = 34;
/** Where the active line sits in the box, 0 = top, 1 = bottom. */
const ACTIVE_OFFSET_RATIO = 0.46;

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
    /** @type {{startMs:number,endMs:number}[]} */
    this.lines = [];
    this.activeIndex = -1;
    this.scrollTarget = 0;
    this.scrollCurrent = 0;
    this.showTranslation = true;
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
      const empty = !doc.lines.length;
      this.empty.style.display = empty ? '' : 'none';
      if (empty) this.empty.textContent = doc.instrumental ? '纯音乐，请欣赏' : '暂无歌词';
    }

    const fragment = document.createDocumentFragment();
    doc.lines.forEach((line) => {
      const node = document.createElement('div');
      node.className = 'lyric-line';

      const text = document.createElement('span');
      text.className = 'text';
      text.textContent = line.text;
      node.append(text);

      if (this.showTranslation && line.translation) {
        const translation = document.createElement('span');
        translation.className = 'translation';
        translation.textContent = line.translation;
        node.append(translation);
      }

      fragment.append(node);
      this.nodes.push(node);
    });
    this.stack.replaceChildren(fragment);
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
   * @param {boolean} animate whether to ease the scroll (false when hidden)
   */
  tick(positionMs, dtMs, animate = true) {
    const index = this.indexAt(positionMs);
    if (index !== this.activeIndex) this.#setActive(index);
    this.#scrollTo(index, dtMs, animate);
  }

  #setActive(index) {
    const previous = this.activeIndex;
    this.activeIndex = index;

    if (previous >= 0 && this.nodes[previous]) {
      this.nodes[previous].classList.remove('is-active');
    }
    for (let i = 0; i < this.nodes.length; i++) {
      const node = this.nodes[i];
      if (!node) continue;
      node.classList.toggle('is-past', i < index);
      node.classList.toggle('is-active', i === index);
      const distance = index < 0 ? 0 : Math.abs(i - index);
      node.style.visibility = distance > 14 ? 'hidden' : '';
    }
    this.nodes[index]?.classList.add('is-active');
  }

  #scrollTo(index, dtMs, animate) {
    const height = this.container.clientHeight || 1;
    const lineHeight = this.nodes[0]?.offsetHeight || LINE_HEIGHT_GUESS;
    const anchor = height * ACTIVE_OFFSET_RATIO;
    const target = index < 0 ? 0 : anchor - index * lineHeight - lineHeight / 2;

    this.scrollTarget = target;

    if (!animate) {
      this.scrollCurrent = target;
    } else if (this.scrollCurrent !== target) {
      const k = 1 - Math.exp(-dtMs / 70);
      this.scrollCurrent += (target - this.scrollCurrent) * k;
      if (Math.abs(target - this.scrollCurrent) < 0.4) this.scrollCurrent = target;
    }

    this.stack.style.transform = `translate3d(0, ${this.scrollCurrent.toFixed(2)}px, 0)`;
  }

  setTranslationVisible(visible) {
    this.showTranslation = visible;
    for (const node of this.nodes) {
      const translation = node.querySelector('.translation');
      if (translation) translation.style.display = visible ? '' : 'none';
    }
  }
}
