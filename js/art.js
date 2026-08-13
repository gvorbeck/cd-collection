/* ============================================================
   art.js — cover art and tracklists from MusicBrainz
   ------------------------------------------------------------
   For discs with no Art URL of their own, find a cover:
     1. Ask MusicBrainz for the best-matching release group
        (artist + title).
     2. Fetch that group's front image from the Cover Art Archive.
   The same release-group id then buys a tracklist for the detail
   view, so both caches live here together.

   A disc whose sheet row carries a Barcode skips step 1: the
   barcode names one pressing, so the archive is asked for that
   release rather than for the group it belongs to, and the
   tracklist comes off the same release. Both are id lookups from
   there on, and everything below this line — the caches, the
   offline bail, the retry ceiling — treats the two the same way,
   which is why they resolve through one function rather than two.

   Results — hits AND misses — are cached in localStorage, and both
   caches are read before anything touches the network: the point is
   that a disc is looked up once per browser, ever. Lookups are
   triggered lazily by an IntersectionObserver in render.js, so only
   covers actually scrolled to are ever requested.
   ============================================================ */
import { CONFIG } from './config.js';
import { readStore, writeStore } from './util.js';
// The lookup itself lives in musicbrainz.js, shared with the labels page, and
// so does the throttle behind it: MB's 1/sec rule is per client, and this page
// and that one are the same client. What's left here is the caching layer over
// it — cache hits never enter the queue, so browsing cached discs stays instant.
import {
  findReleaseByBarcode,
  findReleaseGroup,
  tracksForRelease,
  tracksForReleaseGroup,
} from './musicbrainz.js';


// --- localStorage cache -------------------------------------------------
// Maps a normalized "artist|title" key → a CAA image URL, or the MISS
// sentinel when a prior lookup found nothing (so we don't re-query known
// misses on every visit). Loaded once; written through on each update.
const ART_MISS = '\u0000miss'; // sentinel that can't collide with a real URL
// Written as an escape, not a literal NUL: a raw NUL byte makes git treat
// this file as binary and makes grep skip it silently.
export let artCache = readStore(CONFIG.MUSICBRAINZ.CACHE_KEY);

function persistArtCache() {
  writeStore(CONFIG.MUSICBRAINZ.CACHE_KEY, artCache);
}

// Stable cache key for a disc. Lowercased + whitespace-collapsed so trivial
// formatting differences don't cause misses.
export function artCacheKey(disc) {
  const norm = (s) => s.toLowerCase().replace(/\s+/g, ' ').trim();
  const key = `${norm(disc.artist)}|${norm(disc.title)}`;
  // A barcode is part of the question, not a hint about it: the same artist and
  // title with one is asking for a different cover than the same pair without,
  // and must not be handed the answer to the other. Adding, correcting or
  // removing a barcode in the sheet therefore re-resolves that disc by itself,
  // with no cache version to bump.
  //
  // Appended only when there is one, which is what keeps that true of the disc
  // rather than of everybody's whole cache: a third field on every key would
  // have invalidated every entry in every browser the day this shipped.
  return disc.barcode ? `${key}|bc:${disc.barcode}` : key;
}

/**
 * The cover URL already cached for a disc, or null — read synchronously, with
 * no lookup started and nothing written. Both the grid and the dialog check
 * this before doing anything slower.
 *
 * It lives here, and not at the two call sites, because here it can test
 * against ART_MISS itself. The callers can't: the sentinel is module-local on
 * purpose (a copy of it elsewhere goes stale the day it changes), so each of
 * them was left guessing at the shape of a *hit* instead — the grid looked for
 * an MBID in the path, the dialog for a leading `https?:` — and those two
 * guesses disagree about any cached URL that isn't a Cover Art Archive one.
 * Same question, two answers, two files: harmless right up until it isn't.
 */
export function cachedCoverArt(disc) {
  const cached = artCache[artCacheKey(disc)];
  return !cached || cached === ART_MISS ? null : cached;
}


