// The rule for "which cover do I draw": the user's own image while it is switched on, the song's
// otherwise. Small enough to be obvious, which is the point - the failure mode it guards against is a
// custom cover that silently stops being shown the next time a snapshot arrives.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { chooseCover, coverButtonState, coverButtonTitle, shouldRefetchCover } from '../src/cover-choice.js';

const custom = (url, enabled) => ({ url, enabled });

test('no custom cover: the song\'s own', () => {
  assert.equal(chooseCover({ trackUrl: 'ncm://a' }), 'ncm://a');
  assert.equal(chooseCover({ trackUrl: 'ncm://a', custom: null }), 'ncm://a');
  assert.equal(chooseCover({ trackUrl: 'ncm://a', custom: custom('data:image/png;base64,AA', false) }), 'ncm://a');
});

test('custom cover on: it wins over the song\'s', () => {
  assert.equal(chooseCover({ trackUrl: 'ncm://a', custom: custom('data:image/png;base64,AA', true) }), 'data:image/png;base64,AA');
});

test('custom cover on but the song has none: still the custom one', () => {
  assert.equal(chooseCover({ trackUrl: null, custom: custom('data:image/png;base64,AA', true) }), 'data:image/png;base64,AA');
});

test('enabled with no image is not a cover', () => {
  // The shell can report enabled before the file is read; drawing an empty string would blank the card.
  assert.equal(chooseCover({ trackUrl: 'ncm://a', custom: custom('', true) }), 'ncm://a');
  assert.equal(chooseCover({ trackUrl: 'ncm://a', custom: custom(null, true) }), 'ncm://a');
  assert.equal(chooseCover({ trackUrl: 'ncm://a', custom: { enabled: true } }), 'ncm://a');
});

test('nothing at all is null, not undefined', () => {
  assert.equal(chooseCover(), null);
  assert.equal(chooseCover({}), null);
  assert.equal(chooseCover({ trackUrl: undefined }), null);
});

test('button state: empty, off and on are three different things', () => {
  assert.equal(coverButtonState({ has: false, enabled: false }), 'empty');
  assert.equal(coverButtonState({ has: true, enabled: false }), 'off');
  assert.equal(coverButtonState({ has: true, enabled: true }), 'on');
  // A missing image cannot be "on", whatever the flag says.
  assert.equal(coverButtonState({ has: false, enabled: true }), 'empty');
  assert.equal(coverButtonState(), 'empty');
});

test('each state says what the next click does', () => {
  assert.match(coverButtonTitle('empty'), /选一张/);
  assert.match(coverButtonTitle('off'), /启用/);
  assert.match(coverButtonTitle('on'), /关掉/);
  // Right-clicking is the way back to the song's own cover, and the tooltip has to mention it.
  assert.match(coverButtonTitle('on'), /右键/);
  assert.match(coverButtonTitle('off'), /右键/);
});

test('the image is fetched on the first sight of a cover', () => {
  assert.equal(shouldRefetchCover(null, { has: true, enabled: true, rev: 0 }), true);
  assert.equal(shouldRefetchCover({ has: false }, { has: true, enabled: true, rev: 0 }), true);
});

test('picking a second picture fetches again, because only the revision changes', () => {
  // The bug this guards: still chosen, still on - so has/enabled are identical and a comparison of
  // those two alone would leave the first picture on screen forever.
  assert.equal(shouldRefetchCover({ has: true, rev: 0 }, { has: true, enabled: true, rev: 1 }), true);
  assert.equal(shouldRefetchCover({ has: true, rev: 3 }, { has: true, enabled: true, rev: 3 }), false);
});

test('switching the same cover off and on does not re-fetch it', () => {
  assert.equal(shouldRefetchCover({ has: true, rev: 2 }, { has: true, enabled: false, rev: 2 }), false);
  assert.equal(shouldRefetchCover({ has: true, rev: 2 }, { has: true, enabled: true, rev: 2 }), false);
});

test('clearing drops the image rather than re-fetching it', () => {
  assert.equal(shouldRefetchCover({ has: true, rev: 4 }, { has: false, enabled: true, rev: 5 }), false);
  assert.equal(shouldRefetchCover({ has: true, rev: 4 }, null), false);
});
