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

   The two-step lookup at the bottom — find the release group,
   then pull one release's tracks out of it — lives here too, plus
   the shortcut past it for a disc whose sheet row carries a
   barcode. Both deliberately cache nothing. art.js layers localStorage over
   it; the labels page calls it straight and wants no cache at
   all. Sharing the logic without sharing the storage is the whole
   reason it moved out of art.js: the labels page's Auto-fill used
   to search releases directly and would happily fill in a
   same-named single when the year was blank.
   ============================================================ */

// MusicBrainz asks every client to identify itself with a descriptive
// User-Agent (app name/version + contact). Browsers can't set User-Agent on
// fetch, so MB reads this from an `app=` query param instead.
// Not exported, for the same reason throttledFetch isn't: config.js used to
// hold a copy of this and the base URL, which dragged the web-service module
// into the import graph of every file that wanted a presentation setting.
const APP_IDENTITY = 'CDCollection/1.0 ( https://github.com/gvorbeck/cd-collection )';

// Web-service base. Append '/release' or '/release-group'.
const WS_BASE = 'https://musicbrainz.org/ws/2';

// Used by the throttle below and by nothing else. Not exported: a generic
// sleep() is the kind of helper that gets imported from wherever it happens to
// live, and the file it happens to live in is the MusicBrainz client — the one
// module the rest of the site is deliberately kept from importing casually
// (see the note on APP_IDENTITY). If another module ever needs one, util.js is
// where it belongs.
function delay(ms) {
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
// headroom for clock jitter between here and their rate limiter. Not exported
// either: a caller that can read this number is a caller that can pace itself
// against it, and the whole point of the paragraph above is that there is one
// queue and everything goes through it.
const THROTTLE_MS = 1100;

let chain = Promise.resolve();
let lastCall = 0;

function nowMs() {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

/**
 * fetch() a MusicBrainz URL, serialized behind every other MB call with at
 * least THROTTLE_MS between them. Returns the raw Response — callers decide
 * what a non-ok status means to them.
 *
 * Not exported: wsFetch below is the only caller, and keeping it that way is
 * what makes "every MB request is throttled and identically shaped" a property
 * of this module rather than a rule other files have to remember.
 */
function throttledFetch(url) {
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
  // must never outweigh the status, the format, or a year we actually asked for.
  //
  // The cap is what makes that last clause true. The narrowest gap it has to
  // respect is the exact-year cliff: 40 for the year we asked for against 29
  // for one year off, so 11. Uncapped these came to 14 and did overturn it — an
  // exact-year GB 2-disc scored 190 while a year-off US single-disc scored 193.
  // Capped at 10, plus the ≤1.00 of MB relevance below, they reach exactly 11:
  // enough to pull level with an exact-year pressing, never enough to pass it
  // on score.
  //
  // Level is not the same as beaten, though. A tie here falls through to
  // pickBestRelease's next test, date precision, and that one can land either
  // way: a year-off US single-disc MB has a full YYYY-MM-DD for still wins over
  // an exact-year pressing it only knows to the year. That is rare, and the
  // better-documented release is a defensible answer, but it is not what "never
  // outweighs the year" sounds like, so it is written down rather than implied
  // away.
  //
  // None of this governs the no-target-year branch above, where the slope is
  // 0.1 per year and 10 points is a century of it — a US single-disc reissue
  // outranks a foreign 2-disc original from decades earlier. That branch says
  // "gently prefer" and means it: with no year to go on, the pressing that
  // looks like the rest of the shelf is as good a guess as the oldest one.
  let tiebreak = 0;
  const country = (rel.country || '').toUpperCase();
  if (country === 'US') tiebreak += 6;
  else if (country === 'XW') tiebreak += 4; // MB's code for [Worldwide]
  if ((rel.media || []).length === 1) tiebreak += 8;
  score += Math.min(10, tiebreak);

  score += (rel.score || 0) / 100; // MB's own relevance as a tiebreaker.
  return score;
}

// How precisely a release is dated: 3 for YYYY-MM-DD, 2 for YYYY-MM, 1 for a
// bare year, 0 for undated. Exported only so the tests can pin it — it's a
// tiebreaker inside pickBestRelease, not something a page should be asking.
export function datePrecision(rel) {
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


/* ---------- The pinned lookup ----------
   A row that carries a barcode doesn't need any of the guessing the two-step
   lookup below does. The barcode is printed on the back of the case and names
   exactly one pressing, so MusicBrainz can be asked for that pressing directly
   and neither piece of scoring — which record, then which pressing of it — has
   to run at all. That is the whole point of the column: the discs the search
   gets wrong are the ones with a common title or a dozen reissues, and those
   are precisely the ones a barcode settles outright. */

/**
 * The Lucene query for a barcode, asked in every form MusicBrainz might be
 * holding it in.
 *
 * A UPC-A and an EAN-13 for the same product differ by one leading zero, and
 * which of the two MB has on file depends on whoever typed it in off the box.
 * A spreadsheet compounds it: a cell left to default formatting is read as a
 * number, and the leading zero is gone before we ever see it. So ask for the
 * digits given, the digits with a zero on the front, and — when they already
 * start with one — the digits without it. A form that can't exist simply
 * matches nothing, and the whole set is still one request.
 */
export function barcodeQuery(barcode) {
  const forms = new Set([barcode, `0${barcode}`]);
  if (barcode.startsWith('0')) forms.add(barcode.slice(1));
  // Stripping the zero off "0" leaves nothing, and `barcode:` with nothing
  // after it isn't a weak query — it's a parse error at the far end that takes
  // the whole search down with it. Nothing upstream can produce a bare zero,
  // since parseBarcode won't pass anything shorter than eight digits, but this
  // is exported and tested on its own and a query builder that *can* emit a
  // broken query eventually does.
  forms.delete('');
  return [...forms].map((form) => `barcode:${form}`).join(' OR ');
}

/**
 * The MBID of the release a barcode names, or null when MusicBrainz holds no
 * release carrying it. `year` is the disc's year as a number, or null.
 *
 * A barcode is meant to identify one product and nearly always does, but MB
 * does hold the occasional duplicate — the same disc entered twice, or once per
 * country by two people reading the same box. pickBestRelease settles those the
 * way every other choice on this site is settled rather than taking whichever
 * sorted first. They are the same physical disc either way, so what it is
 * really picking between is two descriptions of it, and it prefers the better
 * documented one.
 */
export async function findReleaseByBarcode(barcode, year) {
  const data = await wsFetch('/release', { query: barcodeQuery(barcode), limit: '10' });
  const best = pickBestRelease(data.releases, year);
  return best ? best.id || null : null;
}

/**
 * Flatten one known release's tracks, fetched with its recordings attached.
 * Null when MusicBrainz has the release but no usable tracklist for it — a
 * pressing catalogued off a sleeve, with no recordings linked to its tracks.
 *
 * The one-request cousin of tracksForReleaseGroup: there is no pressing to pick
 * here, because the caller already knows which one it wants.
 */
export async function tracksForRelease(mbid) {
  const release = await wsFetch(`/release/${mbid}`, { inc: 'recordings' });
  const out = flattenTracks(release);
  return out.length ? out : null;
}


/* ---------- The two-step lookup ----------
   Artist + title → release group → the tracks of one release inside it. Both
   steps live here so both pages get the same answer: the grid page keeps what
   comes back in localStorage, the labels page keeps nothing, and that
   difference has no business inside the lookup. Nothing below reads or writes
   a cache, and the `year` both steps take is a 4-digit number or null — each
   caller already has one, so neither re-parses a sheet cell here. */

// A release group's 4-digit first-release year, or null when MB has no date.
function groupYear(rg) {
  return parseInt((rg['first-release-date'] || '').slice(0, 4), 10) || null;
}

// Titles compared the way a person would: case, spacing and punctuation are
// noise, the words are the title.
export function normalizeTitle(str) {
  return String(str || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/**
 * Score a release group from a search result against the disc we're holding.
 *
 * MusicBrainz's own relevance can't separate a record from the EP, single and
 * remix set that reuse its name — searching Amy Winehouse for "Back to Black"
 * returns the 2006 album, a 2006 remixes EP, a 2007 single and a B-sides EP,
 * several of them exact title matches — so relevance alone picked whichever
 * sorted first and the detail view showed three tracks for an eleven-track
 * record.
 *
 * Type carries the most weight, because a shelf of CDs is overwhelmingly
 * albums, and the year in the sheet is usually the *pressing* year rather than
 * the group's first release: "Back to Black" reissued in 2007 must not start
 * matching the 2007 single. So the year breaks ties between plausible records
 * instead of choosing on its own, and a disc that really is an EP or a single
 * wins on its title matching exactly where the album's doesn't.
 */
export function scoreReleaseGroup(rg, wantTitle, wantYear) {
  let score = 0;

  const primary = (rg['primary-type'] || '').toLowerCase();
  if (primary === 'album') score += 100;
  else if (primary === 'ep') score += 30;

  // The disc's own name, not a longer title that merely contains it —
  // "Back to Black" is not "Back to Black: B-Sides" or "Frank & Back to Black".
  if (wantTitle && normalizeTitle(rg.title) === wantTitle) score += 90;

  const rgYear = groupYear(rg);
  if (wantYear && rgYear) {
    const diff = Math.abs(rgYear - wantYear);
    // Exact wins; a pressing a few years off the original still counts for
    // something; a decade away contributes nothing either way.
    score += diff === 0 ? 60 : Math.max(0, 45 - diff * 6);
  }

  // Compilations, live records and remix sets are their own titles; when one
  // shares a name with the studio album, the studio album is the likelier disc.
  if ((rg['secondary-types'] || []).length) score -= 25;

  score += (rg.score || 0) / 100; // MB's own relevance as a tiebreaker.
  return score;
}

/**
 * Query MusicBrainz for the release group that best matches an artist + title
 * and return its MBID, or null when the search comes back empty. `year` is the
 * disc's year as a number, or null when it isn't known.
 *
 * We search by artist + release title, then choose among the matches with
 * scoreReleaseGroup — MusicBrainz sorts by text relevance, which doesn't know
 * which "Back to Black" is on the shelf. Throws if the request itself fails,
 * which is the caller's cue that it learned nothing rather than that there's
 * nothing to learn.
 */
export async function findReleaseGroup({ artist, title, year }) {
  // Lucene-style query: quote the values and escape embedded quotes.
  const query = `artist:"${escapeLucene(artist)}" AND releasegroup:"${escapeLucene(title)}"`;
  // Enough candidates that the album and its same-named EP, single and
  // compilation are all in hand to choose between. Still one request.
  const data = await wsFetch('/release-group', { query, limit: '10' });

  const groups = data['release-groups'] || [];
  if (groups.length === 0) return null;

  const wantTitle = normalizeTitle(title);
  const best = groups
    .slice()
    .sort((a, b) =>
      scoreReleaseGroup(b, wantTitle, year) - scoreReleaseGroup(a, wantTitle, year))[0];
  return best.id || null;
}

/**
 * Browse the releases in a release group, with their recordings, pick the one
 * that best matches the disc on the shelf, and flatten its tracks. Null when
 * the group holds nothing usable.
 *
 * A release group holds every pressing of a title — vinyl, cassette, promos,
 * deluxe reissues with a second disc of B-sides — and their running orders are
 * not interchangeable, so the choice goes through pickBestRelease above:
 * official CD pressings first, then the year closest to the sheet's. One
 * request either way; the recordings just come back for all of them.
 */
export async function tracksForReleaseGroup(mbid, year) {
  const data = await wsFetch('/release', {
    'release-group': mbid,
    inc: 'recordings',
    limit: '25',
  });

  const release = pickBestRelease(data.releases, year);
  if (!release) return null;

  const out = flattenTracks(release);
  return out.length ? out : null;
}

