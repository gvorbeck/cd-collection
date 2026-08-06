/* ============================================================
   art.js — cover art and tracklists from MusicBrainz
   ------------------------------------------------------------
   For discs with no Art URL of their own, find a cover:
     1. Ask MusicBrainz for the best-matching release group
        (artist + title).
     2. Fetch that group's front image from the Cover Art Archive.
   The same release-group id then buys a tracklist for the detail
   view, so both caches live here together.

   Results — hits AND misses — are cached in localStorage, and both
   caches are read before anything touches the network: the point is
   that a disc is looked up once per browser, ever. Lookups are
   triggered lazily by an IntersectionObserver in render.js, so only
   covers actually scrolled to are ever requested.
   ============================================================ */
import { CONFIG } from './config.js';
import { readStore, writeStore } from './util.js';
// The throttle lives in musicbrainz.js, shared with the labels page: MB's
// 1/sec rule is per client, and this page and that one are the same client.
// Cache hits never enter the queue, so browsing cached discs stays instant.
import { throttledFetch, escapeLucene } from './musicbrainz.js';


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
  return `${norm(disc.artist)}|${norm(disc.title)}`;
}


// --- resolution ---------------------------------------------------------
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

  // In-flight de-dupe: if this disc is already resolving (e.g. its card and the
  // detail view both asked), reuse the same promise.
  if (disc._artPromise) return disc._artPromise;

  disc._artPromise = (async () => {
    let url = null;
    try {
      const mbid = await resolveReleaseGroupMbid(disc);
      if (mbid) {
        url = `${CONFIG.MUSICBRAINZ.CAA_URL}/${mbid}/front-${CONFIG.MUSICBRAINZ.CAA_SIZE}`;
      }
    } catch (err) {
      // Network/parse failure: treat as a miss for now, but DON'T cache it as a
      // permanent miss — a transient failure shouldn't poison the disc forever.
      disc._artPromise = null;
      return null;
    }
    // Cache the settled outcome (real URL, or a permanent miss sentinel).
    artCache[key] = url || ART_MISS;
    persistArtCache();
    return url;
  })();

  return disc._artPromise;
}

/**
 * The release-group MBID for a disc, or null if MusicBrainz doesn't know it.
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
      disc._mbid = await findReleaseGroupMbid(disc);
      return disc._mbid;
    } catch (err) {
      // Transient failure — clear the promise so a later attempt can retry.
      disc._mbidPromise = null;
      return null;
    }
  })();

  return disc._mbidPromise;
}

// Pull the release-group MBID back out of a Cover Art Archive URL.
export function mbidFromCaaUrl(url) {
  const match = /release-group\/([0-9a-f-]{36})\//i.exec(url || '');
  return match ? match[1] : null;
}

/**
 * Query MusicBrainz for the release group that best matches this disc and
 * return its MBID, or null. We search by artist + release title and take the
 * top-scored result; MusicBrainz sorts by relevance.
 */
async function findReleaseGroupMbid(disc) {
  // Lucene-style query: quote the values and escape embedded quotes.
  const q = `artist:"${escapeLucene(disc.artist)}" AND releasegroup:"${escapeLucene(disc.title)}"`;
  const params = new URLSearchParams({
    query: q,
    fmt: 'json',
    limit: '3',
    // Identify the app per MusicBrainz etiquette (can't set User-Agent header
    // from a browser; the app= param is the sanctioned alternative).
    app: CONFIG.MUSICBRAINZ.APP_IDENTITY,
  });
  const url = `${CONFIG.MUSICBRAINZ.SEARCH_URL}?${params.toString()}`;

  const res = await throttledFetch(url);
  if (!res.ok) throw new Error(`MusicBrainz ${res.status}`);
  const data = await res.json();

  const groups = data['release-groups'] || [];
  if (groups.length === 0) return null;
  return groups[0].id || null;
}


/* ============================================================
   4c. Tracklists
   ============================================================
   The sheet stores where a disc *is*, not what's on it. MusicBrainz knows the
   latter, so the detail view fills it in on demand: resolve the release group
   (usually already known from the cover-art lookup), browse one release from
   it with recordings included, and flatten every medium's tracks in order.

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
 * when MusicBrainz doesn't have it). Returns null when nothing was found.
 */
export async function resolveTracklist(disc) {
  const mbid = await resolveReleaseGroupMbid(disc);
  if (!mbid) return null;

  const hit = tracksCache[mbid];
  if (hit) {
    // Touch it so the LRU eviction keeps the discs actually being browsed.
    hit.at = Date.now();
    persistTracksCache();
    return hit.t.map(([title, length]) => ({ title, length }));
  }

  if (disc._tracksPromise) return disc._tracksPromise;

  disc._tracksPromise = (async () => {
    try {
      const tracks = await fetchTracklist(mbid);
      if (tracks && tracks.length) {
        tracksCache[mbid] = { t: tracks.map((t) => [t.title, t.length]), at: Date.now() };
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

/**
 * Browse one release from a release group, with its recordings, and flatten
 * the tracks. A release group can hold many releases (reissues, regional
 * pressings); any of them gives essentially the same running order, so we take
 * the first rather than spending extra throttled requests choosing.
 */
async function fetchTracklist(mbid) {
  const params = new URLSearchParams({
    'release-group': mbid,
    inc: 'recordings',
    fmt: 'json',
    limit: '1',
    app: CONFIG.MUSICBRAINZ.APP_IDENTITY,
  });
  const res = await throttledFetch(`${CONFIG.MUSICBRAINZ.RELEASE_URL}?${params.toString()}`);
  if (!res.ok) throw new Error(`MusicBrainz ${res.status}`);
  const data = await res.json();

  const release = (data.releases || [])[0];
  if (!release) return null;

  const out = [];
  (release.media || []).forEach((medium) => {
    (medium.tracks || []).forEach((track) => {
      const title = track.title || (track.recording && track.recording.title) || '';
      if (!title) return;
      const length = track.length || (track.recording && track.recording.length) || 0;
      out.push({ title, length });
    });
  });
  return out.length ? out : null;
}
