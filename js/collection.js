/* ============================================================
   collection.js — the shared data layer
   ------------------------------------------------------------
   Everything about *reading the sheet* lives here — the CSV
   source, the column names, the blank-cell fallbacks, and the
   parsing that turns a raw CSV row into a disc object. Anything
   about *showing* a disc (colors, covers, layout) stays in the
   page that shows it — the two DOM helpers here (el, escapeHtml)
   are the exception, because every page builds elements and none
   of them should own the helper.

   All three pages import from here, and they agree on what a disc
   *is* precisely because they all read it from this one file.

   Requires PapaParse on `window` — a plain <script> in each page,
   which runs before any module does. No build step.
   ============================================================ */


/* ----------------------------------------------------------
   Config — edit here
   ---------------------------------------------------------- */
export const CONFIG = {
  // Published Google Sheet, CSV output.
  CSV_URL: 'https://docs.google.com/spreadsheets/d/e/2PACX-1vSV9mf7fFJZ25gUb2PUNWqO6y6f5KUJDApmgiiYMZ0fiFr6FELE6IC-6tbvSOj31jDZ82tazs1jdUuR/pub?gid=1454994388&single=true&output=csv',

  // Design/preview aid: loading any page with ?sample in the URL reads the
  // bundled sample.csv instead of the live sheet, so layouts can be built out
  // with a full spread of dummy discs. Production (no query param) is untouched.
  SAMPLE_URL: 'sample.csv',

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
};


/* ----------------------------------------------------------
   Small shared helpers
   ---------------------------------------------------------- */

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
 * Shelf-location label from a disc's book + slot numbers. The Number is the
 * page within a book, so a book is needed to make the location unambiguous.
 * Two verbosities share one assembly:
 *   terse   (card tag): "B2 · #42–43"   "B2"   "#42–43"
 *   verbose (detail):   "Book 2 · Catalog #42–43 (2 discs)"
 * Either way, no book and no number → "" (card shows no tag; detail's caller
 * substitutes "Uncataloged").
 */
export function formatLocation(disc, { verbose = false } = {}) {
  const parts = [];
  if (disc.book) parts.push(verbose ? `Book ${disc.book}` : `B${disc.book}`);
  if (disc.numberLabel) {
    const count = verbose && disc.discCount > 1 ? ` (${disc.discCount} discs)` : '';
    parts.push(`${verbose ? 'Catalog #' : '#'}${disc.numberLabel}${count}`);
  }
  return parts.join(' · ');
}

// Leading article ("The", "A", "An") to ignore when alphabetizing — so
// "The Beatles" files under B and "A Tribe Called Quest" under T, the way a
// record shelf does. Case-insensitive; requires a following space so a name
// like "Anthrax" or "Theory of a Deadman" isn't mangled.
function sortKey(str) {
  return str.replace(/^(the|a|an)\s+/i, '').trim();
}

// Parse a leading integer from a string; blank/non-numeric → Infinity so it
// sorts last. Used for the Book number.
function numOrInf(value) {
  const n = parseInt(value, 10);
  return Number.isNaN(n) ? Infinity : n;
}

// Create an element with an optional class and text content in one call.
export function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

// Escape text destined for innerHTML. We mostly use textContent, but a few
// spots build markup — keep them safe.
export function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

/**
 * URL-safe slug from a string: lowercase, accents stripped, runs of anything
 * non-alphanumeric collapsed to a single hyphen. Used to build the shareable
 * per-disc identifier in the address bar.
 */
function slugify(str) {
  return str
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // drop diacritics
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

// True when the current page was loaded with ?sample.
export function usingSample() {
  return new URLSearchParams(location.search).has('sample');
}

/**
 * Register the service worker that makes the site work offline (see sw.js).
 * Lives here rather than in one page's script because every page wants it and
 * the worker's scope covers all of them either way.
 *
 * Skipped on file:// and plain http (other than localhost), where service
 * workers are unavailable — registering there only logs a security error.
 */
export function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  if (location.protocol !== 'https:' && location.hostname !== 'localhost') return;
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch((err) => {
      console.warn('Service worker registration failed:', err);
    });
  });
}


/* ----------------------------------------------------------
   Loading + normalization
   ---------------------------------------------------------- */

/**
 * Load the sheet with PapaParse and normalize into disc objects.
 * We read only the columns we know, but keep the raw row around so adding
 * a new column later never breaks parsing.
 */
export function load() {
  const source = usingSample() ? CONFIG.SAMPLE_URL : CONFIG.CSV_URL;

  return new Promise((resolve, reject) => {
    Papa.parse(source, {
      download: true,
      header: true,
      skipEmptyLines: 'greedy', // drop rows that are entirely blank
      complete: (results) => {
        try {
          assertExpectedHeaders(results.meta && results.meta.fields);
          resolve(normalizeRows(results.data));
        } catch (err) {
          reject(err);
        }
      },
      error: (err) => reject(err),
    });
  });
}

/**
 * Fail loudly if the sheet's header row doesn't carry the columns we read by.
 * Without this, a renamed/moved column just makes col() return '' everywhere,
 * so every disc silently falls back (all "Various Artists", all "Self-Titled")
 * and the page looks "loaded" but wrong. Artist and Title are a disc's identity;
 * if neither header is present the sheet is misconfigured, so throw and let
 * the caller's catch show the error state instead of a wall of fallbacks.
 */
function assertExpectedHeaders(fields) {
  const headers = Array.isArray(fields) ? fields.map(clean) : [];
  const has = (name) => headers.includes(name);
  if (!has(CONFIG.COLUMNS.artist) && !has(CONFIG.COLUMNS.title)) {
    throw new Error(
      `Sheet is missing its expected columns (looked for "${CONFIG.COLUMNS.artist}" ` +
      `and "${CONFIG.COLUMNS.title}"). Found: ${headers.length ? headers.join(', ') : '(none)'}.`
    );
  }
}

/** Turn raw CSV row objects into clean disc objects with fallbacks applied. */
function normalizeRows(rows) {
  const discs = [];
  // Slugs must be unique to work as links; remember the ones handed out so a
  // second "Greatest Hits" by the same artist gets "-2" rather than colliding.
  const slugsSeen = new Map();

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
      // Alphabetization keys with any leading article stripped, so "The Beatles"
      // files under B and "A Hard Day's Night" under H. Computed once here; the
      // sort comparators read these instead of the display strings.
      sortArtist: sortKey(artist),
      sortTitle:  sortKey(title),
      year,
      genre,
      tags,
      art,
      notes,
      // Stable random key for the "Random" sort: assigned once per page load,
      // so the shelf looks different every visit but doesn't reshuffle on each
      // keystroke while filtering. A fresh load re-randomizes it.
      _rand: Math.random(),
    };

    // Shareable identifier for the address bar. Derived from artist + title
    // rather than the row index, so a link keeps working after rows are
    // re-sorted or inserted in the sheet — an index-based id would silently
    // start pointing at a different disc.
    disc.slug = uniqueSlug(slugsSeen, `${artist}-${title}`);

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

// Slugify `base`, appending -2, -3… if that slug has already been used.
// A fully non-alphanumeric name (or a blank one) still needs *some* handle,
// so it falls back to "disc".
function uniqueSlug(seen, base) {
  const root = slugify(base) || 'disc';
  const used = seen.get(root) || 0;
  seen.set(root, used + 1);
  return used === 0 ? root : `${root}-${used + 1}`;
}


