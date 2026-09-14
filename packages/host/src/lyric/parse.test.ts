// Unit tests for the lyric parsers.
//
//   node --test packages/host/src/lyric/
//
// All fixtures are shaped after data actually observed from the client and the
// public endpoint, including the unit traps (client times are seconds, yrc times
// are milliseconds).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { docFromClientSlice, docFromRawPayload, isCreditOnlySet, lyricsMentionTrack } from './build.ts';
import { payloadFromApi } from './fetch.ts';
import {
  finalizeLines,
  isCreditLine,
  parseClientLines,
  parseCompactYrc,
  parseJsonYrc,
  parseLrc,
  parseYrc,
} from './parse.ts';

describe('isCreditLine', () => {
  it('flags the credit lines the client mixes into lyrics', () => {
    assert.equal(isCreditLine('作词: PostmodernHippie', 0), true);
    assert.equal(isCreditLine('作曲: PostmodernHippie', 1000), true);
    assert.equal(isCreditLine('编曲: 钱雷', 2000), true);
    assert.equal(isCreditLine('制作人 : 赵雷', 3000), true);
    assert.equal(isCreditLine('混音师: 张三', 4000), true);
  });

  it('never flags ordinary lyrics', () => {
    assert.equal(isCreditLine(' and i can hear the silence', 12788), false);
    assert.equal(isCreditLine('我能听见寂静', 12788), false);
    assert.equal(isCreditLine('', 0), false);
  });

  it('leaves a colon-containing lyric alone once we are past the intro window', () => {
    // A real lyric that happens to start with a colon word must survive.
    assert.equal(isCreditLine('作词: 我乱写的', 60_000), false);
  });
});

describe('parseClientLines', () => {
  it('converts the client SECOND timestamps to milliseconds', () => {
    const lines = parseClientLines([
      { time: 0, lyric: '作词: X' },
      { time: 12.788, lyric: 'hello' },
      { time: 15, lyric: 'world' },
    ]);
    assert.deepEqual(
      lines.map((l) => l.startMs),
      [0, 12788, 15000],
    );
    assert.equal(lines[1]?.text, 'hello');
  });

  it('tolerates missing or malformed entries', () => {
    const lines = parseClientLines([
      { time: null, lyric: 'x' },
      { time: 1, lyric: null },
      { lyric: 'no time' },
      null,
      undefined,
    ] as never);
    assert.deepEqual(
      lines.map((l) => l.startMs),
      [1000],
    );
    assert.equal(lines[0]?.text, '');
  });

  it('keeps different lines that share a timestamp, and drops true duplicates', () => {
    const lines = parseClientLines([
      // The client emits both credits at time -0.001; deduplicating on the timestamp alone used
      // to drop "作曲", which is why a lyric-less track showed only half its credits.
      { time: -0.001, lyric: '作词: FAIZ' },
      { time: -0.001, lyric: '作曲: FAIZ' },
      // Same text at the same time is a genuine duplicate (an LRC line with several stamps).
      { time: 5, lyric: 'repeated' },
      { time: 5, lyric: 'repeated' },
      { time: 1, lyric: 'first' },
    ]);
    assert.deepEqual(
      lines.map((l) => l.text),
      ['作词: FAIZ', '作曲: FAIZ', 'first', 'repeated'],
    );
  });

  it('keeps untimed lines in their original order, ahead of the timed ones', () => {
    const lines = parseClientLines([
      { time: 10, lyric: 'later line' },
      { time: -0.001, lyric: '作词: X' },
      { time: -0.001, lyric: '作曲: Y' },
    ]);
    assert.deepEqual(
      lines.map((l) => l.text),
      ['作词: X', '作曲: Y', 'later line'],
    );
  });
});

describe('parseLrc', () => {
  it('reads mm:ss.xx (centiseconds) and mm:ss.xxx (milliseconds)', () => {
    const lines = parseLrc('[00:12.79]hello\n[01:02.345]world');
    assert.deepEqual(
      lines.map((l) => l.startMs),
      [12790, 62345],
    );
  });

  it('expands multiple timestamps on one line', () => {
    const lines = parseLrc('[00:01.00][00:30.50]repeated');
    assert.deepEqual(
      lines.map((l) => l.startMs),
      [1000, 30500],
    );
    assert.ok(lines.every((l) => l.text === 'repeated'));
  });

  it('returns nothing for empty input', () => {
    assert.deepEqual(parseLrc(null), []);
    assert.deepEqual(parseLrc(''), []);
    assert.deepEqual(parseLrc('no timestamps here'), []);
  });
});

describe('parseCompactYrc', () => {
  const sample = '[16960,3560](16960,240,0)一(17200,350,0)双(17550,470,0)迷';

  it('extracts per-character timings', () => {
    const lines = parseCompactYrc(sample);
    assert.equal(lines.length, 1);
    const line = lines[0]!;
    assert.equal(line.startMs, 16960);
    assert.equal(line.text, '一双迷');
    assert.deepEqual(line.words, [
      { startMs: 16960, durationMs: 240, text: '一' },
      { startMs: 17200, durationMs: 350, text: '双' },
      { startMs: 17550, durationMs: 470, text: '迷' },
    ]);
  });

  it('ignores lines that are not in the compact syntax', () => {
    assert.deepEqual(parseCompactYrc('[00:12.79]plain lrc'), []);
    assert.deepEqual(parseCompactYrc(''), []);
  });
});

