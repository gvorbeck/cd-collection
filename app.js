/* ============================================================
   CD COLLECTION — app.js
   ------------------------------------------------------------
   Structure (kept deliberately separated so each can change alone):
     1. CONFIG          — everything you'll want to edit lives here
     2. Utilities       — tiny shared helpers
     3. Data loading    — PapaParse → normalized disc objects
     4. Color           — hashing, brightness, cover sampling
     5. Placeholder art — generated covers for disc with no image
     6. Rendering       — stats, pills, cards, detail view
     7. Filtering       — search + genre/tag pills + shuffle
     8. Init            — wire it all together
   ============================================================ */


/* ============================================================
   1. CONFIG  — edit here
   ============================================================ */
const CONFIG = {
  // Published Google Sheet, CSV output.
  CSV_URL: 'https://docs.google.com/spreadsheets/d/e/2PACX-1vSV9mf7fFJZ25gUb2PUNWqO6y6f5KUJDApmgiiYMZ0fiFr6FELE6IC-6tbvSOj31jDZ82tazs1jdUuR/pub?gid=1454994388&single=true&output=csv',

  // Column names as they appear in the sheet header row.
  // Change these if you rename a column; the rest of the code reads through here.
  COLUMNS: {
    book:   'Book',        // which physical book/binder the disc lives in
    number: 'Number',      // page/slot within that book
    artist: 'Artist',
    title:  'Title',
    year:   'Year',
    genre:  'Parent Genre',
    tags:   'Tags',
    art:    'Art URL',
    notes:  'Notes',
  },

  // Fallbacks for blank cells. Empty string means "show nothing".
  FALLBACKS: {
    artist: 'Various Artists',
    title:  'Self-Titled',
    year:   '',              // missing year shows nothing at all
    genre:  'Uncategorized',
  },

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

  // Design/preview aid: loading the page with ?sample in the URL reads the
  // bundled sample.csv instead of the live sheet, so layouts can be built out
  // with a full spread of dummy discs. Production (no query param) is untouched.
  SAMPLE_URL: 'sample.csv',

  // Automatic cover-art lookup via MusicBrainz + the Cover Art Archive.
  // Only used for discs with a BLANK Art URL — an explicit Art URL in the sheet
  // always wins. Lookups fire lazily (only when a card scrolls on-screen) and
  // are cached in localStorage, so we stay well under MusicBrainz's ~1 req/sec
  // limit and never look a disc up more than once per browser.
  MUSICBRAINZ: {
    // MusicBrainz asks every client to identify itself with a descriptive
    // User-Agent (app name/version + contact). Sent via a query param since
    // browsers can't set User-Agent on fetch; MB reads either.
    APP_IDENTITY: 'CDCollection/1.0 ( https://github.com/gvorbeck/cd-collection )',
    // Release-group text search endpoint.
    SEARCH_URL: 'https://musicbrainz.org/ws/2/release-group',
    // Cover Art Archive front-image endpoint (CORS-enabled + canvas-readable).
    // {mbid} is a release-group id; size is one of 250 / 500 / 1200.
    CAA_URL: 'https://coverartarchive.org/release-group',
    CAA_SIZE: 500,
    // Minimum gap between MusicBrainz network calls (ms). MB's rule is 1/sec;
    // 1100ms leaves a little headroom.
    THROTTLE_MS: 1100,
    // localStorage key + schema version. Bump the version to invalidate the
    // whole cache if the lookup logic changes.
    CACHE_KEY: 'cdc:art-cache:v1',
  },
};


/* ============================================================
   2. Utilities
   ============================================================ */

// Trim to a clean string; treats null/undefined/whitespace-only as ''.
function clean(value) {
  return (value == null ? '' : String(value)).trim();
}

// Read a column off a raw CSV row object using the configured name.
function col(row, key) {
  return clean(row[CONFIG.COLUMNS[key]]);
}

