/**
 * A value the card has drawn ahead of the client, held until the client agrees.
 *
 * This is the fix for two reported bugs and the shape they share.
 *
 *  - **"The play/pause button switches slowly."** The command was immediate; the drawing was not.
 *    A media key takes the client a moment to act on, and it keeps publishing snapshots until it
 *    does - so a card that drew every snapshot verbatim flipped the button, flipped it back, and
 *    flipped it again.
 *  - **"The mode button only has two modes."** `cycleMode` advanced from the mode in the last
 *    snapshot, which is the client's mode as of the last round trip. Clicking faster than that round
 *    trip sent the same next mode every time, so the card never got past the second one.
 *
 * Both are "the user has already moved; the client has not reported it yet". Holding the user's
 * value until one of three things happens - the client agrees, the host reports a failure, or the
 * hold times out - is one rule, so it lives in one place with tests rather than three times inline.
 *
 * The held value is only ever *drawn*; nothing reads it back as truth. `resolve` takes the client's
 * value every time, and that is what the caller ends up with whenever the hold is released.
 */
export function createOptimisticHold({ timeoutMs = 1200, equals = (a, b) => a === b } = {}) {
  /** @type {{ value: any, at: number } | null} */
  let pending = null;

  return {
    /** Remember the value the user just chose. */
    set(value, now = performance.now()) {
      pending = { value, at: now };
    },

    /** Release the hold without drawing anything new (the host said the command failed). */
    clear() {
      pending = null;
    },

    /** The held value, or null when nothing is held. */
    get value() {
      return pending ? pending.value : null;
    },

    get active() {
      return pending !== null;
    },

    /**
     * What to draw: the client's value, unless the user's is still live.
     *
     * Call once per snapshot. A hold ends when the client reports the value the user chose, when too
     * long has passed, or when it is cleared - and the value returned is the client's own in all
     * three cases, so a released hold can never leave the card drawing something the client is not.
     *
     * `now` is a parameter so the timeout boundary can be tested without waiting for it.
     */
    resolve(clientValue, now = performance.now()) {
      if (!pending) return clientValue;
      if (equals(clientValue, pending.value)) {
        pending = null;
        return clientValue;
      }
      if (now - pending.at > timeoutMs) {
        pending = null;
        return clientValue;
      }
      return pending.value;
    },
  };
}
