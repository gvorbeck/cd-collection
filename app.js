/* ============================================================
   CD COLLECTION — app.js
   ------------------------------------------------------------
   Structure (kept deliberately separated so each can change alone):
     1. CONFIG          — presentation settings live here
                          (the SHEET and its columns live in collection.js)
     2. Utilities       — tiny shared helpers
     3. Color           — hashing, brightness, cover sampling
     4. Placeholder art — generated covers for disc with no image
     5. Rendering       — stats, pills, cards, detail view
     6. Filtering       — search + genre/tag pills + shuffle
     7. URL state       — shareable filters + per-disc deep links
     8. Init            — wire it all together

   Data loading is NOT here: collection.js owns the sheet URL, the
   column names, and the CSV → disc-object parsing, because the
   stats page reads the same collection and must agree on all of it.
   ============================================================ */


/* ============================================================
   1. CONFIG  — presentation settings
   ------------------------------------------------------------
   Sheet URL, column names, and blank-cell fallbacks are NOT here —
   they're in collection.js, shared with the stats page.
   ============================================================ */
const CONFIG = {
  // Palette used to color generated placeholder covers.
  // Any disc without art gets a color hashed from its artist name,
  // so one artist's untitled discs read as a set.
  // The first five mirror the accent vars in styles.css (--brick, --mustard,
  // --teal, --orange, --forest); keep them in sync if you retune the theme.
  // The last three (plum, ink blue, raspberry) are placeholder-only extras.
  PLACEHOLDER_PALETTE: [
    '#c8452f', // brick red     (--brick)
    '#e0a51f', // mustard       (--mustard)
    '#2f8f8a', // teal          (--teal)
    '#d9711f', // burnt orange  (--orange)
    '#3e6b3a', // forest green  (--forest)
    '#7a4ea3', // plum          (placeholder-only)
    '#3866a8', // ink blue      (placeholder-only)
    '#b23a6d', // raspberry     (placeholder-only)
  ],

  // Neutral tint used for card shadows when we can't sample a cover color.
  // Mirrors --shadow-neutral in styles.css and is overwritten from that CSS
  // var at startup (hydrateThemeConstants), so the stylesheet stays canonical;
  // this literal is just the pre-hydration fallback.
  NEUTRAL_SHADOW: '#3a3128',

  // How many genres the stats card shows before collapsing the rest behind a
  // "show more" toggle. The top N (by count) stay visible.
  STATS_GENRES_VISIBLE: 3,

  // Automatic cover-art lookup via MusicBrainz + the Cover Art Archive.
  // Only used for discs with a BLANK Art URL — an explicit Art URL in the sheet
  // always wins. Lookups fire lazily (only when a card scrolls on-screen) and
  // are cached in localStorage, so we stay well under MusicBrainz's ~1 req/sec
  // limit and never look a disc up more than once per browser.
  MUSICBRAINZ: {
    // MusicBrainz asks every client to identify itself with a descriptive
    // User-Agent (app name/version + contact). Sent via a query param since
    // browsers can't set User-Agent on fetch; MB reads either.
    APP_IDENTITY: MB.APP_IDENTITY,
    // Release-group text search endpoint.
    SEARCH_URL: `${MB.WS_BASE}/release-group`,
    // Release browse endpoint — used to pull a tracklist for a release group.
    RELEASE_URL: `${MB.WS_BASE}/release`,
    // Cover Art Archive front-image endpoint (CORS-enabled + canvas-readable).
    // {mbid} is a release-group id; size is one of 250 / 500 / 1200.
    CAA_URL: 'https://coverartarchive.org/release-group',
    CAA_SIZE: 500,
    // localStorage key + schema version. Bump the version to invalidate the
    // whole cache if the lookup logic changes.
    CACHE_KEY: 'cdc:art-cache:v1',
    // Cached tracklists, keyed by release-group MBID. Capped because these are
    // much bigger than a cover URL and localStorage is a shared ~5MB budget —
    // past the cap the least-recently-fetched entries are dropped.
    TRACKS_CACHE_KEY: 'cdc:tracks:v1',
    TRACKS_CACHE_MAX: 250,
  },
};


/* ============================================================
   2. Utilities
   ============================================================ */

// Helpers shared with the stats page live in collection.js; pull the ones this
// page uses into local names so call sites stay short.
const { el, formatLocation } = Collection;

// Whether the user prefers reduced motion (checked live, not cached).
function reducedMotion() {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

// Grab an element by id (short alias).
const $ = (id) => document.getElementById(id);

// True for a "#rrggbb" string (the only color form we store/blend).
function isHex6(str) {
  return /^#[0-9a-f]{6}$/i.test(str);
}

// Read a CSS custom property off :root (trimmed). Lets the stylesheet stay the
// single source of truth for shared colors instead of duplicating hexes in JS.
function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}


/* ============================================================
   3. The collection
   ============================================================
   Loading and parsing live in collection.js (shared with the stats
   page). This page just holds the result. */

// The full, immutable-ish collection once loaded.
let DISCS = [];


/* ============================================================
   4. Color: hashing, brightness, cover sampling
   ============================================================ */

// Deterministic string hash (djb2-ish). Same input → same number.
function hashString(str) {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash + str.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

// Pick a stable palette color for an artist name.
function colorForArtist(artist) {
  const palette = CONFIG.PLACEHOLDER_PALETTE;
  return palette[hashString(artist) % palette.length];
}

// Parse "#rrggbb" → {r,g,b}.
function hexToRgb(hex) {
  const h = hex.replace('#', '');
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16),
  };
}

// Perceived brightness (0–255). Used to choose black vs white text.
function brightness({ r, g, b }) {
  return (r * 299 + g * 587 + b * 114) / 1000;
}

// Given a background color, return readable text color (black or white).
function readableTextOn(rgb) {
  return brightness(rgb) > 140 ? '#1a1a1a' : '#ffffff';
}

/**
 * Sample the dominant color from a loaded cover image.
 * We draw it small onto a hidden canvas and average the pixels, skipping
 * near-white and near-black pixels (which tend to be borders/letterboxing)
 * and weighting toward more saturated pixels so the tint stays lively.
 * Requires the image to be CORS-readable (crossOrigin="anonymous").
 * Returns an "#rrggbb" string, or null if the canvas can't be read.
 */
function sampleDominantColor(img) {
  try {
    const size = 16; // tiny is plenty for an average
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, size, size);

    const { data } = ctx.getImageData(0, 0, size, size);
    let r = 0, g = 0, b = 0, weightTotal = 0;

    for (let i = 0; i < data.length; i += 4) {
      const pr = data[i], pg = data[i + 1], pb = data[i + 2], pa = data[i + 3];
      if (pa < 125) continue; // skip transparent pixels

      const max = Math.max(pr, pg, pb);
      const min = Math.min(pr, pg, pb);
      // Skip near-white and near-black — usually background, not the "color".
      if (max > 245 && min > 245) continue;
      if (max < 12) continue;

      // Weight by saturation so vivid pixels count more than muddy ones.
      const saturation = max === 0 ? 0 : (max - min) / max;
      const weight = 1 + saturation * 2;

      r += pr * weight;
      g += pg * weight;
      b += pb * weight;
      weightTotal += weight;
    }

    if (weightTotal === 0) return null; // nothing usable

    r = Math.round(r / weightTotal);
    g = Math.round(g / weightTotal);
    b = Math.round(b / weightTotal);
    return rgbToHex(r, g, b);
  } catch (err) {
    // Tainted canvas or any other failure → caller falls back to neutral.
    return null;
  }
}

function rgbToHex(r, g, b) {
  const h = (n) => n.toString(16).padStart(2, '0');
  return `#${h(r)}${h(g)}${h(b)}`;
}


/* ============================================================
   Persistent caches: localStorage, read and written as JSON
   ============================================================
   Two caches live here — cover art and tracklists — and both want the same
   thing: read a JSON blob at startup, write it back on every update, and never
   let a failure matter. localStorage can be disabled outright (private mode,
   a locked-down profile), full, or holding something a previous version wrote
   that no longer parses. In all three cases the right answer is the same: fall
   back to an in-memory object and carry on with a slower session, not a broken
   one. That's why nothing below rethrows.
*/