// --- resolution ---------------------------------------------------------

// What a lookup that *failed* resolves to, as distinct from one that finished
// and found nothing. Only the second is a fact about the disc worth keeping: a
// dropped connection or a 503 must never be written as ART_MISS, because sw.js
// sends musicbrainz.org straight to the network — so a single offline browse
// would permanently mark every disc it touched as having no cover, recoverable
// only by bumping CACHE_KEY or clearing localStorage by hand. A Symbol so it
// can't be confused with an MBID, and module-local so it never escapes: both
// consumers below turn it back into a plain null.
const LOOKUP_FAILED = Symbol('mb-lookup-failed');

// How many times a lookup that actually reached the network may come back
// empty-handed before a disc is left on its placeholder for the session.
// Retries are what makes the offline story work at all — render.js keeps a card
// under the art observer while its question is still open, so scrolling past it
// after the connection returns asks again — but "keeps watching" with no
// ceiling means a MusicBrainz outage turns every scroll up and down the shelf
// into a fresh queue of doomed requests, which is the pile-up ART_DWELL_MS was
// added to prevent. Offline bails deliberately don't count against this: they
// cost no request and no throttle slot, so spending the budget on them would
// mean a long offline browse left the whole shelf permanently un-lookupable the
// moment it came back — the exact bug this ceiling is guarding the fix for.
const MAX_LOOKUP_ATTEMPTS = 3;

/**
 * Is this disc's cover-art question closed?
 *
 * True once there's a cached outcome — a URL or a known miss — or once the
 * network attempts above have been spent. False means the last try taught us
 * nothing and asking again later is worth it, which is render.js's cue to leave
 * the card under the art observer instead of unobserving it after one go. The
 * two bail paths in resolveCoverArt below are exactly the cases that leave this
 * false, and exactly the cases that deserve another chance.
 */
export function artLookupSettled(disc) {
  if (Object.prototype.hasOwnProperty.call(artCache, artCacheKey(disc))) return true;
  return (disc._artTries || 0) >= MAX_LOOKUP_ATTEMPTS;
}

/**
 * Resolve a cover-art image URL for a disc that has no Art URL of its own.
 * Returns a Promise<string|null> — a CAA image URL, or null if none was found.
 * Cache-first; a real network lookup only happens on a cache miss.
 */
export async function resolveCoverArt(disc) {
  const key = artCacheKey(disc);

  // Cached outcome (URL or known-miss) → no network at all.
  if (Object.prototype.hasOwnProperty.call(artCache, key)) {
    const cached = artCache[key];
    return cached === ART_MISS ? null : cached;
  }

  // Nothing cached and the browser says there's no connection: this lookup can
  // only fail, and it would spend a full throttle slot doing it — ahead of the
  // disc scrolled to a second after the connection comes back. navigator.onLine
  // is unreliable in one direction only (true can still mean a captive portal
  // or a dead uplink), and false is the direction being trusted here. Nothing
  // is written and no promise is armed, so the disc is simply un-looked-up —
  // and artLookupSettled stays false for it, which is what keeps render.js's
  // observer on the card rather than retiring it over this non-answer. Dwell on
  // it again once the connection is back and it asks for real. That's also why
  // this file owns no 'online' listener: there's no latch here to release, only
  // a question nobody has answered yet.
  if (navigator.onLine === false) return null;

  // Out of tries — see MAX_LOOKUP_ATTEMPTS. Same shape as the bail above (no
  // write, no promise), but artLookupSettled reports this one as closed, so the
  // observer lets the card go and the shelf stops asking.
  if ((disc._artTries || 0) >= MAX_LOOKUP_ATTEMPTS) return null;

  // In-flight de-dupe: if this disc is already resolving (e.g. its card and the
  // detail view both asked), reuse the same promise.
  if (disc._artPromise) return disc._artPromise;

  disc._artPromise = (async () => {
    let url = null;
    try {
      const found = await resolveMbEntity(disc);
      if (found === LOOKUP_FAILED) {
        // The search never completed, so we learned nothing about this disc.
        // Falling through to the write below would record a dropped connection
        // as "MusicBrainz has no cover for this", forever. Clear the promise so
        // a later scroll past this card can try again — the card is still under
        // the observer, because artLookupSettled reads an unanswered question as
        // open too. This one did spend a request, so it costs a try.
        disc._artTries = (disc._artTries || 0) + 1;
        disc._artPromise = null;
        return null;
      }
      if (found) url = caaUrl(found);
    } catch (err) {
      // Network/parse failure: treat as a miss for now, but DON'T cache it as a
      // permanent miss — a transient failure shouldn't poison the disc forever.
      // Belt and braces: resolveMbEntity catches its own failures and reports
      // them as LOOKUP_FAILED above, so nothing is expected to land here.
      // Counts as a try for the same reason that path does.
      disc._artTries = (disc._artTries || 0) + 1;
      disc._artPromise = null;
      return null;
    }
    // Cache the settled outcome: a real URL, or the miss sentinel — which now
    // means only that MusicBrainz answered and had no release group to offer.
    artCache[key] = url || ART_MISS;
    persistArtCache();
    return url;
  })();

  return disc._artPromise;
}

