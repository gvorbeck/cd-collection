/* ============================================================
   musicbrainz.js — shared MusicBrainz helpers
   ------------------------------------------------------------
   Both pages that talk to the MusicBrainz web service import from
   here — the grid for cover art (release-group + Cover Art
   Archive), the labels page for track listings (release +
   recordings) — and share these primitives.

   The throttle in particular has to be shared rather than
   duplicated: MusicBrainz's 1/sec limit is per client, and a
   client is the whole page.
   ============================================================ */

// MusicBrainz asks every client to identify itself with a descriptive
// User-Agent (app name/version + contact). Browsers can't set User-Agent on
// fetch, so MB reads this from an `app=` query param instead.
export const APP_IDENTITY = 'CDCollection/1.0 ( https://github.com/gvorbeck/cd-collection )';

// Web-service base. Append '/release' or '/release-group'.
export const WS_BASE = 'https://musicbrainz.org/ws/2';

export function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Escape characters that are special to MusicBrainz's Lucene query syntax.
export function escapeLucene(str) {
  return str.replace(/[+\-&|!(){}\[\]^"~*?:\\/]/g, '\\$&');
}

/* ---------- Rate limiting ----------
   MusicBrainz asks for no more than one request per second per client, and
   "client" means the whole page, not one feature of it. This lives here
   rather than in either caller because both pages hit the same service and
   a throttle each is not a throttle: two independent queues at 1/sec is
   2/sec at the server. Anything that talks to MB goes through this. */

// Minimum gap between calls (ms). The rule is 1/sec; the extra 100ms is
// headroom for clock jitter between here and their rate limiter.
export const THROTTLE_MS = 1100;

let chain = Promise.resolve();
let lastCall = 0;

function nowMs() {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

/**
 * fetch() a MusicBrainz URL, serialized behind every other MB call with at
 * least THROTTLE_MS between them. Returns the raw Response — callers decide
 * what a non-ok status means to them.
 */
export function throttledFetch(url) {
  const run = async () => {
    const gap = THROTTLE_MS - (nowMs() - lastCall);
    if (gap > 0) await delay(gap);
    lastCall = nowMs();
    return fetch(url, { headers: { Accept: 'application/json' } });
  };
  // Chain so calls run one-at-a-time. A failure in one must not break the
  // chain for the next, so errors are swallowed on the chaining link only —
  // the returned promise still rejects for the caller that made the call.
  const result = chain.then(run, run);
  chain = result.then(() => {}, () => {});
  return result;
}

/**
 * Milliseconds → "m:ss", or "h:mm:ss" once it runs past an hour. Blank for a
 * track MusicBrainz has no timing for, so callers can drop it wholesale.
 */
export function formatDuration(ms) {
  if (!ms) return '';
  const total = Math.round(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const ss = String(total % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/* ---------- Web-service calls ---------- */

/**
 * GET a MusicBrainz web-service path as JSON, through the shared throttle.
 * `path` is appended to WS_BASE ('/release', '/release-group/<mbid>', …) and
 * `params` is merged over the two every call needs: fmt=json and the app
 * identity. Non-2xx throws, so every caller fails the same way.
 */
export async function wsFetch(path, params = {}) {
  const query = new URLSearchParams({ fmt: 'json', app: APP_IDENTITY, ...params });
  const res = await throttledFetch(`${WS_BASE}${path}?${query}`);
  if (!res.ok) throw new Error(`MusicBrainz ${res.status}`);
  return res.json();
}

// A release's 4-digit year as a number, or null when MB has no date for it.
export function releaseYear(rel) {
  return parseInt((rel.date || '').slice(0, 4), 10) || null;
}

/**
 * Score a release from a search result: prefer official CD pressings, then
 * the closest year. MusicBrainz returns every pressing of a title — vinyl,
 * cassette, promos, twelve reissues — and its own relevance score barely
 * separates them, so this does the choosing.
 */
export function scoreRelease(rel, wantYear) {
  let score = 0;
  if (rel.status === 'Official') score += 100;

  const formats = (rel.media || [])
    .map((m) => (m.format || '').toLowerCase())
    .join(' ');
  if (formats.includes('cd')) score += 50;

  const relYear = releaseYear(rel);
  if (wantYear && relYear) {
    const diff = Math.abs(relYear - wantYear);
    // Exact year wins big; otherwise closer is better.
    score += diff === 0 ? 40 : Math.max(0, 30 - diff);
  } else if (relYear) {
    // No target year: gently prefer earlier (original) pressings.
    score += Math.max(0, 30 - (relYear - 1900) / 10);
  }

  // This is an American collection of standard editions, so among pressings
  // that are otherwise equal, prefer a US (or worldwide) one and a single disc
  // — a deluxe reissue's bonus disc of demos isn't the record on the shelf.
  // Deliberately small: these separate tied pressings of the same release, and
  // must never outweigh the year or the format above.
  const country = (rel.country || '').toUpperCase();
  if (country === 'US') score += 6;
  else if (country === 'XW') score += 4; // MB's code for [Worldwide]
  if ((rel.media || []).length === 1) score += 8;

  score += (rel.score || 0) / 100; // MB's own relevance as a tiebreaker.
  return score;
}

// How precisely a release is dated: 3 for YYYY-MM-DD, 2 for YYYY-MM, 1 for a
// bare year, 0 for undated.
function datePrecision(rel) {
  return (rel.date || '').split('-').filter(Boolean).length;
}

/**
 * Highest-scoring release from a set, or null if it's empty.
 *
 * Ties are the normal case, not the exception: a title's official CD pressings
 * differ mainly by country, they share a year, and browse results carry no
 * relevance score at all — so scoreRelease alone left the winner to whatever
 * order MusicBrainz happened to return, which for "Back to Black" meant a
 * ten-track regional pressing over the eleven-track original. Break the tie on
 * how well MB knows the release: a full date is the documented original, a bare
 * year is usually a reissue someone catalogued later. Earliest first after that.
 */
export function pickBestRelease(releases, wantYear) {
  if (!releases || releases.length === 0) return null;
  return releases
    .slice()
    .sort((a, b) =>
      scoreRelease(b, wantYear) - scoreRelease(a, wantYear) ||
      datePrecision(b) - datePrecision(a) ||
      String(a.date || '9999').localeCompare(String(b.date || '9999')))[0];
}

/**
 * Flatten a release fetched with `inc=recordings` into [{ title, length }],
 * in playing order across every medium. A two-disc set comes back as one
 * continuous list, which is what both callers want: the detail view prints
 * it as one tracklist, and the labels page as one numbered column.
 * Untitled tracks are dropped rather than rendered blank.
 */
export function flattenTracks(release) {
  const out = [];
  ((release && release.media) || []).forEach((medium) => {
    (medium.tracks || []).forEach((track) => {
      const title = track.title || (track.recording && track.recording.title) || '';
      if (!title) return;
      const length = track.length || (track.recording && track.recording.length) || 0;
      out.push({ title, length });
    });
  });
  return out;
}