describe('parseJsonYrc', () => {
  it('reads the per-line JSON dialect and concatenates the chunks', () => {
    const lines = parseJsonYrc(
      '{"t":0,"c":[{"tx":"编曲: "},{"tx":"钱雷","li":"http://x","or":"orpheus://y"}]}',
    );
    assert.equal(lines.length, 1);
    assert.equal(lines[0]?.startMs, 0);
    assert.equal(lines[0]?.text, '编曲: 钱雷');
    // This dialect has no per-character durations.
    assert.deepEqual(lines[0]?.words, []);
  });

  it('skips malformed JSON lines without throwing', () => {
    assert.deepEqual(parseJsonYrc('{"t":0,"c":['), []);
  });
});

describe('parseYrc', () => {
  it('prefers the dialect that carries word timings', () => {
    const compact = '[16960,3560](16960,240,0)一(17200,350,0)双';
    assert.equal(parseYrc(compact)[0]?.words.length, 2);
  });

  it('falls back to the JSON dialect when there are no word timings', () => {
    const json = '{"t":100,"c":[{"tx":"hello"}]}';
    const lines = parseYrc(json);
    assert.equal(lines[0]?.startMs, 100);
    assert.equal(lines[0]?.text, 'hello');
  });
});

describe('finalizeLines', () => {
  it('drops credit lines, fills end times and attaches translations', () => {
    const main = parseClientLines([
      { time: 0, lyric: '作词: X' },
      { time: 10, lyric: 'line one' },
      { time: 20, lyric: 'line two' },
    ]);
    const trans = parseClientLines([
      { time: 0, lyric: '' },
      { time: 10, lyric: '第一行' },
      { time: 20, lyric: '第二行' },
    ]);
    const lines = finalizeLines(main, trans);
    assert.equal(lines.length, 2);
    assert.equal(lines[0]?.text, 'line one');
    assert.equal(lines[0]?.translation, '第一行');
    // end of the first line is the start of the second
    assert.equal(lines[0]?.endMs, 20000);
    // last line gets a synthetic tail
    assert.ok((lines[1]?.endMs ?? 0) > 20000);
  });

  it('shifts both line and word timings by the offset', () => {
    const main = [{ startMs: 1000, text: 'x', words: [{ startMs: 1000, durationMs: 100, text: 'x' }] }];
    const lines = finalizeLines(main, [], [], -500);
    assert.equal(lines[0]?.startMs, 500);
    assert.equal(lines[0]?.words[0]?.startMs, 500);
  });
});

describe('docFromClientSlice', () => {
  const base = {
    songId: 2143886997,
    currentUsedLyric: 'lrc',
    currentUsedLyricVersion: 4,
    isLoading: false,
    isLyricFetchFailed: false,
    offset: 0,
    lyricLines: [
      { time: 0, lyric: '作词: PostmodernHippie' },
      { time: 12.788, lyric: ' and i can hear the silence' },
    ],
    tlyricLines: [
      { time: 0, lyric: '' },
      { time: 12.788, lyric: ' 我能听见寂静' },
    ],
    romaLyricLines: [],
    at: Date.now(),
  };

  it('builds a client-sourced document and keeps the credit line', () => {
    const doc = docFromClientSlice(base);
    assert.ok(doc);
    assert.equal(doc.source, 'client');
    // Both entries are kept: the credit line is what NetEase itself displays, and dropping it
    // would make a lyric-less track look like an empty one.
    assert.equal(doc.lines.length, 2);
    assert.equal(doc.lines[1]?.startMs, 12788);
    assert.equal(doc.lines[1]?.translation, ' 我能听见寂静');
    assert.equal(doc.instrumental, false);
  });

  it('applies the client offset, which is stored in seconds', () => {
    const doc = docFromClientSlice({ ...base, offset: -0.5 });
    assert.equal(doc?.offsetMs, -500);
    assert.equal(doc?.lines[1]?.startMs, 12288);
  });

  it('reports instrumental when the client has no lines and is not loading', () => {
    const doc = docFromClientSlice({ ...base, lyricLines: [], tlyricLines: [] });
    assert.ok(doc);
    assert.equal(doc.instrumental, true);
    assert.equal(doc.lines.length, 0);
    assert.equal(doc.source, 'none');
  });

  it('returns null while the client is still loading (so the host can wait)', () => {
    assert.equal(docFromClientSlice({ ...base, lyricLines: [], isLoading: true }), null);
  });
});

