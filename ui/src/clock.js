/**
 * The playback clock.
 *
 * The client reports the position ~30 times per second, but the UI renders at up
 * to 60fps, so between samples the position is extrapolated from a monotonic
 * clock. Naively copying each sample makes the progress bar stutter (the samples
 * arrive slightly irregularly); extrapolating alone lets it drift. So we do both,
 * and correct gently:
 *
 *   - Every sample re-anchors the estimate.
 *   - Small differences are absorbed by nudging the *reported* estimate toward the
 *     sample rather than jumping, which is what keeps the bar smooth.
 *   - Big differences (a seek, a loop, or a track change) snap immediately,
 *     because easing through them would look wrong.
 *   - When paused, the estimate freezes.
 *
 * All times are milliseconds. `speed` scales the extrapolation so 1.5x playback
 * stays in sync.
 */

/** Anything larger than this is treated as a seek and snapped, not eased. */
const SEEK_THRESHOLD_MS = 900;
/** How much of the remaining drift to remove per sample while easing. */
const EASE_FACTOR = 0.5;
/** Never move the estimate more than this per sample while easing. */
const EASE_MAX_MS = 120;
/** Samples older than this are considered stale and freeze the clock. */
const SAMPLE_STALE_MS = 2500;

export class PlayClock {
  /** Estimated position in milliseconds. */
  positionMs = 0;
  /** Total duration in milliseconds, 0 when unknown. */
  durationMs = 0;

  #anchorPositionMs = 0;
  #anchorAt = 0;
  #playing = false;
  #speed = 1;
  #songId = null;
  #samples = 0;

  /** Feed a progress sample from the client. */
  onPlayhead(playhead, songId) {
    const now = performance.now();
    const reported = playhead.positionMs;

    if (songId !== this.#songId) {
      // New track: snap.
      this.#songId = songId;
      this.#anchorPositionMs = reported;
      this.#anchorAt = now;
      this.#samples = playhead.sampleCount ?? 0;
      this.positionMs = reported;
      return;
    }

    const estimated = this.#estimate(now);
    const drift = reported - estimated;

    if (Math.abs(drift) > SEEK_THRESHOLD_MS) {
      // A seek or loop: follow it exactly.
      this.#anchorPositionMs = reported;
      this.#anchorAt = now;
      this.positionMs = reported;
    } else {
      const ease = Math.max(-EASE_MAX_MS, Math.min(EASE_MAX_MS, drift * EASE_FACTOR));
      this.#anchorPositionMs = estimated + ease;
      this.#anchorAt = now;
      this.positionMs = this.#anchorPositionMs;
    }

    this.#samples = playhead.sampleCount ?? this.#samples + 1;
  }

  /** Feed a state change (play/pause, speed, duration). */
  onPlayback(playback, durationMs) {
    const now = performance.now();
    const wasPlaying = this.#playing;

    // Freeze the current estimate before changing the mode, so pausing does not
    // lose up to a frame of progress.
    if (wasPlaying && playback.status !== 'playing') {
      this.positionMs = this.#estimate(now);
      this.#anchorPositionMs = this.positionMs;
      this.#anchorAt = now;
    }
    // Resume from the frozen position; the next sample re-anchors anyway.
    if (!wasPlaying && playback.status === 'playing') {
      this.#anchorPositionMs = this.positionMs;
      this.#anchorAt = now;
    }

    this.#playing = playback.status === 'playing';
    if (typeof playback.speed === 'number' && playback.speed > 0) {
      this.#speed = playback.speed;
    }
    if (typeof durationMs === 'number' && durationMs > 0) {
      this.durationMs = durationMs;
    }
  }

  /** Advance the estimate; call once per animation frame. */
  tick(now = performance.now()) {
    if (!this.#playing) {
      // Shrink the anchor staleness so a resume does not carry old time.
      this.#anchorAt = now;
      return this.positionMs;
    }
    this.positionMs = this.#estimate(now);
    return this.positionMs;
  }

  /** 0..1 fraction of the track, clamped. */
  get fraction() {
    if (!this.durationMs || this.durationMs <= 0) return 0;
    const value = this.positionMs / this.durationMs;
    if (!Number.isFinite(value)) return 0;
    return Math.max(0, Math.min(1, value));
  }

  /**
   * Milliseconds of position change per second of wall time. Used to detect a
   * stalled clock (user paused in the client, or a stream that stopped reporting).
   */
  get sampleCount() {
    return this.#samples;
  }

  #estimate(now) {
    if (!this.#playing) return this.positionMs;
    const elapsed = now - this.#anchorAt;
    if (elapsed <= 0) return this.#anchorPositionMs;
    const advanced = this.#anchorPositionMs + elapsed * this.#speed;
    // Never run past the end of the track.
    if (this.durationMs > 0) return Math.min(advanced, this.durationMs);
    return advanced;
  }
}

/** Format milliseconds as m:ss (or h:mm:ss for long tracks). */
export function formatTime(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '0:00';
  const total = Math.floor(ms / 1000);
  const seconds = total % 60;
  const minutes = Math.floor(total / 60) % 60;
  const hours = Math.floor(total / 3600);
  const pad = (n) => String(n).padStart(2, '0');
  if (hours > 0) return `${hours}:${pad(minutes)}:${pad(seconds)}`;
  return `${minutes}:${pad(seconds)}`;
}

/** True when a sample is old enough that the client probably stopped reporting. */
export function isSampleStale(playhead, now = Date.now()) {
  if (!playhead) return true;
  return now - playhead.at > SAMPLE_STALE_MS;
}
