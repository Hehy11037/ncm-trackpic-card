/**
 * Lyrics, part 1: fetching.
 *
 * Two sources, in order of preference:
 *
 *  1. **The client** — the bridge forwards the lyric document the client already
 *     fetched and parsed. Free (no network), reuses the client's cache and
 *     session, and works for tracks that require a logged-in account.
 *  2. **The public endpoint** — a fallback for when the client has nothing yet.
 *     Verified on this machine to return word-by-word `yrc`, provided `yv=-1` is
 *     passed. Note `curl.exe` fails against this endpoint here (TLS) while Node's
 *     fetch works, so this must run in Node.
 *
 * Both are normalized into the same shape, so the builder does not care which
 * source won.
 */

export interface RawLyricPayload {
  lrc: string | null;
  yrc: string | null;
  tlyric: string | null;
  romalrc: string | null;
  ytlrc: string | null;
  yromalrc: string | null;
  /** The client reports instrumental tracks through these flags. */
  noLyric: boolean;
  fetchFailed: boolean;
  hadAnyLyric: boolean;
  source: 'client' | 'public-api' | 'none';
}

export function emptyPayload(): RawLyricPayload {
  return {
    lrc: null,
    yrc: null,
    tlyric: null,
    romalrc: null,
    ytlrc: null,
    yromalrc: null,
    noLyric: false,
    fetchFailed: false,
    hadAnyLyric: false,
    source: 'none',
  };
}

const LYRIC_ENDPOINT = 'https://music.163.com/api/song/lyric/v1';

export interface FetchOptions {
  timeoutMs?: number;
  /** Injectable for testing; defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

interface LyricApiResponse {
  code?: number;
  lrc?: { lyric?: string };
  yrc?: { lyric?: string };
  tlyric?: { lyric?: string };
  romalrc?: { lyric?: string };
  ytlrc?: { lyric?: string };
  yromalrc?: { lyric?: string };
  nolyric?: boolean;
  uncollected?: boolean;
}

/**
 * Fetch from the public endpoint.
 *
 * `yv=-1` is what makes word-by-word lyrics come back; without it only `lrc` and
 * `klyric` are returned (measured).
 */
export async function fetchPublicLyrics(
  songId: number,
  options: FetchOptions = {},
): Promise<RawLyricPayload> {
  const doFetch = options.fetchImpl ?? fetch;
  const params = new URLSearchParams({
    id: String(songId),
    cp: 'false',
    lv: '-1',
    kv: '-1',
    tv: '-1',
    rv: '-1',
    yv: '-1',
    ytv: '-1',
    yrv: '-1',
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 8000);
  try {
    const res = await doFetch(`${LYRIC_ENDPOINT}?${params}`, {
      signal: controller.signal,
      headers: {
        referer: 'https://music.163.com/',
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        accept: 'application/json',
      },
    });
    if (!res.ok) {
      return { ...emptyPayload(), fetchFailed: true, source: 'public-api' };
    }
    const json = (await res.json()) as LyricApiResponse;
    return payloadFromApi(json);
  } catch {
    return { ...emptyPayload(), fetchFailed: true, source: 'public-api' };
  } finally {
    clearTimeout(timer);
  }
}

export function payloadFromApi(json: LyricApiResponse): RawLyricPayload {
  const lrc = json.lrc?.lyric ?? null;
  const yrc = json.yrc?.lyric ?? null;
  const tlyric = json.tlyric?.lyric ?? null;
  const romalrc = json.romalrc?.lyric ?? null;
  const ytlrc = json.ytlrc?.lyric ?? null;
  const yromalrc = json.yromalrc?.lyric ?? null;
  const noLyric = json.nolyric === true || json.uncollected === true;
  const hadAnyLyric = Boolean(
    (lrc && lrc.trim()) || (yrc && yrc.trim()) || (tlyric && tlyric.trim()),
  );
  return {
    lrc,
    yrc,
    tlyric,
    romalrc,
    ytlrc,
    yromalrc,
    noLyric,
    fetchFailed: false,
    hadAnyLyric,
    source: hadAnyLyric ? 'public-api' : 'none',
  };
}