/**
 * The MusicBrainz thing a disc's cover and tracklist come from:
 *
 *   { kind: 'release',       id }  the pressing its Barcode names
 *   { kind: 'release-group', id }  the record its artist + title matches
 *   null                           MusicBrainz doesn't know this disc
 *   LOOKUP_FAILED                  the question never got an answer
 *
 * A barcode is tried first and is *not* binding. If MusicBrainz has no release
 * carrying it, this falls through to the artist + title search rather than
 * giving up, so the column can only ever improve a disc or leave it exactly as
 * it was — a barcode MB has never heard of costs one request and changes
 * nothing on screen. The alternative, treating a pin as all-or-nothing, turns a
 * typo into a disc that has lost its cover, and there is no worse way to
 * discover you mistyped a barcode than by a cover going missing.
 */
async function resolveMbEntity(disc) {
  if (disc.barcode) {
    const pinned = await resolvePinnedRelease(disc);
    if (pinned) return pinned; // an entity, or LOOKUP_FAILED — both are answers
  }
  const mbid = await resolveReleaseGroupMbid(disc);
  return mbid && mbid !== LOOKUP_FAILED ? { kind: 'release-group', id: mbid } : mbid;
}

// Where the Cover Art Archive keeps the front image of either kind of thing.
function caaUrl(found) {
  const base = found.kind === 'release'
    ? CONFIG.MUSICBRAINZ.CAA_RELEASE_URL
    : CONFIG.MUSICBRAINZ.CAA_URL;
  return `${base}/${found.id}/front-${CONFIG.MUSICBRAINZ.CAA_SIZE}`;
}

/**
 * The release a disc's Barcode names, as an entity for resolveMbEntity above —
 * or null meaning "no pin to be had, carry on with the search", or LOOKUP_FAILED.
 *
 * Shaped like resolveReleaseGroupMbid below, for the same reasons: an id costs
 * a throttled search, so it's resolved once per disc, remembered on the disc,
 * and read back out of a cached Cover Art Archive URL for free on later visits.
 *
 * The third check is the one that isn't in the other function. A *group* URL
 * cached under this disc's key is last visit's answer to the barcode: the pin
 * found nothing, and the search stood in for it. Without that check, a barcode
 * MusicBrainz doesn't have would spend a request rediscovering that on every
 * single visit, forever — the fallback above is what makes it a real risk,
 * because nothing on screen would ever look wrong.
 */