/**
 * Expand a catalog-Number cell into its individual slot numbers.
 * Accepts:
 *   ""         → []                 (blank / uncataloged)
 *   "42"       → [42]               (single disc)
 *   "42-43"    → [42, 43]           (range, hyphen or en/em dash)
 *   "42, 43"   → [42, 43]           (explicit list)
 *   "42-44, 50"→ [42, 43, 44, 50]   (mixed)
 * Non-numeric junk is ignored; a descending or backwards range ("43-42") is
 * normalized to ascending. Deduped and sorted so downstream code is simple.
 */
function parseNumbers(raw) {
  if (!raw) return [];
  const out = new Set();
  // Split on commas first, then interpret each piece as a single or a range.
  for (const piece of raw.split(',')) {
    const part = piece.trim();
    if (!part) continue;
    // Range: two integers separated by a hyphen or dash. Anchored so stray
    // dashes inside other text don't accidentally form a range.
    const range = part.match(/^(\d+)\s*[-–—]\s*(\d+)$/);
    if (range) {
      let a = parseInt(range[1], 10);
      let b = parseInt(range[2], 10);
      if (a > b) [a, b] = [b, a];
      // Guard against a pathological huge range from a typo.
      if (b - a > 999) { out.add(a); out.add(b); continue; }
      for (let n = a; n <= b; n++) out.add(n);
      continue;
    }
    const single = part.match(/\d+/);
    if (single) out.add(parseInt(single[0], 10));
  }
  return [...out].sort((x, y) => x - y);
}

// Build the display label for a set of slot numbers:
//   [] → ""   [42] → "42"   [42,43] → "42–43"   [42,43,50] → "42, 43, 50"
// A contiguous run collapses to a "first–last" range with an en-dash;
// anything with gaps is shown as a comma list so it's not misleading.
function formatNumbers(numbers) {
  if (numbers.length === 0) return '';
  if (numbers.length === 1) return String(numbers[0]);
  const contiguous = numbers.every((n, i) => i === 0 || n === numbers[i - 1] + 1);
  if (contiguous) return `${numbers[0]}–${numbers[numbers.length - 1]}`;
  return numbers.join(', ');
}

/**
 * Compact shelf-location label for the small card tag. The Number is the page
 * within a book, so a book is needed to make the location unambiguous:
 *   book "2" + numbers "42-43" → "B2 · #42–43"
 *   book "2" only              → "B2"
 *   number only (no book)      → "#42–43"
 *   neither                    → "" (card shows no tag; detail says Uncataloged)
 * "B2" is used on the tight card tag; the detail view spells out "Book 2".
 */
function formatLocation(disc) {
  const parts = [];
  if (disc.book) parts.push(`B${disc.book}`);
  if (disc.numberLabel) parts.push(`#${disc.numberLabel}`);
  return parts.join(' · ');
}

// Escape text destined for innerHTML. We mostly use textContent, but a few
// spots build markup — keep them safe.
function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// Whether the user prefers reduced motion (checked live, not cached).
function reducedMotion() {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

// Grab an element by id (short alias).
const $ = (id) => document.getElementById(id);

// Read a CSS custom property off :root (trimmed). Lets the stylesheet stay the
// single source of truth for shared colors instead of duplicating hexes in JS.
function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}


/* ============================================================
   3. Data loading + normalization
   ============================================================ */

// The full, immutable-ish collection once loaded.
let DISCS = [];

/**
 * Load the sheet with PapaParse and normalize into disc objects.
 * We read only the columns we know, but keep the raw row around so adding
 * a new column later never breaks parsing.
 */
function loadCollection() {
  // Use the bundled sample data when ?sample is present in the URL.
  const useSample = new URLSearchParams(location.search).has('sample');
  const source = useSample ? CONFIG.SAMPLE_URL : CONFIG.CSV_URL;

  return new Promise((resolve, reject) => {
    Papa.parse(source, {
      download: true,
      header: true,
      skipEmptyLines: 'greedy', // drop rows that are entirely blank
      complete: (results) => {
        try {
          resolve(normalizeRows(results.data));
        } catch (err) {
          reject(err);
        }
      },
      error: (err) => reject(err),
    });
  });
}

