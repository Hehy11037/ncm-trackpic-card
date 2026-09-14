/**
 * Scrolling lyrics with a karaoke sweep.
 *
 * Rendering strategy:
 *  - Lines are built once per document and never re-created while scrolling.
 *  - The stack moves with a single `transform: translate3d`, so scrolling is one
 *    composited property rather than a layout change.
 *  - The active line's sweep is driven by a `--p` custom property (0..1) that the
 *    render loop writes each frame. With word timings the sweep follows the words;
 *    without them it sweeps the line, which is the best LRC can do.
 *  - Only lines near the viewport are kept visible; the rest are hidden so a
 *    1000-line document does not cost anything per frame.
 */

const LINE_HEIGHT_GUESS = 34;
const ACTIVE_OFFSET_RATIO = 0.42;

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
    /** @type {{startMs:number,endMs:number,words:any[]}[]} */
    this.lines = [];
    this.activeIndex = -1;
    this.scrollTarget = 0;
    this.scrollCurrent = 0;
    this.showTranslation = true;
    this.hasWordTiming = false;
    this.songId = null;
  }

  /** Replace the document. Cheap for the common case of the same song re-sent. */
  setDocument(doc) {
    const sameSong = this.songId === doc.songId;
    const sameShape = sameSong && this.lines.length === doc.lines.length;
    this.songId = doc.songId;
    this.hasWordTiming = doc.hasWordTiming;

    if (sameShape && this.#sameTimings(doc)) return;

    this.lines = doc.lines;
    this.activeIndex = -1;
    this.stack.replaceChildren();
    this.nodes = [];

    if (this.empty) {
      if (!doc.lines.length) {
        this.empty.textContent = doc.instrumental ? '纯音乐，请欣赏' : '暂无歌词';
        this.empty.style.display = '';
      } else {
        this.empty.style.display = 'none';
      }
    }

    const fragment = document.createDocumentFragment();
    doc.lines.forEach((line, index) => {
      const node = document.createElement('div');
      node.className = 'lyric-line';
      node.dataset.index = String(index);

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
    if (!this.lines.length) return false;
    return (
      this.lines[0]?.startMs === doc.lines[0]?.startMs &&
      this.lines[this.lines.length - 1]?.startMs === doc.lines[doc.lines.length - 1]?.startMs
    );
  }

  /** Index of the line containing `positionMs`. */
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
    if (index !== this.activeIndex) {
      this.#setActive(index);
    }

    // Karaoke progress for the active line.
    if (index >= 0) {
      const line = this.lines[index];
      const node = this.nodes[index];
      if (node) {
        const p = sweepProgress(line, positionMs);
        node.style.setProperty('--p', p.toFixed(4));
      }
    }

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
      // Keep far-away lines out of the compositor.
      const distance = index < 0 ? 0 : Math.abs(i - index);
      node.style.visibility = distance > 12 ? 'hidden' : '';
    }
    if (index >= 0 && this.nodes[index]) {
      this.nodes[index].classList.add('is-active');
    }
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
      // Critically-damped-ish easing that settles in ~250ms.
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
      if (!translation) continue;
      translation.style.display = visible ? '' : 'none';
    }
  }
}

/**
 * Sweep progress within a line, 0..1.
 *
 * With word timings we interpolate inside the word that contains the position,
 * which is what makes per-character karaoke look right. Without them we sweep the
 * whole line by its duration.
 */
function sweepProgress(line, positionMs) {
  const start = line.startMs;
  const end = Math.max(line.endMs ?? start + 1, start + 1);

  if (Array.isArray(line.words) && line.words.length) {
    const words = line.words;
    const last = words[words.length - 1];
    const total = Math.max((last.startMs + last.durationMs) - start, 1);
    if (positionMs <= start) return 0;
    if (positionMs >= last.startMs + last.durationMs) return 1;

    for (let i = 0; i < words.length; i++) {
      const word = words[i];
      const wordStart = word.startMs;
      const wordEnd = wordStart + word.durationMs;
      if (positionMs < wordStart) {
        // Between words: hold at the previous boundary.
        const previous = words[i - 1];
        const previousEnd = previous ? previous.startMs + previous.durationMs : start;
        return clamp01((previousEnd - start) / total);
      }
      if (positionMs <= wordEnd) {
        const within = word.durationMs > 0 ? (positionMs - wordStart) / word.durationMs : 1;
        return clamp01((wordStart - start + within * word.durationMs) / total);
      }
    }
    return 1;
  }

  return clamp01((positionMs - start) / (end - start));
}

function clamp01(value) {
  if (!Number.isFinite(value)) return 0;
  return value < 0 ? 0 : value > 1 ? 1 : value;
}
