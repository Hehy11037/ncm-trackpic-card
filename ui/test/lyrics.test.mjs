// Unit tests for the lyrics view's rebuild logic.
//
//   node ui/test/lyrics.test.mjs
//
// Regression cover for two bugs that both reached the user:
//
//   1. A new track whose lyrics had the same line count as the previous track was treated as
//      "already rendered", so the previous track's lyrics stayed on screen.
//   2. With no lyrics, the title/artist header entry rendered on top of the "暂无歌词"
//      placeholder.
//
// `documentSignature` is a pure function precisely so both are checkable without a browser.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { documentSignature } from '../src/lyrics.js';

/** Build a document whose lines all share one start time, for compact fixtures. */
const doc = (songId, count, start = 0) => ({
  songId,
  instrumental: false,
  lines: Array.from({ length: count }, (_, i) => ({ startMs: start + i * 1000, text: `line ${i}` })),
});

describe('documentSignature', () => {
  it('differs when the song changes, even at the same line count', () => {
    const a = documentSignature(doc(111, 14));
    const b = documentSignature(doc(222, 14));
    assert.notEqual(a, b, '同一个行数但不同歌曲必须被识别为不同文档');
  });

  it('differs when the line count changes', () => {
    assert.notEqual(documentSignature(doc(111, 14)), documentSignature(doc(111, 13)));
  });

  it('differs when the timings shift', () => {
    assert.notEqual(documentSignature(doc(111, 5, 0)), documentSignature(doc(111, 5, 500)));
  });

  it('is stable for the same document', () => {
    assert.equal(documentSignature(doc(111, 14)), documentSignature(doc(111, 14)));
  });

  it('treats an empty document as its own identity, per song', () => {
    // A no-lyric result must still differ between songs, or the placeholder state would be
    // considered already rendered for the next track.
    assert.notEqual(
      documentSignature({ songId: 111, lines: [] }),
      documentSignature({ songId: 222, lines: [] }),
    );
  });

  it('handles a missing document without throwing', () => {
    assert.equal(documentSignature(null), 'none');
    assert.equal(documentSignature(undefined), 'none');
  });

  it('handles a document with no lines array', () => {
    assert.doesNotThrow(() => documentSignature({ songId: 1 }));
    assert.match(documentSignature({ songId: 1 }), /^1\|0\|/);
  });
});