/** Turn raw CSV row objects into clean disc objects with fallbacks applied. */
function normalizeRows(rows) {
  const discs = [];

  rows.forEach((row, index) => {
    // Consider a row empty if every configured field trims to nothing.
    const rawValues = Object.keys(CONFIG.COLUMNS).map((k) => col(row, k));
    if (rawValues.every((v) => v === '')) return;

    const artist = col(row, 'artist') || CONFIG.FALLBACKS.artist;
    const title  = col(row, 'title')  || CONFIG.FALLBACKS.title;
    const year   = col(row, 'year')   || CONFIG.FALLBACKS.year;
    const genre  = col(row, 'genre')  || CONFIG.FALLBACKS.genre;
    const book   = col(row, 'book');   // which book/binder; may be blank
    const number = col(row, 'number'); // may be blank — card still renders
    const art    = col(row, 'art');
    const notes  = col(row, 'notes');

    // A single release can span several catalog slots in the book (e.g. a
    // 2-disc greatest-hits set). The Number cell accepts a range ("42-43") or
    // a comma list ("42, 43"); parseNumbers expands either into the actual
    // slot numbers so one card can represent the whole physical release.
    const numbers = parseNumbers(number);
    // Book number for sorting (books are numbered 1, 2, 3…). Blank sorts last.
    const bookNum = book ? numOrInf(book) : Infinity;

    // Tags: comma-separated inside one cell. Split, trim, drop blanks.
    const tags = col(row, 'tags')
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean);

    const disc = {
      id: `disc-${index}`,
      book,                          // raw book value, e.g. "2"
      bookNum,                       // parsed for sorting; Infinity if blank
      number,                        // raw cell value, kept for reference
      numbers,                       // expanded slot numbers, e.g. [42, 43]
      numberLabel: formatNumbers(numbers), // display string: "42" or "42–43"
      discCount: numbers.length || 1,      // how many book slots this occupies
      artist,
      title,
      year,
      genre,
      tags,
      art,
      notes,
      // Filled in later once a cover color is known (sampled or hashed).
      coverColor: CONFIG.NEUTRAL_SHADOW,
      // Stable random key for the "Random" sort: assigned once per page load,
      // so the shelf looks different every visit but doesn't reshuffle on each
      // keystroke while filtering. A fresh load re-randomizes it.
      _rand: Math.random(),
    };

    // Precompute one lowercased blob of every searchable field so the search
    // box can match across all columns (artist, title, year, genre, tags,
    // notes, number) instead of just artist + title. Include the expanded slot
    // numbers so a search for any single number in a range (e.g. "43" within
    // "42-45") still matches.
    disc.searchText = [book, number, numbers.join(' '), artist, title, year, genre, tags.join(' '), notes]
      .join(' ')
      .toLowerCase();

    // Precompute the shelf-location label ("Book 2 · #42–43") once.
    disc.locationLabel = formatLocation(disc);

    discs.push(disc);
  });

  return discs;
}


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
const ART_MISS = ' miss'; // sentinel that can't collide with a real URL
let artCache = loadArtCache();