describe('isCreditOnlySet', () => {
  // Fixtures from a real case: song id 2650440016 ("芥") holds exactly these two entries, and
  // the track genuinely has no singable lyrics - NetEase shows only the credits for it.
  it('detects the credits-only shape NetEase shows for a lyric-less track', () => {
    assert.equal(
      isCreditOnlySet([
        { time: -0.001, lyric: '作词: FAIZ' },
        { time: -0.001, lyric: '作曲: FAIZ' },
      ]),
      true,
    );
  });

  it('is false for an empty set (a different state entirely)', () => {
    assert.equal(isCreditOnlySet([]), false);
    assert.equal(isCreditOnlySet(null), false);
    assert.equal(isCreditOnlySet(undefined), false);
  });

  it('is false as soon as one timed line is present', () => {
    assert.equal(
      isCreditOnlySet([
        { time: 0, lyric: '作词: FAIZ' },
        { time: 12.3, lyric: ' and i can hear the silence' },
      ]),
      false,
    );
  });
});

describe('lyricsMentionTrack', () => {
  /*
   * This is the check that separates this track's lyrics from the previous track's, which the
   * client's store briefly reports under the new song id. Both sides are real fixtures:
   * "Through Midnight" is credited "作词: KikKuU", while the stale set under "芥"'s id was
   * "Through Midnight"'s own lyrics.
   */
  const staleFromPreviousTrack = [
    { time: 0, lyric: '作词: KikKuU' },
    { time: 7.098, lyric: 'Through Midnight feat. 巡音ルカ' },
  ];

  it('rejects the previous track\'s lyrics for the new track', () => {
    assert.equal(lyricsMentionTrack(staleFromPreviousTrack, '芥', 'FAIZ / 重音テト'), false);
  });

  it('accepts the set that names this track', () => {
    const creditsForThisTrack = [
      { time: -0.001, lyric: '作词: FAIZ' },
      { time: -0.001, lyric: '作曲: FAIZ' },
    ];
    assert.equal(lyricsMentionTrack(creditsForThisTrack, '芥', 'FAIZ / 重音テト'), true);
  });

  it('matches on the track name too', () => {
    assert.equal(lyricsMentionTrack([{ time: 0, lyric: 'Through Midnight' }], 'Through Midnight', 'X'), true);
  });

  it('matches either artist when several are listed', () => {
    assert.equal(lyricsMentionTrack([{ time: 0, lyric: 'feat. 巡音ルカ' }], 'y', 'KikKuU / 巡音ルカ'), true);
  });

  it('is false when there is nothing to match against', () => {
    assert.equal(lyricsMentionTrack(staleFromPreviousTrack, '', ''), false);
  });
});

describe('docFromClientSlice keeps credits and reports the no-lyric state', () => {
  const base = {
    songId: 2650440016,
    currentUsedLyric: 'lrc',
    currentUsedLyricVersion: 1,
    isLoading: false,
    isLyricFetchFailed: false,
    offset: 0,
    lyricLines: [],
    tlyricLines: [],
    romaLyricLines: [],
    at: Date.now(),
  };

  it('keeps credit lines, because that is what NetEase displays', () => {
    const doc = docFromClientSlice({
      ...base,
      lyricLines: [
        { time: -0.001, lyric: '作词: FAIZ' },
        { time: -0.001, lyric: '作曲: FAIZ' },
      ],
    });
    assert.ok(doc);
    assert.equal(doc.lines.length, 2);
    assert.equal(doc.lines[0]?.text, '作词: FAIZ');
  });

  it('reports no lyrics when the client has nothing and is not loading', () => {
    const doc = docFromClientSlice({ ...base, lyricLines: [], tlyricLines: [] });
    assert.ok(doc);
    assert.equal(doc.instrumental, true);
    assert.equal(doc.lines.length, 0);
  });

  it('returns null while the client is still loading (so the host can wait)', () => {
    assert.equal(docFromClientSlice({ ...base, lyricLines: [], isLoading: true }), null);
  });
});

describe('payloadFromApi + docFromRawPayload', () => {
  it('marks an instrumental response', () => {
    const payload = payloadFromApi({ code: 200, nolyric: true });
    assert.equal(payload.noLyric, true);
    const doc = docFromRawPayload(42, payload);
    assert.equal(doc.instrumental, true);
    assert.equal(doc.source, 'none');
  });

  it('uses word timings when yrc is present and line timings otherwise', () => {
    const worded = payloadFromApi({
      code: 200,
      yrc: { lyric: '[16960,3560](16960,240,0)一(17200,350,0)双' },
      lrc: { lyric: '[00:16.96]一双' },
    });
    const docW = docFromRawPayload(1, worded);
    assert.equal(docW.hasWordTiming, true);
    assert.equal(docW.lines[0]?.words.length, 2);

    const plain = payloadFromApi({ code: 200, lrc: { lyric: '[00:16.96]一双' } });
    const docP = docFromRawPayload(1, plain);
    assert.equal(docP.hasWordTiming, false);
    assert.equal(docP.lines[0]?.words.length, 0);
    assert.equal(docP.lines[0]?.startMs, 16960);
  });

  it('degrades to an empty document when the endpoint returns nothing useful', () => {
    const doc = docFromRawPayload(7, payloadFromApi({ code: 200 }));
    assert.equal(doc.lines.length, 0);
    assert.equal(doc.instrumental, true);
  });
});