async function resolvePinnedRelease(disc) {
  if (disc._releaseMbid) return { kind: 'release', id: disc._releaseMbid };

  const cached = disc._resolvedArt || artCache[artCacheKey(disc)];
  if (cached === ART_MISS) return null;
  const fromArt = mbidFromCaaUrl(cached, 'release');
  if (fromArt) {
    disc._releaseMbid = fromArt;
    return { kind: 'release', id: fromArt };
  }
  if (mbidFromCaaUrl(cached)) return null; // settled already — see above

  if (disc._releasePromise) return disc._releasePromise;

  disc._releasePromise = (async () => {
    try {
      const id = await findReleaseByBarcode(disc.barcode, discYear(disc));
      disc._releaseMbid = id;
      // Null here is "MB has no release with this barcode", which is a real
      // answer and is kept: the promise stays resolved, so the search doesn't
      // run twice in a session, and the caller falls through to artist + title.
      return id ? { kind: 'release', id } : null;
    } catch (err) {
      // Same distinction resolveReleaseGroupMbid draws: a question that failed
      // is not a question answered "no". Clear the promise so a later attempt
      // can retry, and say so loudly enough that nothing writes it to the cache.
      disc._releasePromise = null;
      return LOOKUP_FAILED;
    }
  })();

  return disc._releasePromise;
}

/**
 * The release-group MBID for a disc, null if MusicBrainz doesn't know it, or
 * LOOKUP_FAILED if the question never got an answer — the two are the same
 * outcome on screen but opposite outcomes for the cache.
 *
 * This is the join point for everything that needs MusicBrainz: cover art, the
 * tracklist, and the "look it up" link all want the same id, and it costs a
 * throttled search to find. So it's resolved once per disc and shared, with
 * three chances to avoid the network entirely before making the call.
 */
async function resolveReleaseGroupMbid(disc) {
  if (disc._mbid) return disc._mbid;

  // The cover-art cache stores a Cover Art Archive URL, and that URL has the
  // release-group MBID in it — so a disc whose art resolved on a previous visit
  // already tells us the id for free.
  const cached = disc._resolvedArt || artCache[artCacheKey(disc)];
  if (cached === ART_MISS) return null; // a miss means no release group matched
  const fromArt = mbidFromCaaUrl(cached);
  if (fromArt) {
    disc._mbid = fromArt;
    return fromArt;
  }

  // In-flight de-dupe, so a card's art lookup and the detail view's tracklist
  // opening at the same moment share one search rather than racing.
  if (disc._mbidPromise) return disc._mbidPromise;

  disc._mbidPromise = (async () => {
    try {
      disc._mbid = await findReleaseGroup({
        artist: disc.artist,
        title: disc.title,
        year: discYear(disc),
      });
      return disc._mbid;
    } catch (err) {
      // Transient failure — clear the promise so a later attempt can retry, and
      // say *failed* rather than null: a null here reads as "no such release
      // group" and gets written to the cache as a permanent miss.
      disc._mbidPromise = null;
      return LOOKUP_FAILED;
    }
  })();

  return disc._mbidPromise;
}

/**
 * Pull an MBID back out of a Cover Art Archive URL — by default the
 * release-group one, which is the shape most of these URLs have.
 *
 * `kind` is what the caller is asking about, and a URL of the other kind
 * answers null rather than handing over the id it does have. The two are both
 * 36 hex characters and neither works in the other's place: a release id in a
 * /release-group/ link is a 404 on musicbrainz.org and a blank cover from the
 * archive. The two patterns can't be confused for each other either, since
 * "/release-group/" doesn't contain "/release/".
 */
export function mbidFromCaaUrl(url, kind = 'release-group') {
  const match = new RegExp(`/${kind}/([0-9a-f-]{36})/`, 'i').exec(url || '');
  return match ? match[1] : null;
}

// The disc's year as a number, or null when the sheet leaves it blank. Both
// halves of the lookup want it: it tells same-titled records apart, and then
// which pressing of the one we settled on.
function discYear(disc) {
  return parseInt(String((disc && disc.year) || '').slice(0, 4), 10) || null;
}


