// Unit tests for the transport helpers shared with the overlay.
//
//   node packages/host/src/transport.test.ts
//
// The wire format for every duration in this project is milliseconds. The client's native player is
// the one exception: its seek takes whole *seconds*, which was measured rather than assumed - the
// client's own progress bar sent `seek({playId, seekId, value: 109})` for a target of 109 seconds
// and the reply echoed `position: 109`.
//
// Two things about that conversion are worth pinning down:
//
//   - it rounds, it does not floor. At the end of a track, flooring a 0.6s remainder lands short of
//     the point the user released the pointer at, and "the seek is slightly off" is unfalsifiable
//     from the outside.
//   - it clamps at zero. A negative position is not a seek to anywhere, and the client would be
//     within its rights to do something surprising with it.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { makeSeekId, msToSeekSeconds, PLAY_MODES, secondsToMs } from '../../shared/src/types.ts';

describe('msToSeekSeconds', () => {
  it('rounds to whole seconds', () => {
    assert.equal(msToSeekSeconds(109_000), 109);
    assert.equal(msToSeekSeconds(109_400), 109);
    assert.equal(msToSeekSeconds(109_600), 110);
  });

  it('rounds rather than floors', () => {
    // 0.6s past a whole second must not come back as the whole second before it.
    assert.equal(msToSeekSeconds(1_600), 2);
    assert.equal(msToSeekSeconds(900), 1);
  });

  it('clamps at zero', () => {
    assert.equal(msToSeekSeconds(-5_000), 0);
    assert.equal(msToSeekSeconds(0), 0);
  });

  it('answers null for values it cannot convert', () => {
    assert.equal(msToSeekSeconds(null), null);
    assert.equal(msToSeekSeconds(undefined), null);
    assert.equal(msToSeekSeconds(Number.NaN), null);
    assert.equal(msToSeekSeconds(Number.POSITIVE_INFINITY), null);
  });

  it('is the inverse of secondsToMs', () => {
    for (const seconds of [0, 1, 42, 109, 281]) {
      assert.equal(msToSeekSeconds(secondsToMs(seconds)), seconds);
    }
  });

  /*
   * The bridge cannot import this module: it is string-assembled into a page and carries no
   * imports. So the same rule is written twice, and this is the check that they have not drifted.
   * The bridge's line is extracted and evaluated as it stands, so the test fails if either side
   * changes shape - not merely if a number changes.
   */
  it('matches the rule the bridge sends to the client', () => {
    const source = readFileSync(new URL('./bridge-script.ts', import.meta.url), 'utf8');
    const line = /const seekSeconds = (.+?);\n/.exec(source)?.[1];
    assert.ok(line, 'bridge no longer declares seekSeconds');
    const bridgeRule = new Function(`return (${line});`)() as (ms: number) => number;
    for (const ms of [0, 1, 499, 500, 999, 1_000, 109_400, 109_600, 281_654]) {
      assert.equal(bridgeRule(ms), msToSeekSeconds(ms), `${ms}ms`);
    }
  });
});

describe('makeSeekId', () => {
  it('reads like the id the client itself sends', () => {
    assert.equal(makeSeekId(2102424489, 'OA8H6F'), '2102424489|seek|OA8H6F');
  });

  it('is unique per call when given different randoms', () => {
    // The reply is matched by this id, so two seeks racing each other must not share one.
    const ids = new Set(['A', 'B', 'C'].map((suffix) => makeSeekId(1, suffix)));
    assert.equal(ids.size, 3);
  });

  it('survives a missing song id', () => {
    assert.equal(makeSeekId(null, 'X1'), '|seek|X1');
  });
});

describe('PLAY_MODES', () => {
  it('is the four user-facing modes, in the cycle order the client itself uses', () => {
    // Measured by clicking the client's own mode button four times: playOrder (顺序播放) ->
    // playCycle (列表循环) -> playOneCycle (单曲循环) -> playRandom (随机播放) -> back.
    assert.deepEqual([...PLAY_MODES], ['playOrder', 'playCycle', 'playOneCycle', 'playRandom']);
  });
});
