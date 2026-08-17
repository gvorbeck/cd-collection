/* ============================================================
   discs.js — the collection as data, with no page attached
   ------------------------------------------------------------
   Three things state.js does that don't need a browser to do:
   parse a search box into terms, decide whether one disc answers
   the current filters, and put a list of them in order. Plus the
   CSV escaping the export goes out through.

   They live here rather than in state.js because state.js reaches
   the DOM at every turn — it imports dom.js, render.js, controls.js
   and url.js — and a module that does that can't be loaded outside
   a browser at all. These four can, which is the whole point:
   they are the part of browsing the collection where being subtly
   wrong produces no error, just a shelf in a slightly wrong order
   or a search that quietly finds nothing, and that is exactly the
   kind of wrong a test catches and a person doesn't.

   Nothing here reads `state`. Everything is a function of its
   arguments, so the caller passes the mode and the filters in.
   Nothing here imports anything either — keep it that way, or
   test/discs.test.mjs stops being able to load it.
   ============================================================ */

// One collator for every string comparison in this file. `localeCompare(a, b,
// undefined, { sensitivity: 'base' })` builds a fresh collator per call, which
// is both the allocation and a miss on the engine's cached-collator fast path:
// sorting 300 discs by artist measured 4.17ms that way against 0.107ms this
// way. Same semantics either way — case- and accent-insensitive, ordered by the
// browser's own locale, so "Ángel" files with the A's and not after Z.
const collator = new Intl.Collator(undefined, { sensitivity: 'base' });
const byStr = (a, b) => collator.compare(a, b);


/**
 * Split an already-folded query into the terms a disc must ALL contain.
 *
 * Whitespace separates terms; double quotes hold one together, so
 * `"kind of blue" davis` is two terms rather than four. A quote left unclosed
 * (which is every quoted search halfway through being typed) runs to the end of
 * the query instead of matching the quote character literally and finding
 * nothing.
 */
export function searchTerms(query) {
  const terms = [];
  // Either a quoted run — closing quote optional, see above — or a bare word.
  // Both alternatives consume at least one character, so exec can't spin.
  const re = /"([^"]*)"?|(\S+)/g;
  let match;
  while ((match = re.exec(String(query == null ? '' : query))) !== null) {
    const term = (match[1] !== undefined ? match[1] : match[2]).trim();
    if (term) terms.push(term);
  }
  return terms;
}

/**
 * Does one disc survive the current filters?
 *
 * `terms` comes from searchTerms() over an already-folded query, so it is
 * compared against disc.searchText, which was folded the same way — an
 * unaccented query still matches accented text, and an accented one matches
 * too. `genres` and `tags` are Sets; empty means "no filter of that kind".
 */
export function matchesFilters(disc, { terms = [], genres, tags } = {}) {
  // Search matches across every column via the precomputed blob, and every
  // term has to be in there somewhere — but not adjacent, and not in the
  // blob's column order. That order is the shelf's (book, number, artist,
  // title, year, genre, tags, notes), which nobody types in: as one
  // contiguous substring this test found nothing for "miles kind of blue",
  // "coltrane love supreme" or "1959 miles".
  //
  // The honest cost of AND-ing terms is that they can land in different
  // fields: a disc with "kind" in its notes, "of" in its title and "blue" in
  // its genre now matches that query. That's the trade — a term that turns up
  // anywhere on the record is what someone searching a shelf means, and
  // quotes are there for when it isn't. ?q= still carries the query verbatim,
  // and every term of an old contiguous match is still present in the blob,
  // so an already-shared link resolves to what it always did (plus, at worst,
  // company).
  for (const term of terms) if (!disc.searchText.includes(term)) return false;
  if (genres && genres.size && !genres.has(disc.genre)) return false;
  // Tag filter: disc must carry every selected tag (AND semantics).
  if (tags && tags.size) {
    for (const t of tags) if (!disc.tags.includes(t)) return false;
  }
  return true;
}

/**
 * Return a new array of discs ordered per `mode`.
 * Sorting only affects display order — never the array passed in — so
 * switching modes (or the "Random" key) can't corrupt anything else.
 *   random     → the stable per-load _rand key (different every page load)
 *   number     → catalog number ascending, blanks last
 *   book       → by book, then page within the book (physical shelf order)
 *   artist     → artist A–Z (locale-aware), then title as a tiebreaker
 *   title      → title A–Z
 *   year-desc  → newest first, blanks last
 *   year-asc   → oldest first, blanks last
 * An unrecognized mode falls through to random rather than throwing: the value
 * can arrive from a hand-edited ?sort=, and a shuffled shelf is a better answer
 * to that than a blank page.
 */
export function sortDiscs(discs, mode) {
  const out = discs.slice();

  switch (mode) {
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


// A cell whose first character is one of these is read as a formula by Excel,
// Sheets and LibreOffice alike — no macro warning, no opt-in.
const FORMULA_LEAD = /^[=+\-@]/;

/**
 * Quote a CSV field per RFC 4180: wrap it in quotes when it contains a comma,
 * quote, or newline, and double any embedded quotes.
 *
 * Plus the part RFC 4180 has nothing to say about. The sheet is free text that
 * anyone with edit access can type into, and a Title or Notes cell beginning
 * =, +, - or @ arrives in the next spreadsheet as a live formula rather than as
 * the words someone wrote. The usual defence is what's here: quote the cell and
 * put a tab in front of the value, inside the quotes. A tab can't start a
 * formula, so the whole cell is text, and no spreadsheet renders it.
 *
 * The honest cost is that the tab is a real character. A Notes cell that
 * legitimately opens with a hyphen ("- see sleeve") comes back from a paste
 * with a leading tab in it, and re-exporting keeps it. That's the price of the
 * export not being able to run anything, and it's the right way round.
 */
export function csvCell(value) {
  const str = value == null ? '' : String(value);
  if (FORMULA_LEAD.test(str)) return `"\t${str.replace(/"/g, '""')}"`;
  return /[",\r\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}
