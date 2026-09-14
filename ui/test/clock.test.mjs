// Unit tests for the playback clock.
//
//   node ui/test/clock.test.mjs
//
// The clock is the piece that decides whether the progress bar is smooth and
// whether lyrics land on time, so it is worth testing without a browser. Its
// extrapolation uses performance.now(), which we drive with a fake so the whole
// timeline is deterministic.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

// clock.js reads performance.now() at module scope only through calls, so stubbing
// the global before import is enough.
let now = 0;
globalThis.performance = { now: () => now };

const { PlayClock, formatTime, isSampleStale } = await import('../src/clock.js');

const advance = (ms) => {
  now += ms;
};

const sample = (positionMs, sampleCount = 1) => ({
  positionMs,
  playId: 'p',
  at: Date.now(),
  sampleCount,
});

describe('formatTime', () => {
  it('formats m:ss and h:mm:ss', () => {
    assert.equal(formatTime(0), '0:00');
    assert.equal(formatTime(1000), '0:01');
    assert.equal(formatTime(65_000), '1:05');
    assert.equal(formatTime(3_665_000), '1:01:05');
  });

  it('survives nonsense input', () => {
    assert.equal(formatTime(Number.NaN), '0:00');
    assert.equal(formatTime(-5), '0:00');
  });
});

describe('PlayClock', () => {
  it('starts at zero and does not advance until told it is playing', () => {
    now = 1000;
    const clock = new PlayClock();
    clock.onPlayhead(sample(5000), 1);
    assert.equal(clock.positionMs, 5000);
    advance(500);
    clock.tick();
    // Still paused: position must not move.
    assert.equal(clock.positionMs, 5000);
  });

  it('extrapolates between samples while playing', () => {
    now = 0;
    const clock = new PlayClock();
    clock.onPlayback({ status: 'playing', speed: 1 }, 180_000);
    clock.onPlayhead(sample(10_000), 1);

    advance(500);
    clock.tick();
    assert.ok(
      Math.abs(clock.positionMs - 10_500) < 1,
      `expected ~10500, got ${clock.positionMs}`,
    );
  });

  it('eases small drift instead of jumping (keeps the bar smooth)', () => {
    now = 0;
    const clock = new PlayClock();
    clock.onPlayback({ status: 'playing', speed: 1 }, 180_000);
    clock.onPlayhead(sample(10_000), 1);

    // Advance so our extrapolation is 10_200, then have the client report 10_260.
    advance(200);
    clock.onPlayhead(sample(10_260), 2);
    const after = clock.positionMs;

    // Must move toward the sample without jumping straight onto it: the bar should
    // absorb the correction, not reproduce the client's jitter.
    assert.ok(after > 10_200, `expected progress past the extrapolation, got ${after}`);
    assert.ok(after <= 10_260 + 1, `expected to approach but not overshoot, got ${after}`);
  });

  it('snaps on a large difference (a seek)', () => {
    now = 0;
    const clock = new PlayClock();
    clock.onPlayback({ status: 'playing', speed: 1 }, 180_000);
    clock.onPlayhead(sample(10_000, 1));
    clock.onPlayhead(sample(20_000, 1));
    assert.equal(clock.positionMs, 20_000, 'seeking forward inside the track should snap');
  });

  it('snaps when the song changes, even at a similar position', () => {
    now = 0;
    const clock = new PlayClock();
    clock.onPlayback({ status: 'playing', speed: 1 }, 180_000);
    clock.onPlayhead(sample(10_000, 1), 111);
    // New song id at almost the same position: this is a track change, so snap
    // rather than easing from the previous track's position.
    clock.onPlayhead(sample(50, 1), 222);
    assert.equal(clock.positionMs, 50);
  });

  it('freezes while paused and resumes from where it stopped', () => {
    now = 0;
    const clock = new PlayClock();
    clock.onPlayback({ status: 'playing', speed: 1 }, 180_000);
    clock.onPlayhead(sample(20_000), 1);

    advance(1000);
    clock.onPlayback({ status: 'paused', speed: 1 }, 180_000);
    const atPause = clock.positionMs;
    assert.ok(atPause >= 21_000, `expected ~21000 at pause, got ${atPause}`);

    advance(5000);
    clock.tick();
    assert.equal(clock.positionMs, atPause, 'position must not move while paused');

    clock.onPlayback({ status: 'playing', speed: 1 }, 180_000);
    advance(500);
    clock.tick();
    assert.ok(clock.positionMs > atPause, 'must resume after pause');
  });

  it('scales with playback speed', () => {
    now = 0;
    const clock = new PlayClock();
    clock.onPlayback({ status: 'playing', speed: 1.5 }, 300_000);
    clock.onPlayhead(sample(0), 1);
    advance(1000);
    clock.tick();
    assert.ok(Math.abs(clock.positionMs - 1500) < 2, `expected ~1500, got ${clock.positionMs}`);
  });

  it('never extrapolates past the end of the track', () => {
    now = 0;
    const clock = new PlayClock();
    clock.onPlayback({ status: 'playing', speed: 1 }, 10_000);
    clock.onPlayhead(sample(9_900), 1);
    advance(5000);
    clock.tick();
    assert.equal(clock.positionMs, 10_000);
  });

  it('reports a clamped fraction', () => {
    now = 0;
    const clock = new PlayClock();
    clock.onPlayback({ status: 'playing', speed: 1 }, 10_000);
    clock.onPlayhead(sample(5_000), 1);
    assert.ok(Math.abs(clock.fraction - 0.5) < 0.001);

    clock.onPlayhead(sample(0), 2);
    assert.equal(clock.fraction, 0);

    // Unknown duration must not produce NaN.
    const noDuration = new PlayClock();
    noDuration.onPlayhead(sample(1), 1);
    assert.equal(noDuration.fraction, 0);
  });
});

describe('isSampleStale', () => {
  it('treats a missing sample as stale', () => {
    assert.equal(isSampleStale(null), true);
  });

  it('treats an old sample as stale and a fresh one as current', () => {
    const fresh = { at: Date.now() };
    assert.equal(isSampleStale(fresh), false);
    assert.equal(isSampleStale({ at: Date.now() - 60_000 }), true);
  });
});