/* ============================================================
   4c. Tracklists
   ============================================================
   The sheet stores where a disc *is*, not what's on it. MusicBrainz knows the
   latter, so the detail view fills it in on demand: resolve the release group
   (usually already known from the cover-art lookup), browse one release from
   it with recordings included, and flatten every medium's tracks in order.
   For a disc pinned by Barcode there is no browsing and no picking — the
   release is already the answer, and its recordings are fetched straight.

   Fetched only when a disc is actually opened, throttled with every other
   MusicBrainz call, and cached in localStorage — so a disc you revisit shows
   its tracklist instantly and offline.
*/

// mbid → { t: [[title, lengthMs], …], at: <last used ms> }
let tracksCache = readStore(CONFIG.MUSICBRAINZ.TRACKS_CACHE_KEY);

/**
 * Persist the tracklist cache, evicting the least-recently-used entries first
 * when it's over the cap. Tracklists are far bigger than the cover-art cache's
 * one-line entries, and they share the same origin-wide storage budget.
 */
function persistTracksCache() {
  const keys = Object.keys(tracksCache);
  const max = CONFIG.MUSICBRAINZ.TRACKS_CACHE_MAX;
  if (keys.length > max) {
    keys.sort((a, b) => (tracksCache[a].at || 0) - (tracksCache[b].at || 0))
      .slice(0, keys.length - max)
      .forEach((k) => { delete tracksCache[k]; });
  }
  writeStore(CONFIG.MUSICBRAINZ.TRACKS_CACHE_KEY, tracksCache);
}

/**
 * Tracklist for a disc as an array of { title, length } (length in ms, or 0
 * when MusicBrainz doesn't have it), plus `artist` on the tracks credited to
 * somebody other than the release itself — see flattenTracks. Returns null when
 * nothing was found.
 */
export async function resolveTracklist(disc) {
  const found = await resolveMbEntity(disc);
  // A failed lookup is a truthy Symbol, not an entity — there's nothing to
  // browse and nothing worth writing down, so the next open of this disc tries
  // again.
  if (!found || found === LOOKUP_FAILED) return null;

  // A release group is keyed by group *and* year: which pressing within the
  // group we pick depends on the year, so two discs sharing a release group but
  // not a year — an original and a reissue with bonus tracks — mustn't share a
  // cache entry. A pinned release needs no year in its key, because choosing
  // the pressing is the one thing the barcode has already done. Prefixed so the
  // two kinds of key can't be mistaken for each other by a future reader; the
  // ids themselves are UUIDs and would never actually collide.
  const wantYear = discYear(disc);
  const key = found.kind === 'release'
    ? `rel:${found.id}`
    : `${found.id}|${wantYear || ''}`;
  const hit = tracksCache[key];
  if (hit) {
    // Touch it so the LRU eviction keeps the discs actually being browsed.
    hit.at = Date.now();
    persistTracksCache();
    // The third slot is only written for a track that has an artist to name, so
    // most tuples are still two long and the key stays off the object here for
    // the same reason flattenTracks leaves it off: callers test `if (t.artist)`.
    return hit.t.map(([title, length, artist]) => (
      artist ? { title, length, artist } : { title, length }
    ));
  }

  if (disc._tracksPromise) return disc._tracksPromise;

  disc._tracksPromise = (async () => {
    try {
      const tracks = found.kind === 'release'
        ? await tracksForRelease(found.id)
        : await tracksForReleaseGroup(found.id, wantYear);
      if (tracks && tracks.length) {
        tracksCache[key] = {
          // Tuples, not objects, because this is 250 tracklists in a shared 5MB
          // localStorage budget and the key names would outweigh the values.
          // The artist slot is appended only when there is one — a compilation
          // pays for it on every line, an ordinary album on none.
          t: tracks.map((t) => (t.artist ? [t.title, t.length, t.artist] : [t.title, t.length])),
          at: Date.now(),
        };
        persistTracksCache();
      }
      return tracks;
    } catch (err) {
      // Don't cache a transient failure; allow a retry on the next open.
      disc._tracksPromise = null;
      return null;
    }
  })();

  return disc._tracksPromise;
}