function loadArtCache() {
  try {
    const raw = localStorage.getItem(CONFIG.MUSICBRAINZ.CACHE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch (err) {
    // localStorage disabled/full or bad JSON — degrade to an in-memory cache.
    return {};
  }
}

function persistArtCache() {
  try {
    localStorage.setItem(CONFIG.MUSICBRAINZ.CACHE_KEY, JSON.stringify(artCache));
  } catch (err) {
    // Out of quota or unavailable — keep going with the in-memory copy.
  }
}

// Stable cache key for a disc. Lowercased + whitespace-collapsed so trivial
// formatting differences don't cause misses.
function artCacheKey(disc) {
  const norm = (s) => s.toLowerCase().replace(/\s+/g, ' ').trim();
  return `${norm(disc.artist)}|${norm(disc.title)}`;
}

// --- throttle -----------------------------------------------------------
// Serialize MusicBrainz network calls with a minimum gap between them. Cache
// hits never enter this queue, so browsing cached discs stays instant.
let mbChain = Promise.resolve();
let mbLastCall = 0;

function throttledMbFetch(url) {
  const run = async () => {
    const gap = CONFIG.MUSICBRAINZ.THROTTLE_MS - (nowMs() - mbLastCall);
    if (gap > 0) await delay(gap);
    mbLastCall = nowMs();
    return fetch(url, { headers: { Accept: 'application/json' } });
  };
  // Chain so calls run one-at-a-time; a failure in one shouldn't break the
  // chain for the next, so swallow errors on the chaining link only.
  const result = mbChain.then(run, run);
  mbChain = result.then(() => {}, () => {});
  return result;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function nowMs() {
  return (typeof performance !== 'undefined' ? performance.now() : Date.now());
}

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
      const mbid = await findReleaseGroupMbid(disc);
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

  const res = await throttledMbFetch(url);
  if (!res.ok) throw new Error(`MusicBrainz ${res.status}`);
  const data = await res.json();

  const groups = data['release-groups'] || [];
  if (groups.length === 0) return null;
  return groups[0].id || null;
}

// Escape characters that are special to MusicBrainz's Lucene query syntax.
function escapeLucene(str) {
  return str.replace(/[+\-&|!(){}\[\]^"~*?:\\/]/g, '\\$&');
}


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
  dom.body          = document.body;
}

// Announce something to screen readers via the polite live region.
function announce(message) {
  dom.liveRegion.textContent = message;
}

// Build the stats "data card": total + per-genre counts.
function renderStats(discs) {
  dom.statTotal.textContent = discs.length;

  const counts = {};
  for (const d of discs) counts[d.genre] = (counts[d.genre] || 0) + 1;

  const ordered = Object.entries(counts).sort((a, b) => b[1] - a[1]);

  dom.statGenres.innerHTML = '';
  for (const [genre, count] of ordered) {
    const li = document.createElement('li');
    li.innerHTML =
      `<span class="g-name">${escapeHtml(genre)}</span>` +
      `<span class="g-dots" aria-hidden="true"></span>` +
      `<span class="g-count">${count}</span>`;
    dom.statGenres.appendChild(li);
  }
}

// Build the filter pill rails for genres and tags.
function renderPills(discs) {
  const genres = new Set();
  const tags = new Set();
  for (const d of discs) {
    genres.add(d.genre);
    d.tags.forEach((t) => tags.add(t));
  }

  buildPillRail(dom.genrePills, [...genres].sort(), 'genre');
  buildPillRail(dom.tagPills, [...tags].sort((a, b) => a.localeCompare(b)), 'tag');

  // Hide the tags group heading area gracefully if there are no tags at all.
  dom.tagPills.closest('.filter-group').hidden = tags.size === 0;
}

function buildPillRail(rail, values, type) {
  rail.innerHTML = '';
  for (const value of values) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'pill';
    btn.textContent = value;
    btn.setAttribute('aria-pressed', 'false');
    btn.dataset.filterType = type;
    btn.dataset.filterValue = value;
    rail.appendChild(btn);
  }
}

/**
 * Render a set of disc cards into the grid.
 * Handles cover art vs generated placeholder, and kicks off async color
 * sampling for real art so the card shadow gets tinted once it loads.
 */
function renderCards(discs) {
  dom.grid.innerHTML = '';

  const frag = document.createDocumentFragment();
  discs.forEach((disc, i) => {
    frag.appendChild(buildCard(disc, i));
  });
  dom.grid.appendChild(frag);

  // Stagger the fade/slide-in. Reduced motion → show immediately.
  const cards = dom.grid.querySelectorAll('.card');
  if (reducedMotion()) {
    cards.forEach((c) => c.classList.add('is-in'));
  } else {
    cards.forEach((card, i) => {
      const delay = Math.min(i * 35, 600); // cap so big grids don't drag
      setTimeout(() => card.classList.add('is-in'), delay);
    });
  }
}

function buildCard(disc, index) {
  const li = document.createElement('li');
  li.className = 'grid-item';

  const card = document.createElement('button');
  card.type = 'button';
  card.className = 'card';
  card.style.setProperty('--card-shadow', disc.coverColor);
  card.addEventListener('click', () => openDetail(disc));

  // Cover
  const coverWrap = document.createElement('div');
  coverWrap.className = 'card-cover-wrap';

  const img = document.createElement('img');
  img.className = 'card-cover';
  img.loading = 'lazy';
  img.decoding = 'async';
  // Decorative here: the artist + title are already text inside the button, so
  // giving the image alt text would make screen readers announce them twice.
  img.alt = '';
  setCoverImage(img, disc, card);
  coverWrap.appendChild(img);

  // Shelf-location accession tag (omit entirely if blank). Shows book + slot,
  // e.g. "B2 · #42–43"; a multi-disc release shows its slot range.
  if (disc.locationLabel) {
    const num = document.createElement('span');
    num.className = 'card-number';
    num.textContent = disc.locationLabel;
    coverWrap.appendChild(num);
  }

  card.appendChild(coverWrap);

  // Body
  const body = document.createElement('div');
  body.className = 'card-body';

  const artist = document.createElement('span');
  artist.className = 'card-artist';
  artist.textContent = disc.artist;

  const title = document.createElement('span');
  title.className = 'card-title';
  title.textContent = disc.title;

  body.appendChild(artist);
  body.appendChild(title);

  if (disc.year) {
    const year = document.createElement('span');
    year.className = 'card-year';
    year.textContent = disc.year;
    body.appendChild(year);
  }

  card.appendChild(body);
  li.appendChild(card);

  // Remember the card node so shuffle can scroll/pulse it.
  disc._cardEl = card;
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
// One shared observer for the whole grid. When a placeholder card scrolls near
// the viewport, resolve its real art (once) and swap it in if found. rootMargin
// starts the lookup a bit before the card is fully visible.
let artObserver = null;

function getArtObserver() {
  if (artObserver || typeof IntersectionObserver === 'undefined') return artObserver;
  artObserver = new IntersectionObserver((entries, obs) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const card = entry.target;
      obs.unobserve(card); // resolve at most once per card
      const { disc, img } = card._artTarget || {};
      if (disc && img) resolveAndSwap(img, disc, card);
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
  if (url) loadRealCover(img, disc, card, url);
}

// Open the detail dialog for a disc.
function openDetail(disc) {
  // Location line, spelled out: "Book 2 · Catalog #42–43 (2 discs)".
  // Each part is optional; if there's neither book nor number it's uncataloged.
  const locParts = [];
  if (disc.book) locParts.push(`Book ${disc.book}`);
  if (disc.numberLabel) {
    locParts.push(`Catalog #${disc.numberLabel}${disc.discCount > 1 ? ` (${disc.discCount} discs)` : ''}`);
  }
  dom.detailNumber.textContent = locParts.length ? locParts.join(' · ') : 'Uncataloged';
  dom.detailTitle.textContent = disc.title;
  dom.detailArtist.textContent = disc.artist;

  // Dialog background: a solid, opaque tint from the cover color (blended into
  // paper) — not translucent, so nothing from the page bleeds through.
  const tint = blendWithPaper(hexToRgb(safeHex(disc.coverColor)), 0.16);
  dom.detail.style.setProperty('--detail-bg', tint);

  dom.detailCover.innerHTML = '';
  const img = document.createElement('img');
  // Intrinsic 1:1 dimensions so the browser reserves a square box before the
  // art loads — no layout shift as it streams in. CSS scales it to fit.
  img.width = 400;
  img.height = 400;
  img.alt = `${disc.artist} — ${disc.title}`;
  if (disc.art) {
    img.src = disc.art;
    img.addEventListener('error', () => { img.src = generatePlaceholderCover(disc); });
  } else {
    // No sheet Art URL: show the placeholder now, then try MusicBrainz. Opening
    // the detail is a deliberate on-screen action, so it's fair to resolve here;
    // a cache hit swaps in instantly, a miss just leaves the placeholder.
    img.src = generatePlaceholderCover(disc);
    resolveCoverArt(disc).then((url) => {
      // Only swap if the dialog still shows this disc (guard against a fast
      // close/reopen on another disc while the lookup was in flight).
      if (url && dom.detail.open && dom.detailArtist.textContent === disc.artist
          && dom.detailTitle.textContent === disc.title) {
        img.src = url;
      }
    });
  }
  dom.detailCover.appendChild(img);

  // Meta rows: only show fields that have content.
  dom.detailMeta.innerHTML = '';
  if (disc.year)  addMetaRow('Year', disc.year);
  addMetaRow('Genre', disc.genre);

  // Tags
  dom.detailTags.innerHTML = '';
  disc.tags.forEach((t) => {
    const chip = document.createElement('span');
    chip.className = 'detail-tag';
    chip.textContent = t;
    dom.detailTags.appendChild(chip);
  });

  // Notes (hidden when empty via CSS :empty)
  dom.detailNotes.textContent = disc.notes || '';

  if (typeof dom.detail.showModal === 'function') {
    dom.detail.showModal();
  } else {
    dom.detail.setAttribute('open', ''); // very old browsers
  }
  // Lock background scroll while the dialog is up (see .modal-open in CSS).
  dom.body.classList.add('modal-open');
}

function addMetaRow(label, value) {
  const dt = document.createElement('dt');
  dt.textContent = label;
  const dd = document.createElement('dd');
  dd.textContent = value;
  dom.detailMeta.appendChild(dt);
  dom.detailMeta.appendChild(dd);
}

// Guard against a non-hex color slipping into hexToRgb.
function safeHex(hex) {
  return /^#[0-9a-f]{6}$/i.test(hex) ? hex : CONFIG.NEUTRAL_SHADOW;
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

// Current filter state.
const state = {
  search: '',
  genres: new Set(),
  tags: new Set(),
  sort: 'random',   // matches the #sort <select> default
};

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
      out.sort((a, b) => firstNumberOrInf(a) - firstNumberOrInf(b) || byStr(a.artist, b.artist));
      break;
    case 'book':
      // Physical shelf order: by book, then by page within the book. Discs with
      // no book sort last; ties fall back to the first page number then artist.
      out.sort((a, b) =>
        a.bookNum - b.bookNum
        || firstNumberOrInf(a) - firstNumberOrInf(b)
        || byStr(a.artist, b.artist));
      break;
    case 'artist':
      out.sort((a, b) => byStr(a.artist, b.artist) || byStr(a.title, b.title));
      break;
    case 'title':
      out.sort((a, b) => byStr(a.title, b.title) || byStr(a.artist, b.artist));
      break;
    case 'year-desc':
      out.sort((a, b) => yearOr(b, -Infinity) - yearOr(a, -Infinity) || byStr(a.artist, b.artist));
      break;
    case 'year-asc':
      out.sort((a, b) => yearOr(a, Infinity) - yearOr(b, Infinity) || byStr(a.artist, b.artist));
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

// Parse a leading integer from a string; blank/non-numeric → Infinity so it
// sorts last. Used for the Book number.
function numOrInf(value) {
  const n = parseInt(value, 10);
  return Number.isNaN(n) ? Infinity : n;
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
    announce(anyFilter ? `${n} disc${n === 1 ? '' : 's'} match your filters.` : `Showing all ${total} discs.`);
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
  applyFilters();
}

// Reset everything.
function clearAllFilters() {
  state.search = '';
  state.genres.clear();
  state.tags.clear();
  dom.search.value = '';
  document.querySelectorAll('.pill[aria-pressed="true"]')
    .forEach((p) => p.setAttribute('aria-pressed', 'false'));
  applyFilters();
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
    }, 120);
  });

  // Pills (event delegation on each rail) + mouse drag-to-scroll.
  [dom.genrePills, dom.tagPills].forEach((rail) => {
    rail.addEventListener('click', (e) => {
      // A drag that scrolled the rail shouldn't also toggle a pill.
      if (rail._suppressClick) { rail._suppressClick = false; return; }
      const pill = e.target.closest('.pill');
      if (pill) togglePill(pill);
    });
    enableDragScroll(rail);
  });

  dom.clearFilters.addEventListener('click', clearAllFilters);
  dom.shuffle.addEventListener('click', shuffle);

  // Sort order: re-render in the chosen order. Sort is a display preference,
  // independent of the filters, so it survives "Clear filters".
  dom.sort.addEventListener('change', () => {
    state.sort = dom.sort.value;
    applyFilters({ announceResults: false });
    const label = dom.sort.options[dom.sort.selectedIndex].text;
    announce(`Sorted by ${label}.`);
  });

  // Detail dialog close.
  dom.detailClose.addEventListener('click', () => dom.detail.close());
  // Click on the backdrop (outside the inner panel) closes it too. A click that
  // lands on the dialog element itself is the backdrop — but the dialog's own
  // scrollbar reports the same target, so only treat clicks that fall outside
  // the panel's box as a backdrop click (a scrollbar drag stays inside it).
  dom.detail.addEventListener('click', (e) => {
    if (e.target !== dom.detail) return;
    const r = dom.detail.getBoundingClientRect();
    const inside = e.clientX >= r.left && e.clientX <= r.right &&
                   e.clientY >= r.top  && e.clientY <= r.bottom;
    if (!inside) dom.detail.close();
  });
  // Release the background scroll lock however the dialog was dismissed
  // (button, backdrop, or Esc — all funnel through the native close event).
  dom.detail.addEventListener('close', () => dom.body.classList.remove('modal-open'));
}

// Pull shared theme colors from the stylesheet so CSS stays canonical. Each
// read is validated; a missing/blank var (e.g. stylesheet failed to load)
// leaves the baked-in fallback in place rather than corrupting a color.
function hydrateThemeConstants() {
  const shadow = cssVar('--shadow-neutral');
  if (/^#[0-9a-f]{6}$/i.test(shadow)) CONFIG.NEUTRAL_SHADOW = shadow;

  const paper = cssVar('--paper');
  if (/^#[0-9a-f]{6}$/i.test(paper)) PAPER_RGB = hexToRgb(paper);
}

async function init() {
  cacheDom();
  hydrateThemeConstants();
  // Sync state with the select's actual value — browsers may restore a
  // previously-chosen option across reloads, and state must match what's shown.
  state.sort = dom.sort.value;
  wireEvents();

  try {
    DISCS = await loadCollection();

    if (DISCS.length === 0) {
      dom.stateMsg.textContent = 'The collection is empty right now.';
      announce('The collection is empty right now.');
      return;
    }

    renderStats(DISCS);
    renderPills(DISCS);
    dom.stateMsg.hidden = true;
    applyFilters({ announceResults: false });
    announce(`Loaded ${DISCS.length} discs.`);
  } catch (err) {
    console.error('Failed to load collection:', err);
    dom.stateMsg.hidden = false;
    dom.stateMsg.classList.add('is-error');
    dom.stateMsg.textContent = 'Could not load the collection. Please try again later.';
    announce('Could not load the collection. Please try again later.');
  }
}

document.addEventListener('DOMContentLoaded', init);