/** Parse a stored JSON object, or `{}` if it's missing, corrupt, or blocked. */
function readStore(key) {
  try {
    const raw = localStorage.getItem(key);
    const parsed = raw ? JSON.parse(raw) : null;
    // A stored array or scalar would break every `cache[k]` read below, so only
    // a real object counts as a hit.
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (err) {
    return {};
  }
}

/** Write a JSON object back. Silent on failure — see the note above. */
function writeStore(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (err) {
    // Out of quota or unavailable — keep going with the in-memory copy.
  }
}


/* ============================================================
   4b. Cover-art lookup: MusicBrainz → Cover Art Archive
   ============================================================
   For discs with no Art URL, find a cover automatically:
     1. Ask MusicBrainz for the best-matching release group (artist + title).
     2. Fetch that group's front image from the Cover Art Archive.
   Results (hits AND misses) are cached in localStorage, and every network
   lookup goes through a ~1/sec throttle to respect MusicBrainz's rate limit.
   Lookups are triggered lazily by an IntersectionObserver (see rendering), so
   only covers you actually scroll to are ever requested.
*/

// --- localStorage cache -------------------------------------------------
// Maps a normalized "artist|title" key → a CAA image URL, or the MISS
// sentinel when a prior lookup found nothing (so we don't re-query known
// misses on every visit). Loaded once; written through on each update.
const ART_MISS = '\u0000miss'; // sentinel that can't collide with a real URL
// Written as an escape, not a literal NUL: a raw NUL byte makes git treat
// this file as binary and makes grep skip it silently.
let artCache = readStore(CONFIG.MUSICBRAINZ.CACHE_KEY);

function persistArtCache() {
  writeStore(CONFIG.MUSICBRAINZ.CACHE_KEY, artCache);
}

// Stable cache key for a disc. Lowercased + whitespace-collapsed so trivial
// formatting differences don't cause misses.
function artCacheKey(disc) {
  const norm = (s) => s.toLowerCase().replace(/\s+/g, ' ').trim();
  return `${norm(disc.artist)}|${norm(disc.title)}`;
}

// The throttle itself lives in musicbrainz.js, shared with the labels page —
// MB's 1/sec rule is per client, and this page and that one are the same
// client. Cache hits never enter the queue, so browsing cached discs stays
// instant.
const throttledMbFetch = MB.throttledFetch;

// --- resolution ---------------------------------------------------------
/**
 * Resolve a cover-art image URL for a disc that has no Art URL of its own.
 * Returns a Promise<string|null> — a CAA image URL, or null if none was found.
 * Cache-first; a real network lookup only happens on a cache miss.
 */
async function resolveCoverArt(disc) {
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
function mbidFromCaaUrl(url) {
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
  const q = `artist:"${MB.escapeLucene(disc.artist)}" AND releasegroup:"${MB.escapeLucene(disc.title)}"`;
  const params = new URLSearchParams({
    query: q,
    fmt: 'json',
    limit: '3',
    // Identify the app per MusicBrainz etiquette (can't set User-Agent header
    // from a browser; the app= param is the sanctioned alternative).
    app: CONFIG.MUSICBRAINZ.APP_IDENTITY,
  });
  const url = `${CONFIG.MUSICBRAINZ.SEARCH_URL}?${params.toString()}`;

  const res = await throttledMbFetch(url);
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
async function resolveTracklist(disc) {
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
  const res = await throttledMbFetch(`${CONFIG.MUSICBRAINZ.RELEASE_URL}?${params.toString()}`);
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

// Milliseconds → "m:ss". Shared with the labels page, which formats the same
// MusicBrainz lengths onto printed spines.
const formatDuration = MB.formatDuration;


/* ============================================================
   5. Placeholder cover generation
   ============================================================
   A lot of discs are home-burned with no art. Rather than an empty box,
   we draw a designed cover: a solid hashed color block, the title in bold
   centered type (auto black/white for contrast), the catalog number as a
   small archival mark, and the same paper grain as everything else.
   Returns a data URL usable as an <img> src.
*/
function generatePlaceholderCover(disc) {
  // Cache per disc — the canvas + per-pixel grain is not free, and the grid
  // re-renders on every filter change.
  if (disc._placeholderSrc) return disc._placeholderSrc;

  const S = 400; // render at 400px square, scaled by CSS
  const canvas = document.createElement('canvas');
  canvas.width = S;
  canvas.height = S;
  const ctx = canvas.getContext('2d');

  // 1. Solid color block, stable per-artist.
  const bgHex = colorForArtist(disc.artist);
  const bgRgb = hexToRgb(bgHex);
  ctx.fillStyle = bgHex;
  ctx.fillRect(0, 0, S, S);

  const textColor = readableTextOn(bgRgb);

  // 2. A thin inner rule frame, archival-card style.
  ctx.strokeStyle = textColor;
  ctx.globalAlpha = 0.5;
  ctx.lineWidth = 2;
  ctx.strokeRect(18, 18, S - 36, S - 36);
  ctx.globalAlpha = 1;

  // 3. Catalog number as a small mark, top-left inside the frame.
  if (disc.numberLabel) {
    ctx.fillStyle = textColor;
    ctx.font = '700 20px "Space Mono", monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText(`#${disc.numberLabel}`, 34, 34);
  }

  // 4. Title, bold and centered, wrapped to fit.
  ctx.fillStyle = textColor;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  drawWrappedTitle(ctx, disc.title.toUpperCase(), S / 2, S / 2, S - 80, 44);

  // 5. Artist, small, under the title area toward the bottom.
  ctx.font = '400 18px "Space Mono", monospace';
  ctx.globalAlpha = 0.85;
  ctx.fillText(truncate(disc.artist, 28), S / 2, S - 44);
  ctx.globalAlpha = 1;

  // 6. Grain overlay so it matches the paper texture of the page.
  applyGrain(ctx, S, S);

  disc._placeholderSrc = canvas.toDataURL('image/png');
  return disc._placeholderSrc;
}

// Word-wrap a title into up to 4 centered lines around a vertical midpoint.
function drawWrappedTitle(ctx, text, cx, cy, maxWidth, lineHeight) {
  // Choose a font size that scales down for long titles.
  let fontSize = text.length > 22 ? 30 : 40;
  ctx.font = `700 ${fontSize}px "Anton", "Arial Narrow", sans-serif`;

  const words = text.split(/\s+/);
  const lines = [];
  let line = '';
  for (const word of words) {
    const test = line ? `${line} ${word}` : word;
    if (ctx.measureText(test).width > maxWidth && line) {
      lines.push(line);
      line = word;
    } else {
      line = test;
    }
  }
  if (line) lines.push(line);

  const shown = lines.slice(0, 4);
  const totalHeight = shown.length * lineHeight;
  let y = cy - totalHeight / 2 + lineHeight / 2;
  for (const l of shown) {
    ctx.fillText(l, cx, y);
    y += lineHeight;
  }
}

function truncate(str, max) {
  return str.length > max ? `${str.slice(0, max - 1)}…` : str;
}

// Sprinkle faint monochrome noise over a canvas region for a printed feel.
function applyGrain(ctx, w, h) {
  const grain = ctx.getImageData(0, 0, w, h);
  const d = grain.data;
  for (let i = 0; i < d.length; i += 4) {
    // small random +/- nudge to each channel
    const n = (Math.random() - 0.5) * 26;
    d[i]     = clamp8(d[i] + n);
    d[i + 1] = clamp8(d[i + 1] + n);
    d[i + 2] = clamp8(d[i + 2] + n);
  }
  ctx.putImageData(grain, 0, 0);
}

function clamp8(n) {
  return n < 0 ? 0 : n > 255 ? 255 : n;
}


/* ============================================================
   6. Rendering
   ============================================================ */

// Cached DOM references.
const dom = {};

function cacheDom() {
  dom.grid          = $('grid');
  dom.stateMsg      = $('state-msg');
  dom.statTotal     = $('stat-total');
  dom.statGenres    = $('stat-genres');
  dom.genrePills    = $('genre-pills');
  dom.tagPills      = $('tag-pills');
  dom.search        = $('search');
  dom.shuffle       = $('shuffle');
  dom.resultsCount  = $('results-count');
  dom.clearFilters  = $('clear-filters');
  dom.sort          = $('sort');
  dom.viewToggle    = $('view-toggle');
  dom.exportBtn     = $('export-csv');
  dom.liveRegion    = $('live-region');
  dom.detail        = $('detail');
  dom.detailClose   = $('detail-close');
  dom.detailCover   = $('detail-cover');
  dom.detailNumber  = $('detail-number');
  dom.detailTitle   = $('detail-title');
  dom.detailArtist  = $('detail-artist');
  dom.detailMeta    = $('detail-meta');
  dom.detailTags    = $('detail-tags');
  dom.detailNotes   = $('detail-notes');
  dom.detailLinks   = $('detail-links');
  dom.detailTracks  = $('detail-tracks');
  dom.body          = document.body;
}

// Announce something to screen readers via the polite live region. Discrete
// events (shuffle, export, view switch) go straight through — they're user
// actions, and one action deserves one announcement.
function announce(message) {
  // Any pending count would land on top of this one; drop it.
  clearTimeout(countAnnounceTimer);
  lastCountAnnounced = '';
  dom.liveRegion.textContent = message;
}

let countAnnounceTimer;
let lastCountAnnounced = '';

/**
 * Announce the result count — the one announcement that isn't tied to a
 * discrete action.
 *
 * The search box refilters every 120ms while you type, and a polite live region
 * rewritten that often is one a screen reader spends its whole time restarting:
 * you hear the first syllable of a dozen counts and the end of none. So wait for
 * typing to settle, and say nothing when the number didn't actually change —
 * three keystrokes that keep narrowing to the same 4 discs are one result.
 */
function announceCount(message) {
  clearTimeout(countAnnounceTimer);
  countAnnounceTimer = setTimeout(() => {
    if (message === lastCountAnnounced) return;
    lastCountAnnounced = message;
    dom.liveRegion.textContent = message;
  }, 700);
}

// Build the stats "data card": total + per-genre counts.
function renderStats(discs) {
  dom.statTotal.textContent = discs.length;

  // A Map, not a plain object: genres come from a spreadsheet anyone can type
  // into, and a genre literally named "constructor" or "__proto__" would
  // otherwise read back an inherited function instead of a count.
  const counts = new Map();
  for (const d of discs) counts.set(d.genre, (counts.get(d.genre) || 0) + 1);

  const ordered = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const visible = CONFIG.STATS_GENRES_VISIBLE;

  const rows = ordered.map(([genre, count], i) => {
    const li = document.createElement('li');
    // Genres past the top N start hidden; the toggle button reveals them.
    if (i >= visible) li.classList.add('is-collapsed');
    const dots = el('span', 'g-dots');
    dots.setAttribute('aria-hidden', 'true');
    // Built as nodes rather than an innerHTML string — every other renderer
    // here does, and it's the one construction that can't go wrong no matter
    // what the sheet contains.
    li.append(el('span', 'g-name', genre), dots, el('span', 'g-count', String(count)));
    return li;
  });

  // Only offer the toggle when there's something hidden to reveal.
  const hidden = ordered.length - visible;
  if (hidden > 0) rows.push(makeGenresToggle(hidden));

  dom.statGenres.replaceChildren(...rows);
}

// Build the "show more / show less" button that expands the collapsed genres.
// Toggling flips a class on the list and rewrites the button's label + ARIA
// state; the actual hiding is done in CSS via `.stats-genres li.is-collapsed`.
function makeGenresToggle(hiddenCount) {
  const btn = el('button', 'stats-genres-toggle');
  btn.type = 'button';
  btn.setAttribute('aria-expanded', 'false');

  const label = (expanded) =>
    expanded ? 'Show fewer' : `Show ${hiddenCount} more`;
  btn.textContent = label(false);

  btn.addEventListener('click', () => {
    const expanded = dom.statGenres.classList.toggle('is-expanded');
    btn.setAttribute('aria-expanded', String(expanded));
    btn.textContent = label(expanded);
  });

  const li = el('li', 'stats-genres-toggle-row');
  li.appendChild(btn);
  return li;
}

// Build the filter pill rails for genres and tags.
function renderPills(discs) {
  const genres = new Set();
  const tagCounts = new Map();
  for (const d of discs) {
    genres.add(d.genre);
    d.tags.forEach((t) => tagCounts.set(t, (tagCounts.get(t) || 0) + 1));
  }

  buildPillRail(dom.genrePills, [...genres].sort(), 'genre');

  // Tags go in popularity order, ties A–Z. The cloud shows one line by default,
  // so which tags win that line has to mean something — alphabetical would put
  // whatever happens to start with "a" ahead of the tag on half the shelf.
  const tags = [...tagCounts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([tag]) => tag);
  buildPillRail(dom.tagPills, tags, 'tag');
  buildTagToggle();

  // Hide the tags group heading area gracefully if there are no tags at all.
  dom.tagPills.closest('.filter-group').hidden = tags.length === 0;
}

function buildPillRail(rail, values, type) {
  rail.innerHTML = '';
  for (const value of values) {
    const btn = el('button', 'pill', value);
    btn.type = 'button';
    btn.setAttribute('aria-pressed', 'false');
    btn.dataset.filterType = type;
    btn.dataset.filterValue = value;
    rail.appendChild(btn);
  }
}

/**
 * The tag cloud's expand control, appended inside the cloud rather than under
 * it so it flows at the end of the visible line.
 */
function buildTagToggle() {
  const btn = el('button', 'pill-more');
  btn.type = 'button';
  btn.hidden = true;               // layoutTagCloud decides whether it's needed
  btn.setAttribute('aria-expanded', 'false');
  btn.addEventListener('click', () => {
    tagsExpanded = !tagsExpanded;
    layoutTagCloud();
    // Focus stays on a button whose label just changed under it; say why.
    announce(tagsExpanded ? 'Showing all tags.' : 'Showing the most common tags.');
  });
  dom.tagMore = btn;
  dom.tagPills.appendChild(btn);
}

/**
 * Decide how much of the tag cloud is on screen.
 *
 * Collapsed, it's one line: the pills are measured and greedily packed until
 * the next one wouldn't leave room for the toggle, and everything past that
 * gets `hidden` — the attribute, not a class, so the overflow leaves the tab
 * order instead of sitting invisible and still focusable.
 *
 * A pressed pill is never hidden, even if that spills onto a second line. An
 * active filter you can't see is one you can't turn off, and arriving on a
 * ?tag= deep link can press a pill well down the popularity order.
 *
 * Every width is read in one pass while the whole cloud is visible, so this
 * costs a single layout rather than one per pill.
 */
function layoutTagCloud() {
  const btn = dom.tagMore;
  if (!btn) return;

  const pills = [...dom.tagPills.querySelectorAll('.pill')];
  if (!pills.length) return;

  // Show everything first — widths are only measurable once laid out, and this
  // is also the finished expanded state.
  pills.forEach((pill) => { pill.hidden = false; });

  if (tagsExpanded) {
    btn.hidden = false;
    btn.setAttribute('aria-expanded', 'true');
    btn.textContent = 'Show fewer';
    return;
  }

  // Measure the toggle at its widest possible label, so the space reserved for
  // it can't come up short once the real count is known.
  btn.hidden = false;
  btn.textContent = `Show ${pills.length} more`;
  const btnWidth = btn.offsetWidth;

  const gap = parseFloat(getComputedStyle(dom.tagPills).columnGap) || 8;
  const avail = dom.tagPills.clientWidth;
  const widths = pills.map((pill) => pill.offsetWidth);

  let used = 0;
  let fit = 0;
  for (let i = 0; i < pills.length; i++) {
    const next = used + (i ? gap : 0) + widths[i];
    if (next + gap + btnWidth > avail) break;
    used = next;
    fit++;
  }

  pills.forEach((pill, i) => {
    pill.hidden = i >= fit && pill.getAttribute('aria-pressed') !== 'true';
  });

  const hidden = pills.reduce((n, pill) => n + (pill.hidden ? 1 : 0), 0);
  if (hidden === 0) {
    // Everything fit, or everything that didn't is pressed. Either way there's
    // nothing behind the toggle, so there's no toggle.
    btn.hidden = true;
    return;
  }
  btn.setAttribute('aria-expanded', 'false');
  btn.textContent = `Show ${hidden} more`;
}

/**
 * Render a set of disc cards into the grid.
 * Handles cover art vs generated placeholder, and kicks off async color
 * sampling for real art so the card shadow gets tinted once it loads.
 */
function renderCards(discs) {
  // Retire the cards we're about to discard. Two things have to happen here:
  // cancel any armed dwell timer, so a detached fly-by card can't fire a lookup
  // after the grid re-renders; and unobserve, because an IntersectionObserver
  // holds a STRONG reference to every target it was given. Dropping the node
  // out of the DOM doesn't release it — over a session of filtering and sorting
  // the observer accumulates every card ever rendered.
  dom.grid.querySelectorAll('.card').forEach((card) => {
    if (card._artDwellTimer) {
      clearTimeout(card._artDwellTimer);
      card._artDwellTimer = null;
    }
    if (artObserver) artObserver.unobserve(card);
    card._artTarget = null;
  });

  dom.grid.innerHTML = '';
  // The grid and the list are the same <ul> wearing a different class, so the
  // art pipeline, the observer, and the shuffle-landing code all keep working
  // unchanged across a view switch.
  const isList = state.view === 'list';
  dom.grid.classList.toggle('is-list', isList);

  const frag = document.createDocumentFragment();
  discs.forEach((disc, i) => {
    frag.appendChild(isList ? buildRow(disc) : buildCard(disc, i));
  });
  dom.grid.appendChild(frag);

  // Stagger the fade/slide-in. Reduced motion → show immediately. The list is
  // dense enough that a staggered reveal reads as jitter, so it just appears.
  const cards = dom.grid.querySelectorAll('.card');
  if (isList || reducedMotion()) {
    cards.forEach((c) => c.classList.add('is-in'));
  } else {
    cards.forEach((card, i) => {
      const delay = Math.min(i * 35, 600); // cap so big grids don't drag
      setTimeout(() => card.classList.add('is-in'), delay);
    });
  }
}

/**
 * Everything the grid card and the list row have in common: the <li> wrapper,
 * the <button> that opens the detail view, and the cover <img> wired into the
 * art pipeline. The two views differ in what they arrange around this, not in
 * any of it — and the parts that were duplicated (the shadow-property guard,
 * the click handler, the lazy/decorative <img>, the _cardEl backref) are all
 * ones where a change to one copy and not the other is a silent bug.
 */
function buildCardShell(disc, { className = 'card', coverClass = 'card-cover-wrap' } = {}) {
  const li = document.createElement('li');
  li.className = 'grid-item';

  const card = document.createElement('button');
  card.type = 'button';
  card.className = className;
  // Only once there's a sampled color — setting the property to `undefined`
  // stringifies, which invalidates the box-shadow that reads it and leaves the
  // card with no shadow at all instead of the neutral one the CSS defines.
  if (disc.coverColor) card.style.setProperty('--card-shadow', disc.coverColor);
  card.addEventListener('click', () => openDetail(disc));

  const coverWrap = el('div', coverClass);
  const img = document.createElement('img');
  img.className = 'card-cover';
  img.loading = 'lazy';
  img.decoding = 'async';
  // Decorative: the artist + title are already text inside the button, so
  // giving the image alt text would make screen readers announce them twice.
  img.alt = '';
  setCoverImage(img, disc, card);
  coverWrap.appendChild(img);
  card.appendChild(coverWrap);

  li.appendChild(card);

  // Remember the card node so shuffle can scroll/pulse it.
  disc._cardEl = card;
  return { li, card, coverWrap };
}

function buildCard(disc, index) {
  const { li, card, coverWrap } = buildCardShell(disc);

  // Shelf-location accession tag (omit entirely if blank). Shows book + slot,
  // e.g. "B2 · #42–43"; a multi-disc release shows its slot range.
  if (disc.locationLabel) {
    coverWrap.appendChild(el('span', 'card-number', disc.locationLabel));
  }

  // Body
  const body = el('div', 'card-body');
  body.appendChild(el('span', 'card-artist', disc.artist));
  body.appendChild(el('span', 'card-title', disc.title));
  if (disc.year) {
    body.appendChild(el('span', 'card-year', disc.year));
  }

  card.appendChild(body);
  return li;
}

/**
 * The list view's row: the same disc, one line high.
 * A cover wall is the nicest way to browse and the worst way to *scan* — at a
 * few hundred discs you want to run your eye down a column of titles, or print
 * the thing and take it to a shop. Rows keep a small thumbnail (so the art
 * pipeline is identical to the grid's) and lay the rest out as columns.
 *
 * No `index` counterpart to buildCard's: the list skips the staggered reveal,
 * so there's nothing to offset.
 */
function buildRow(disc) {
  // Same cover wrapper class as the grid (plus a sizing hook) so setCoverImage
  // and observeForArt need no special case here.
  const { li, card: row } = buildCardShell(disc, {
    className: 'card row',
    coverClass: 'card-cover-wrap row-thumb',
  });

  // Shelf location, in the mono "accession number" voice used everywhere else.
  // Spelled out rather than a dash: a screen reader reads this row as one
  // string, and "em dash" in the middle of it means nothing.
  row.appendChild(el('span', 'row-loc', disc.locationLabel || 'Uncataloged'));

  const text = el('div', 'row-text');
  text.appendChild(el('span', 'row-artist', disc.artist));
  text.appendChild(el('span', 'row-title', disc.title));
  row.appendChild(text);

  row.appendChild(el('span', 'row-genre', disc.genre));
  row.appendChild(el('span', 'row-year', disc.year || ''));

  return li;
}

/**
 * Decide what image a card shows.
 * - Real Art URL: load it CORS-enabled; on load, sample color and tint the
 *   shadow; on error, swap in a generated placeholder.
 * - No Art URL: generate a placeholder immediately and tint from its hash.
 */
function setCoverImage(img, disc, card) {
  if (disc.art) {
    // Explicit Art URL from the sheet always wins — load it directly.
    loadRealCover(img, disc, card, disc.art);
  } else {
    // No Art URL: show the generated placeholder now, then try to find real art
    // via MusicBrainz — but only once this card scrolls on-screen (lazy), so we
    // never look up covers the visitor doesn't actually see.
    applyPlaceholder(img, disc, card);
    observeForArt(img, disc, card);
  }
}

/**
 * Point an <img> at a real cover URL, CORS-enabled so its dominant color stays
 * canvas-readable. On load, sample + tint the card shadow; on error, fall back
 * to the generated placeholder.
 */
function loadRealCover(img, disc, card, url) {
  img.crossOrigin = 'anonymous'; // so the canvas stays readable for sampling
  img.src = url;

  img.addEventListener('load', () => {
    // Skip if this load is the placeholder swapped in after an error (the
    // error handler drops crossOrigin), or if we already have a sampled color
    // cached from a previous render — re-sampling would just repeat the work.
    if (!img.crossOrigin || disc._sampled) return;
    const color = sampleDominantColor(img) || CONFIG.NEUTRAL_SHADOW;
    disc.coverColor = color;
    disc._sampled = true;
    card.style.setProperty('--card-shadow', color);
  });

  img.addEventListener('error', () => {
    // Broken/blocked image → fall back to a designed placeholder.
    applyPlaceholder(img, disc, card);
  });
}

function applyPlaceholder(img, disc, card) {
  img.removeAttribute('crossorigin'); // it's a data URL now; no CORS needed
  img.src = generatePlaceholderCover(disc);
  const color = colorForArtist(disc.artist);
  disc.coverColor = color;
  card.style.setProperty('--card-shadow', color);
}

// --- Lazy, on-screen-only art resolution --------------------------------
// One shared observer for the whole grid. When a placeholder card lingers near
// the viewport, resolve its real art (once) and swap it in if found. rootMargin
// starts the lookup a bit before the card is fully visible.
//
// We do NOT fire on the intersecting edge directly: a fast scroll-past would
// enter the margin and leave it a moment later, but the lookup — once queued —
// runs unconditionally behind the ~1/sec MusicBrainz throttle, burning quota on
// covers already off-screen and blocking cards you actually stopped on. Instead
// each card must DWELL in the margin for ART_DWELL_MS before its lookup fires;
// a fly-by enters and leaves before the timer elapses, so it never enqueues.
const ART_DWELL_MS = 200;
let artObserver = null;

function getArtObserver() {
  if (artObserver || typeof IntersectionObserver === 'undefined') return artObserver;
  artObserver = new IntersectionObserver((entries, obs) => {
    for (const entry of entries) {
      const card = entry.target;
      if (entry.isIntersecting) {
        // Entered the margin: arm a dwell timer. If the card is still here when
        // it fires, resolve; a scroll-past clears it on the leave below.
        if (card._artDwellTimer) continue; // already armed
        card._artDwellTimer = setTimeout(() => {
          card._artDwellTimer = null;
          obs.unobserve(card); // resolve at most once per card
          const { disc, img } = card._artTarget || {};
          if (disc && img) resolveAndSwap(img, disc, card);
        }, ART_DWELL_MS);
      } else if (card._artDwellTimer) {
        // Left the margin before dwelling long enough — cancel; nothing queued.
        clearTimeout(card._artDwellTimer);
        card._artDwellTimer = null;
      }
    }
  }, { rootMargin: '200px' });
  return artObserver;
}

function observeForArt(img, disc, card) {
  // Stash what this card needs so the observer callback can act on it.
  card._artTarget = { disc, img };
  const obs = getArtObserver();
  if (obs) {
    obs.observe(card);
  } else {
    // No IntersectionObserver (very old browser): resolve immediately.
    resolveAndSwap(img, disc, card);
  }
}

// Resolve real art for a placeholder disc and, if found, swap it in. Always
// loads the real cover when a URL exists — even after a re-render where the
// disc was sampled on a prior card — so the freshly-built placeholder card
// still gets the real art. loadRealCover's own guard skips re-sampling.
async function resolveAndSwap(img, disc, card) {
  const url = await resolveCoverArt(disc);
  if (url) {
    // Remember the resolved URL on the disc so the detail view can reuse it
    // directly instead of running another lookup.
    disc._resolvedArt = url;
    loadRealCover(img, disc, card, url);
  }
}

/**
 * Open (or re-point) the detail dialog for a disc.
 *
 * `pushUrl` controls the history entry. A normal click pushes `#disc-<slug>`
 * so the dialog becomes shareable and the browser's Back button closes it;
 * opening in response to the URL itself (a deep link, or a popstate) passes
 * false, because the history entry is already the reason we're here.
 *
 * Re-points in place when the dialog is already open — showModal() throws on an
 * open dialog, and closing/reopening would flicker.
 */
function openDetail(disc, { pushUrl = true } = {}) {
  // Location line, spelled out: "Book 2 · Catalog #42–43 (2 discs)".
  // Blank (no book and no number) reads as uncataloged.
  const loc = formatLocation(disc, { verbose: true });
  dom.detailNumber.textContent = loc || 'Uncataloged';
  dom.detailTitle.textContent = disc.title;
  dom.detailArtist.textContent = disc.artist;

  // Dialog background: a solid, opaque tint from the cover color (blended into
  // paper) — not translucent, so nothing from the page bleeds through.
  const tint = blendWithPaper(hexToRgb(safeHex(disc.coverColor)), 0.16);
  dom.detail.style.setProperty('--detail-bg', tint);

  // Tag the dialog with the disc it's showing, so an async art lookup that
  // resolves after a fast close/reopen can tell whether it's still the right
  // disc — ids are unique per row, unlike artist+title which can collide
  // (duplicates, reissues, same-named "Greatest Hits", etc.).
  dom.detail.dataset.discId = disc.id;

  dom.detailCover.innerHTML = '';
  const img = document.createElement('img');
  // Intrinsic 1:1 dimensions so the browser reserves a square box before the
  // art loads — no layout shift as it streams in. CSS scales it to fit.
  img.width = 400;
  img.height = 400;
  // Decorative, same as the cards: the dialog is labelled by the title and the
  // artist is the line under it, so alt text here reads them a second time.
  img.alt = '';
  if (disc.art) {
    img.src = disc.art;
    img.addEventListener('error', () => { img.src = generatePlaceholderCover(disc); });
  } else if (disc._resolvedArt) {
    // A card (or a prior detail open) already looked this disc up and found real
    // art — reuse that URL directly instead of running another lookup. Show the
    // placeholder first so there's no blank box while the remote image loads,
    // then swap to the real art once it has actually decoded.
    img.src = generatePlaceholderCover(disc);
    swapWhenLoaded(img, disc._resolvedArt, disc.id);
  } else {
    // No sheet Art URL and none resolved yet. Show the placeholder, then resolve.
    // resolveCoverArt is cache- and in-flight-aware: a URL already in the cache
    // (or a lookup still running from the card) returns without a second API
    // call, and a disc previously settled as a known-miss returns null without
    // any network. So opening the detail before the card's art came back never
    // fires a duplicate request — it joins the existing one.
    img.src = generatePlaceholderCover(disc);
    resolveCoverArt(disc).then((url) => {
      if (!url) return;
      // Remember a found URL on the disc so future opens skip the lookup path.
      disc._resolvedArt = url;
      // Preload into a detached image and only swap the visible src once the
      // real art has decoded, so the placeholder holds until then (no blank box).
      swapWhenLoaded(img, url, disc.id);
    });
  }
  dom.detailCover.appendChild(img);

  // Meta rows: only show fields that have content.
  dom.detailMeta.innerHTML = '';
  if (disc.year)  addMetaRow('Year', disc.year);
  addMetaRow('Genre', disc.genre);

  // Tags
  dom.detailTags.innerHTML = '';
  disc.tags.forEach((t) => dom.detailTags.appendChild(el('span', 'detail-tag', t)));

  // Notes (hidden when empty via CSS :empty)
  dom.detailNotes.textContent = disc.notes || '';

  // "Look it up" links out to the streaming shops and databases.
  renderDetailLinks(disc);

  // Tracklist: fetched from MusicBrainz on demand, so it only costs a request
  // for discs someone actually opens.
  renderTracklist(disc);

  // Only show a dialog that isn't already showing — showModal() on an open
  // dialog throws, and everything above has already re-pointed it at `disc`.
  if (!dom.detail.open) {
    if (typeof dom.detail.showModal === 'function') {
      dom.detail.showModal();
    } else {
      dom.detail.setAttribute('open', ''); // very old browsers
    }
    // Lock background scroll while the dialog is up (see .modal-open in CSS).
    dom.body.classList.add('modal-open');
    // Arm the close cleanup for this showing.
    detailCleanedUp = false;
  }

  // Owned here rather than by the caller: the flag means "did opening this
  // dialog add a history entry", which is exactly what `pushUrl` decides.
  if (pushUrl) pushDiscUrl(disc);
  else detailPushedHistory = false;
}

// Swap the detail cover's src to `url` only once that image has fully loaded,
// so the placeholder already in the <img> stays visible until the real art is
// ready — no blank box or flicker. Preloads via a detached Image; a load error
// simply leaves the placeholder in place. Re-checks that the dialog still shows
// this disc (by id) before swapping, since the load may finish after a
// close/reopen. The preload is a plain (non-CORS) request to match the visible
// <img>, so both share one browser cache entry and the swap is instant — a
// crossOrigin preload would be cached separately and force a second fetch.
function swapWhenLoaded(img, url, discId) {
  const pre = new Image();
  pre.onload = () => {
    if (dom.detail.open && dom.detail.dataset.discId === discId) img.src = url;
  };
  pre.src = url;
}

function addMetaRow(label, value) {
  dom.detailMeta.append(el('dt', null, label), el('dd', null, value));
}

/* ---------- "Look it up" links ----------
   The detail view knows where a disc sits on the shelf; these say where to go
   next with it. All are plain search URLs built from artist + title, so they
   need no API keys and no network of our own — except MusicBrainz, which gets
   a direct link when a release group has already been identified. */
const SERVICE_LINKS = [
  { name: 'Discogs',  href: (q) => `https://www.discogs.com/search/?type=release&q=${q}` },
  { name: 'Bandcamp', href: (q) => `https://bandcamp.com/search?q=${q}` },
  // The iTunes Store's music catalogue lives at music.apple.com now; this is
  // where an itms:// store link resolves to on the web.
  { name: 'iTunes',   href: (q) => `https://music.apple.com/search?term=${q}` },
  { name: 'Spotify',  href: (q) => `https://open.spotify.com/search/${q}` },
];

function renderDetailLinks(disc) {
  const query = encodeURIComponent(`${disc.artist} ${disc.title}`);
  dom.detailLinks.innerHTML = '';

  for (const svc of SERVICE_LINKS) {
    dom.detailLinks.appendChild(makeDetailLink(svc.name, svc.href(query)));
  }

  // MusicBrainz last: a direct release-group link if we already resolved one
  // (from the cover-art lookup), otherwise its search page. Never fires a
  // lookup of its own — a link shouldn't cost a request to draw.
  const mbid = disc._mbid || mbidFromCaaUrl(disc._resolvedArt || artCache[artCacheKey(disc)]);
  dom.detailLinks.appendChild(makeDetailLink(
    'MusicBrainz',
    mbid
      ? `https://musicbrainz.org/release-group/${mbid}`
      : `https://musicbrainz.org/search?type=release_group&query=${query}`
  ));
}

function makeDetailLink(name, href) {
  const a = el('a', 'detail-link');
  a.href = href;
  a.target = '_blank';
  // noopener/noreferrer: these are third-party sites opened in a new tab.
  a.rel = 'noopener noreferrer';
  // The icon says "this leaves the site" to anyone looking; the sr-only text
  // says the same thing to anyone listening. Both, or the cue is sighted-only.
  a.append(
    el('span', 'detail-link-name', name),
    externalIcon(),
    el('span', 'sr-only', '(opens in a new tab)')
  );
  return a;
}

/**
 * The box-and-arrow "leaves this site" glyph. Drawn with square caps and no
 * corner radii to match the hard-edged borders it sits inside, and stroked in
 * currentColor so it inverts along with the text on hover.
 */
function externalIcon() {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('class', 'detail-link-icon');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2.5');
  svg.setAttribute('stroke-linecap', 'square');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');

  for (const [tag, attrs] of [
    ['path',     { d: 'M17 13v7H4V7h7' }],            // frame, open at the corner
    ['polyline', { points: '14 3 21 3 21 10' }],      // arrowhead
    ['line',     { x1: '10', y1: '14', x2: '21', y2: '3' }],
  ]) {
    const node = document.createElementNS(NS, tag);
    for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
    svg.appendChild(node);
  }
  return svg;
}

/* ---------- Tracklist ---------- */

/**
 * Fill in the tracklist panel for a disc.
 * Async and best-effort: the panel shows a loading line, then either the
 * tracks or nothing at all. A disc MusicBrainz doesn't know simply has no
 * tracklist section, rather than an apology where content should be.
 */
function renderTracklist(disc) {
  const box = dom.detailTracks;
  box.innerHTML = '';
  box.hidden = true;

  const paint = (tracks) => {
    // The dialog may have moved on to another disc while we were waiting.
    if (dom.detail.dataset.discId !== disc.id) return;
    box.innerHTML = '';
    if (!tracks || !tracks.length) { box.hidden = true; return; }

    box.hidden = false;
    box.appendChild(el('h3', 'detail-tracks-heading', 'Tracklist'));
    const ol = el('ol', 'tracklist');
    tracks.forEach((t) => {
      const li = el('li', 'tracklist-item');
      li.appendChild(el('span', 'track-title', t.title));
      const len = formatDuration(t.length);
      if (len) li.appendChild(el('span', 'track-len', len));
      ol.appendChild(li);
    });
    box.appendChild(ol);
  };

  // A cached tracklist resolves in a microtask, so only show the loading line
  // if we're actually about to hit the network.
  const pending = resolveTracklist(disc);
  let settled = false;
  // resolveTracklist swallows its own failures, but a rejection here would be
  // an unhandled one — and "no tracklist" is the right answer either way.
  pending.then((tracks) => { settled = true; paint(tracks); })
         .catch(() => { settled = true; paint(null); });
  setTimeout(() => {
    if (settled || dom.detail.dataset.discId !== disc.id) return;
    box.hidden = false;
    box.innerHTML = '';
    box.appendChild(el('h3', 'detail-tracks-heading', 'Tracklist'));
    box.appendChild(el('p', 'tracklist-loading', 'Looking it up…'));
  }, 150);
}

// Guard against a non-hex color slipping into hexToRgb.
function safeHex(hex) {
  return isHex6(hex) ? hex : CONFIG.NEUTRAL_SHADOW;
}

// Mix a color with the paper base at `amount` (0–1), returning an opaque
// "rgb(...)" string. Used for the detail dialog's solid cover-derived tint.
// Seeded from --paper (#f5edd6) and overwritten from that CSS var at startup
// (hydrateThemeConstants), so the stylesheet stays the single source of truth.
let PAPER_RGB = { r: 245, g: 237, b: 214 };
function blendWithPaper(rgb, amount) {
  const mix = (c, p) => Math.round(c * amount + p * (1 - amount));
  return `rgb(${mix(rgb.r, PAPER_RGB.r)}, ${mix(rgb.g, PAPER_RGB.g)}, ${mix(rgb.b, PAPER_RGB.b)})`;
}


/* ============================================================
   7. Filtering: search + pills + shuffle
   ============================================================ */

// Defaults. A value equal to its default is left OUT of the URL, so a plain
// visit stays at a clean `/` rather than carrying a string of no-op params.
const DEFAULT_SORT = 'random'; // matches the #sort <select> default
const DEFAULT_VIEW = 'grid';
const VIEWS = ['grid', 'list'];

// Current filter state. Mirrored to the querystring (see section 7a) so any
// view of the collection is a shareable link.
const state = {
  search: '',
  genres: new Set(),
  tags: new Set(),
  sort: DEFAULT_SORT,
  view: DEFAULT_VIEW,   // 'grid' (cover wall) or 'list' (dense shelf list)
};

// Whether the tag cloud is showing every tag or just the first line of them.
// Deliberately not in `state`: it's how much of a control is unrolled, not a
// view of the collection, so it has no business in a shared link.
let tagsExpanded = false;

/**
 * Return a new array of discs ordered per the current sort mode.
 * Sorting only affects display order — never the underlying DISCS array — so
 * switching modes (or the "Random" key) can't corrupt anything else.
 *   random     → the stable per-load _rand key (different every page load)
 *   number     → catalog number ascending, blanks last
 *   book       → by book, then page within the book (physical shelf order)
 *   artist     → artist A–Z (locale-aware), then title as a tiebreaker
 *   title      → title A–Z
 *   year-desc  → newest first, blanks last
 *   year-asc   → oldest first, blanks last
 */
function sortDiscs(discs) {
  const byStr = (a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' });
  const out = discs.slice();

  switch (state.sort) {
    case 'number':
      // Sort by the first slot number a release occupies, so a multi-disc set
      // sits where it starts on the shelf. Blank/uncataloged entries sort last.
      out.sort((a, b) => firstNumberOrInf(a) - firstNumberOrInf(b) || byStr(a.sortArtist, b.sortArtist));
      break;
    case 'book':
      // Physical shelf order: by book, then by page within the book. Discs with
      // no book sort last; ties fall back to the first page number then artist.
      out.sort((a, b) =>
        a.bookNum - b.bookNum
        || firstNumberOrInf(a) - firstNumberOrInf(b)
        || byStr(a.sortArtist, b.sortArtist));
      break;
    case 'artist':
      out.sort((a, b) => byStr(a.sortArtist, b.sortArtist) || byStr(a.sortTitle, b.sortTitle));
      break;
    case 'title':
      out.sort((a, b) => byStr(a.sortTitle, b.sortTitle) || byStr(a.sortArtist, b.sortArtist));
      break;
    case 'year-desc':
      out.sort((a, b) => yearOr(b, -Infinity) - yearOr(a, -Infinity) || byStr(a.sortArtist, b.sortArtist));
      break;
    case 'year-asc':
      out.sort((a, b) => yearOr(a, Infinity) - yearOr(b, Infinity) || byStr(a.sortArtist, b.sortArtist));
      break;
    case 'random':
    default:
      out.sort((a, b) => a._rand - b._rand);
      break;
  }
  return out;
}

// First slot number of a disc for sorting; uncataloged entries sort last.
function firstNumberOrInf(disc) {
  return disc.numbers.length ? disc.numbers[0] : Infinity;
}

// Parse a disc's year to an int; `blankTo` decides where a missing year lands
// (use -Infinity so blanks sink to the bottom of a descending sort, +Infinity
// so they sink to the bottom of an ascending one).
function yearOr(disc, blankTo) {
  const n = parseInt(disc.year, 10);
  return Number.isNaN(n) ? blankTo : n;
}

// Compute the currently-visible discs from state.
function currentMatches() {
  const q = state.search.toLowerCase();
  return DISCS.filter((d) => {
    // Search matches across every column via the precomputed blob.
    if (q && !d.searchText.includes(q)) return false;
    if (state.genres.size && !state.genres.has(d.genre)) return false;
    // Tag filter: disc must carry every selected tag (AND semantics).
    if (state.tags.size) {
      for (const t of state.tags) if (!d.tags.includes(t)) return false;
    }
    return true;
  });
}

// Re-render the grid + results readout for the current filter state.
function applyFilters({ announceResults = true } = {}) {
  const matches = sortDiscs(currentMatches());
  renderCards(matches);

  const n = matches.length;
  const total = DISCS.length;
  const anyFilter = state.search || state.genres.size || state.tags.size;

  dom.resultsCount.textContent = anyFilter
    ? `${n} of ${total} disc${total === 1 ? '' : 's'}`
    : `${total} disc${total === 1 ? '' : 's'}`;

  dom.clearFilters.hidden = !anyFilter;

  if (n === 0) {
    dom.stateMsg.hidden = false;
    dom.stateMsg.classList.remove('is-error');
    dom.stateMsg.textContent = 'No discs match those filters.';
  } else {
    dom.stateMsg.hidden = true;
  }

  if (announceResults) {
    announceCount(anyFilter ? `${n} disc${n === 1 ? '' : 's'} match your filters.` : `Showing all ${total} discs.`);
  }
}

// Toggle a pill's filter value and refresh.
function togglePill(btn) {
  const { filterType, filterValue } = btn.dataset;
  const set = filterType === 'genre' ? state.genres : state.tags;

  if (set.has(filterValue)) {
    set.delete(filterValue);
    btn.setAttribute('aria-pressed', 'false');
  } else {
    set.add(filterValue);
    btn.setAttribute('aria-pressed', 'true');
  }
  if (filterType === 'tag') layoutTagCloud();
  applyFilters();
  syncUrl();
}

// Reset everything.
function clearAllFilters() {
  state.search = '';
  state.genres.clear();
  state.tags.clear();
  dom.search.value = '';
  document.querySelectorAll('.pill[aria-pressed="true"]')
    .forEach((p) => p.setAttribute('aria-pressed', 'false'));
  layoutTagCloud();   // nothing is pinned visible by being pressed any more
  applyFilters();
  syncUrl();
}

/**
 * Switch between the cover grid and the dense list.
 * Like sort, this is a display preference rather than a filter, so it survives
 * "Clear filters" — and it lands in the URL so a shared link arrives in the
 * same view it was sent from.
 */
function setView(view) {
  if (!VIEWS.includes(view) || view === state.view) return;
  state.view = view;
  syncViewControls();
  applyFilters({ announceResults: false });
  syncUrl();
  announce(view === 'list' ? 'Switched to list view.' : 'Switched to grid view.');
}

// Reflect the current view on the toggle buttons.
function syncViewControls() {
  dom.viewToggle.querySelectorAll('[data-view]').forEach((btn) => {
    btn.setAttribute('aria-pressed', String(btn.dataset.view === state.view));
  });
}

/**
 * Download the discs currently on screen as a CSV, in the order they're shown.
 * Columns match the sheet's, so an export can be pasted straight back into a
 * spreadsheet — handy for taking a filtered slice somewhere else, or keeping a
 * dated snapshot of the collection.
 */
function exportCurrentCsv() {
  const discs = sortDiscs(currentMatches());
  if (discs.length === 0) {
    announce('Nothing to export — no discs match your filters.');
    return;
  }

  const C = Collection.CONFIG.COLUMNS;
  const headers = [C.book, C.number, C.artist, C.title, C.year, C.genre, C.tags, C.notes];
  const rows = discs.map((d) => [
    d.book, d.number, d.artist, d.title, d.year, d.genre, d.tags.join(', '), d.notes,
  ]);

  const csv = [headers, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n');
  // A BOM so Excel opens UTF-8 as UTF-8 rather than mangling accented names.
  // Written as an escape, not a literal: a raw U+FEFF is invisible in every
  // editor and the next whitespace cleanup would silently delete it.
  downloadFile(`\uFEFF${csv}`, 'text/csv;charset=utf-8', exportFilename());
  announce(`Exported ${discs.length} disc${discs.length === 1 ? '' : 's'}.`);
}

// Quote a CSV field per RFC 4180: wrap in quotes when it contains a comma,
// quote, or newline, and double any embedded quotes.
function csvCell(value) {
  const str = value == null ? '' : String(value);
  return /[",\r\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}

// Name the download after what it contains: filtered exports say so, and every
// file is dated so successive snapshots don't overwrite each other.
function exportFilename() {
  const stamp = new Date().toISOString().slice(0, 10);
  const filtered = state.search || state.genres.size || state.tags.size;
  return `cd-collection${filtered ? '-filtered' : ''}-${stamp}.csv`;
}

// Hand a generated string to the browser as a file download.
function downloadFile(text, mime, filename) {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Release the blob once the download has been handed off.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * Shuffle: pick a random disc from the *currently visible* set, scroll to it,
 * pulse it, and open its detail view. Playful spin on the button first,
 * unless reduced motion is on.
 */
function shuffle() {
  const pool = currentMatches();
  if (pool.length === 0) {
    announce('No discs to shuffle. Clear a filter and try again.');
    return;
  }

  const pick = pool[Math.floor(Math.random() * pool.length)];

  const land = () => {
    const card = pick._cardEl;
    if (card) {
      card.scrollIntoView({
        behavior: reducedMotion() ? 'auto' : 'smooth',
        block: 'center',
      });
      card.classList.remove('is-shuffled');
      // reflow so the animation can retrigger
      void card.offsetWidth;
      card.classList.add('is-shuffled');
    }
    announce(`Shuffle landed on ${pick.artist} — ${pick.title}.`);
    openDetail(pick);
  };

  if (reducedMotion()) {
    land();
  } else {
    dom.shuffle.classList.add('is-shuffling');
    setTimeout(() => {
      dom.shuffle.classList.remove('is-shuffling');
      land();
    }, 500);
  }
}


/* ============================================================
   7a. URL state: shareable filters + per-disc deep links
   ============================================================
   Every browsable state of this page is a URL, so a view can be
   sent to someone else (or bookmarked, or reloaded) and come back:

     ?q=miles&genre=Jazz&sort=year-asc&view=list
     #disc-radiohead-ok-computer

   Two different history behaviours, deliberately:
   - Filters/sort/view REPLACE the current entry. Typing six letters
     into the search box should not bury the previous page under six
     history entries.
   - Opening a disc PUSHES an entry, so Back closes the dialog. On a
     phone that makes the system back gesture do the obvious thing,
     which is otherwise the roughest edge on the whole site.
*/

// The hash prefix for a disc deep link: "#disc-<slug>".
const DISC_HASH_PREFIX = '#disc-';

// True when the dialog currently open was opened by us pushing a history
// entry (a click), rather than by the URL already pointing at it (a deep
// link or a Back/Forward). It decides how closing the dialog gets rid of the
// hash: go Back if we pushed, or rewrite the URL in place if we didn't —
// calling history.back() on a fresh deep link would leave the site entirely.
let detailPushedHistory = false;

// Set while WE are closing the dialog to match the URL, so the resulting
// `close` event doesn't try to drive history in turn and loop.
let closingForHistory = false;

// Guards the close cleanup against running twice for one dismissal (it is
// invoked directly by dismissDetail and again by the native `close` event).
// Starts true so a stray event before anything has opened does nothing.
let detailCleanedUp = true;

// The disc slug named by the current URL hash, or '' if there isn't one.
function discSlugFromHash() {
  const hash = location.hash;
  return hash.startsWith(DISC_HASH_PREFIX) ? hash.slice(DISC_HASH_PREFIX.length) : '';
}

// Look up a disc by its URL slug.
function discBySlug(slug) {
  return slug ? DISCS.find((d) => d.slug === slug) || null : null;
}

/**
 * Build the URL for the current filter state.
 * Values equal to their default are omitted, so an unfiltered page is a bare
 * path. `hash` defaults to whatever the address bar already has, so updating a
 * filter while the dialog is open doesn't drop the disc it's showing.
 */
function buildUrl(hash = location.hash) {
  const parts = [];
  // Preserve ?sample as a bare flag — it's a dev switch and reads better
  // spelled the way the README documents it.
  if (Collection.usingSample()) parts.push('sample');
  if (state.search) parts.push(`q=${encodeURIComponent(state.search)}`);
  // Repeated keys for the multi-selects: ?genre=Jazz&genre=Soul.
  for (const g of state.genres) parts.push(`genre=${encodeURIComponent(g)}`);
  for (const t of state.tags)   parts.push(`tag=${encodeURIComponent(t)}`);
  if (state.sort !== DEFAULT_SORT) parts.push(`sort=${encodeURIComponent(state.sort)}`);
  if (state.view !== DEFAULT_VIEW) parts.push(`view=${encodeURIComponent(state.view)}`);

  const query = parts.length ? `?${parts.join('&')}` : '';
  return `${location.pathname}${query}${hash || ''}`;
}

// Write the current filter state into the address bar without adding history.
function syncUrl() {
  history.replaceState(history.state, '', buildUrl());
}

// Push a history entry for an opened disc, so Back closes the dialog.
function pushDiscUrl(disc) {
  history.pushState({ discSlug: disc.slug }, '', buildUrl(`${DISC_HASH_PREFIX}${disc.slug}`));
  detailPushedHistory = true;
}

/**
 * Read filter state out of the querystring. Every value is validated against
 * what the controls actually offer — a hand-edited `sort=chaos` should fall
 * back to the default, not put the page in a state its UI can't represent.
 * Genre/tag values are NOT validated here: the pills aren't built until the
 * sheet has loaded, and an unknown value simply matches no discs.
 *
 * `sortFallback` is what a URL that says nothing about sorting falls back to.
 * At startup that's whatever the browser restored into the <select>; on a
 * Back/Forward it's the plain default, because an entry without ?sort really
 * does mean the default.
 */
function readStateFromUrl({ sortFallback = DEFAULT_SORT } = {}) {
  const params = new URLSearchParams(location.search);

  state.search = params.get('q') || '';
  state.genres = new Set(params.getAll('genre').filter(Boolean));
  state.tags   = new Set(params.getAll('tag').filter(Boolean));

  const sort = params.get('sort');
  const sortable = [...dom.sort.options].some((o) => o.value === sort);
  state.sort = sortable ? sort : sortFallback;

  const view = params.get('view');
  state.view = VIEWS.includes(view) ? view : DEFAULT_VIEW;
}

// Push the current state back out to the controls, so what's on screen always
// matches what's in the URL (after a deep link, or a Back/Forward).
function syncControlsToState() {
  dom.search.value = state.search;
  dom.sort.value = state.sort;
  document.querySelectorAll('.pill').forEach((pill) => {
    const set = pill.dataset.filterType === 'genre' ? state.genres : state.tags;
    pill.setAttribute('aria-pressed', String(set.has(pill.dataset.filterValue)));
  });
  // Pressed pills are wider (the ✓) and are never hidden, so both inputs to the
  // cloud's one-line fit just changed.
  layoutTagCloud();
  syncViewControls();
}

/**
 * A comparable summary of everything that changes what the grid shows. Used to
 * tell "the filters moved" apart from "only the disc in the hash moved".
 */
function stateSignature() {
  return JSON.stringify([
    state.search,
    [...state.genres].sort(),
    [...state.tags].sort(),
    state.sort,
    state.view,
  ]);
}

/**
 * Bring the page in line with the URL after a Back/Forward. Handles both
 * halves — the filter state and whether a disc dialog should be showing.
 */
function onPopState() {
  const before = stateSignature();
  readStateFromUrl();

  // Opening and closing a disc are history entries too, and they move only the
  // hash. Re-rendering the grid for them is not just wasted work: it destroys
  // and rebuilds every card, including the one the dialog restores focus to on
  // close — so focus lands on <body> and a keyboard user loses their place in
  // the shelf. Only touch the grid when the grid's own inputs actually changed.
  if (stateSignature() !== before) {
    syncControlsToState();
    applyFilters({ announceResults: false });
  }

  const disc = discBySlug(discSlugFromHash());
  if (disc) {
    // The entry we landed on names a disc: show it (re-pointing the dialog in
    // place if it's already open). No push — this entry already exists.
    openDetail(disc, { pushUrl: false });
  } else if (dom.detail.open) {
    closeDetailForHistory();
  }
}

/**
 * Close the dialog and tidy up after it.
 *
 * close() is synchronous but its event is only queued, so for the routes we
 * drive ourselves (close button, backdrop, Back) the cleanup runs here rather
 * than a task later — the page is scrollable and the URL is honest in the same
 * frame the dialog disappears. The `close` listener still fires afterwards and
 * covers Esc, which the browser handles without going through this function;
 * onDetailClosed is written to be safe to run twice.
 */
function dismissDetail() {
  dom.detail.close();
  onDetailClosed();
}

// Close the dialog because the URL says it shouldn't be open, without letting
// the close handler push history back the other way.
function closeDetailForHistory() {
  closingForHistory = true;
  dismissDetail();
}

/**
 * Release the scroll lock and clean the disc hash out of the URL once the
 * dialog is gone. Runs from dismissDetail for the routes we control and from
 * the dialog's native `close` event for the ones we don't (Esc) — so it runs
 * twice for most dismissals and must be idempotent. `detailCleanedUp` is what
 * makes the second run a no-op; openDetail arms it again.
 */
function onDetailClosed() {
  if (detailCleanedUp) return;
  detailCleanedUp = true;

  dom.body.classList.remove('modal-open');

  // We closed it ourselves to match a Back/Forward — history is already right.
  if (closingForHistory) {
    closingForHistory = false;
    return;
  }
  if (!discSlugFromHash()) return; // nothing to clean up

  if (detailPushedHistory) {
    // We added this entry, so unwinding it is the honest way back: it also
    // restores whatever scroll position and filters preceded the dialog.
    detailPushedHistory = false;
    history.back();
  } else {
    // Arrived here by deep link, so there is nothing of ours to go back to —
    // going back would leave the site. Drop the hash in place instead.
    history.replaceState(history.state, '', buildUrl(''));
  }
}


/**
 * Click-and-drag horizontal scrolling for a pill rail (mouse only — touch
 * devices already get native momentum scrolling, so we leave those alone).
 * If the pointer moves past a small threshold we flag the rail so the click
 * that follows doesn't accidentally toggle a pill.
 */
function enableDragScroll(rail) {
  let isDown = false;
  let startX = 0;
  let startScroll = 0;
  let moved = 0;

  rail.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'mouse' || e.button !== 0) return;
    isDown = true;
    moved = 0;
    startX = e.clientX;
    startScroll = rail.scrollLeft;
    rail.classList.add('is-dragging');
  });

  rail.addEventListener('pointermove', (e) => {
    if (!isDown) return;
    const dx = e.clientX - startX;
    moved = Math.max(moved, Math.abs(dx));
    rail.scrollLeft = startScroll - dx;
  });

  const end = () => {
    if (!isDown) return;
    isDown = false;
    rail.classList.remove('is-dragging');
    // Only suppress the click if this was a real drag, not a plain click.
    if (moved > 6) {
      rail._suppressClick = true;
      // Browsers don't reliably fire a click after a drag-scroll; clear the
      // flag shortly after so a later genuine click isn't swallowed.
      clearTimeout(rail._suppressTimer);
      rail._suppressTimer = setTimeout(() => { rail._suppressClick = false; }, 350);
    }
  };

  rail.addEventListener('pointerup', end);
  rail.addEventListener('pointerleave', end);
  rail.addEventListener('pointercancel', end);
}


/* ============================================================
   8. Init
   ============================================================ */

function wireEvents() {
  // Search (debounced lightly so typing feels smooth).
  let searchTimer;
  dom.search.addEventListener('input', (e) => {
    clearTimeout(searchTimer);
    const value = e.target.value;
    searchTimer = setTimeout(() => {
      state.search = value.trim();
      applyFilters();
      syncUrl();
    }, 120);
  });

  // Pills (event delegation on each container).
  [dom.genrePills, dom.tagPills].forEach((rail) => {
    rail.addEventListener('click', (e) => {
      // A drag that scrolled the rail shouldn't also toggle a pill.
      if (rail._suppressClick) { rail._suppressClick = false; return; }
      const pill = e.target.closest('.pill');
      if (pill) togglePill(pill);
    });
  });
  // Only the genre rail scrolls sideways — the tag cloud wraps instead.
  enableDragScroll(dom.genrePills);

  // How many tags fit on one line is a function of the container's width.
  let tagLayoutTimer;
  window.addEventListener('resize', () => {
    clearTimeout(tagLayoutTimer);
    tagLayoutTimer = setTimeout(layoutTagCloud, 150);
  });

  dom.clearFilters.addEventListener('click', clearAllFilters);
  dom.shuffle.addEventListener('click', shuffle);

  // Sort order: re-render in the chosen order. Sort is a display preference,
  // independent of the filters, so it survives "Clear filters".
  dom.sort.addEventListener('change', () => {
    state.sort = dom.sort.value;
    applyFilters({ announceResults: false });
    syncUrl();
    const label = dom.sort.options[dom.sort.selectedIndex].text;
    announce(`Sorted by ${label}.`);
  });

  // View toggle: cover grid vs dense list. Delegated over the whole group so
  // both buttons share one handler.
  dom.viewToggle.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-view]');
    if (btn) setView(btn.dataset.view);
  });

  // Download whatever is currently on screen as a CSV.
  dom.exportBtn.addEventListener('click', exportCurrentCsv);

  // Detail dialog close.
  dom.detailClose.addEventListener('click', dismissDetail);
  // Click on the backdrop (outside the inner panel) closes it too. A click that
  // lands on the dialog element itself is the backdrop — but the dialog's own
  // scrollbar reports the same target, so only treat clicks that fall outside
  // the panel's box as a backdrop click (a scrollbar drag stays inside it).
  dom.detail.addEventListener('click', (e) => {
    if (e.target !== dom.detail) return;
    const r = dom.detail.getBoundingClientRect();
    const inside = e.clientX >= r.left && e.clientX <= r.right &&
                   e.clientY >= r.top  && e.clientY <= r.bottom;
    if (!inside) dismissDetail();
  });
  // Tidy the URL however the dialog was dismissed (button, backdrop, or Esc —
  // all of them fire the native close event). Esc is the only route that
  // doesn't also pass through dismissDetail, so this is what releases the
  // scroll lock for it.
  dom.detail.addEventListener('close', onDetailClosed);

  // Back/Forward: the URL is the source of truth, so re-derive everything.
  window.addEventListener('popstate', onPopState);
}

// Pull shared theme colors from the stylesheet so CSS stays canonical. Each
// read is validated; a missing/blank var (e.g. stylesheet failed to load)
// leaves the baked-in fallback in place rather than corrupting a color.
function hydrateThemeConstants() {
  const shadow = cssVar('--shadow-neutral');
  if (isHex6(shadow)) CONFIG.NEUTRAL_SHADOW = shadow;

  const paper = cssVar('--paper');
  if (isHex6(paper)) PAPER_RGB = hexToRgb(paper);
}

async function init() {
  cacheDom();
  hydrateThemeConstants();
  // The URL wins — an explicit link beats anything the browser remembers. But
  // a URL with no ?sort is silent rather than opinionated, so a select the
  // browser restored across a reload stands in as the fallback.
  readStateFromUrl({ sortFallback: dom.sort.value });
  dom.sort.value = state.sort;
  syncViewControls();
  dom.search.value = state.search;
  wireEvents();
  Collection.registerServiceWorker();

  try {
    DISCS = await Collection.load();

    if (DISCS.length === 0) {
      dom.stateMsg.textContent = 'The collection is empty right now.';
      announce('The collection is empty right now.');
      return;
    }

    renderStats(DISCS);
    renderPills(DISCS);
    // The pills only exist now, so this is the first point at which genre/tag
    // filters from the URL can be shown as pressed.
    syncControlsToState();
    dom.stateMsg.hidden = true;
    applyFilters({ announceResults: false });
    announce(`Loaded ${DISCS.length} discs.`);

    // A deep link straight to a disc: open it once the collection exists.
    // No push — this history entry is what brought us here.
    const linked = discBySlug(discSlugFromHash());
    if (linked) openDetail(linked, { pushUrl: false });
  } catch (err) {
    console.error('Failed to load collection:', err);
    dom.stateMsg.hidden = false;
    dom.stateMsg.classList.add('is-error');
    dom.stateMsg.textContent = 'Could not load the collection. Please try again later.';
    announce('Could not load the collection. Please try again later.');
  }
}

document.addEventListener('DOMContentLoaded', init);
