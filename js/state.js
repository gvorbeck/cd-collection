/* ============================================================
   state.js — the collection, and what's showing of it
   ------------------------------------------------------------
   The loaded discs, the current search/genre/tag/sort/view, and
   everything that acts on them: filtering, sorting, the view
   toggle, CSV export, and shuffle.

   `state` is mirrored to the querystring by url.js, so every
   combination reachable here is a link that can be sent to someone.
   ============================================================ */
import { reducedMotion, foldText, hideWithoutLosingFocus } from './util.js';
import { CONFIG as SHEET } from './collection.js';
import { dom } from './dom.js';
import { announce, announceCount, cancelCountAnnounce, layoutTagCloud, renderCards } from './render.js';
import { openDetail } from './detail.js';
import { syncUrl } from './url.js';


// The full collection once loaded. Filled in place by init() rather than
// reassigned: every importer holds this same array.
export const DISCS = [];

// Defaults. A value equal to its default is left OUT of the URL, so a plain
// visit stays at a clean `/` rather than carrying a string of no-op params.
export const DEFAULT_SORT = 'random'; // matches the #sort <select> default
export const DEFAULT_VIEW = 'grid';
export const VIEWS = ['grid', 'list'];

// Current filter state. Mirrored to the querystring by url.js, so any view of
// the collection is a shareable link.
export const state = {
  search: '',
  genres: new Set(),
  tags: new Set(),
  sort: DEFAULT_SORT,
  view: DEFAULT_VIEW,   // 'grid' (cover wall) or 'list' (dense shelf list)
};

// One collator for every string comparison in this file. `localeCompare(a, b,
// undefined, { sensitivity: 'base' })` builds a fresh collator per call, which
// is both the allocation and a miss on the engine's cached-collator fast path:
// sorting 300 discs by artist measured 4.17ms that way against 0.107ms this
// way. Same semantics either way — case- and accent-insensitive, ordered by the
// browser's own locale, so "Ángel" files with the A's and not after Z.
const collator = new Intl.Collator(undefined, { sensitivity: 'base' });
const byStr = (a, b) => collator.compare(a, b);

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

/**
 * Split an already-folded query into the terms a disc must ALL contain.
 *
 * Whitespace separates terms; double quotes hold one together, so
 * `"kind of blue" davis` is two terms rather than four. A quote left unclosed
 * (which is every quoted search halfway through being typed) runs to the end of
 * the query instead of matching the quote character literally and finding
 * nothing.
 */
function searchTerms(query) {
  const terms = [];
  // Either a quoted run — closing quote optional, see above — or a bare word.
  // Both alternatives consume at least one character, so exec can't spin.
  const re = /"([^"]*)"?|(\S+)/g;
  let match;
  while ((match = re.exec(query)) !== null) {
    const term = (match[1] !== undefined ? match[1] : match[2]).trim();
    if (term) terms.push(term);
  }
  return terms;
}

// Compute the currently-visible discs from state.
function currentMatches() {
  // Folded the same way as disc.searchText, so an unaccented query still
  // matches accented text (and an accented query matches too).
  const terms = searchTerms(foldText(state.search));
  return DISCS.filter((d) => {
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
    for (const term of terms) if (!d.searchText.includes(term)) return false;
    if (state.genres.size && !state.genres.has(d.genre)) return false;
    // Tag filter: disc must carry every selected tag (AND semantics).
    if (state.tags.size) {
      for (const t of state.tags) if (!d.tags.includes(t)) return false;
    }
    return true;
  });
}

// Re-render the grid + results readout for the current filter state.
export function applyFilters({ announceResults = true } = {}) {
  const matches = sortDiscs(currentMatches());
  renderCards(matches);

  const n = matches.length;
  const total = DISCS.length;
  const anyFilter = state.search || state.genres.size || state.tags.size;

  dom.resultsCount.textContent = anyFilter
    ? `${n} of ${total} disc${total === 1 ? '' : 's'}`
    : `${total} disc${total === 1 ? '' : 's'}`;

  // "Clear filters" hides itself the instant it works, and the UA's [hidden]
  // rule would take the keyboard user's focus down with it. Hand focus to the
  // results readout instead: it sits just ahead of the tools cluster, so Tab
  // carries on from roughly where the button was, and its text is literally the
  // answer to what the button just did.
  let focusMoved = false;
  if (anyFilter) {
    dom.clearFilters.hidden = false;
  } else {
    focusMoved = hideWithoutLosingFocus(dom.clearFilters, dom.resultsCount);
  }

  if (n === 0) {
    dom.stateMsg.hidden = false;
    dom.stateMsg.classList.remove('is-error');
    dom.stateMsg.textContent = 'No discs match those filters.';
  } else {
    dom.stateMsg.hidden = true;
  }

  // Focusing the readout above makes most screen readers read it out, so the
  // polite count would arrive ~700ms later saying the same thing a second time.
  // When focus just moved there, the readout speaks for itself.
  if (announceResults && !focusMoved) {
    announceCount(anyFilter ? `${n} disc${n === 1 ? '' : 's'} match your filters.` : `Showing all ${total} discs.`);
  } else {
    // Deciding not to announce has to be said out loud, because the last
    // keystroke's 700ms timer is still armed and will otherwise read out the
    // count from before this render. In the focusMoved case that lands right on
    // top of the readout the guard above exists to keep clear.
    cancelCountAnnounce();
  }
}

// Toggle a pill's filter value and refresh.
export function togglePill(btn) {
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
export function clearAllFilters() {
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
export function setView(view) {
  if (!VIEWS.includes(view) || view === state.view) return;
  state.view = view;
  syncViewControls();
  applyFilters({ announceResults: false });
  syncUrl();
  announce(view === 'list' ? 'Switched to list view.' : 'Switched to grid view.');
}

// Reflect the current view on the toggle buttons.
export function syncViewControls() {
  dom.viewToggle.querySelectorAll('[data-view]').forEach((btn) => {
    btn.setAttribute('aria-pressed', String(btn.dataset.view === state.view));
  });
}

/**
 * Download the discs currently on screen as a CSV, in the order they're shown.
 * Handy for taking a filtered slice somewhere else, or keeping a dated snapshot
 * of the collection.
 *
 * The file is a round trip, not just a report: every column the sheet has, in
 * the sheet's own order, holding the cells the sheet actually holds. So a blank
 * Artist exports blank rather than as the "Various Artists" the cards show —
 * pasting an export back must not silently commit a fallback as data. (Tags are
 * the one rewrite: they come back joined as "a, b", which is the same cell the
 * sheet started with.)
 */
export function exportCurrentCsv() {
  const discs = sortDiscs(currentMatches());
  if (discs.length === 0) {
    announce('Nothing to export — no discs match your filters.');
    return;
  }

  const C = SHEET.COLUMNS;
  // Ordered to match the sheet's header row, so a paste lines up column for
  // column instead of quietly landing Notes under Art URL.
  const headers = [C.book, C.number, C.artist, C.title, C.year, C.genre, C.tags, C.art, C.notes];
  const rows = discs.map((d) => [
    d.book, d.number, d.rawArtist, d.rawTitle, d.year, d.rawGenre, d.tags.join(', '), d.art, d.notes,
  ]);

  const csv = [headers, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n');
  // A BOM so Excel opens UTF-8 as UTF-8 rather than mangling accented names.
  // Written as an escape, not a literal: a raw U+FEFF is invisible in every
  // editor and the next whitespace cleanup would silently delete it.
  downloadFile(`\uFEFF${csv}`, 'text/csv;charset=utf-8', exportFilename());
  announce(`Exported ${discs.length} disc${discs.length === 1 ? '' : 's'}.`);
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
function csvCell(value) {
  const str = value == null ? '' : String(value);
  if (FORMULA_LEAD.test(str)) return `"\t${str.replace(/"/g, '""')}"`;
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

// How long the "this is the one" marker stays on the landed card. A shade
// longer than the 0.9s shuffleLand animation in the stylesheet, so removing the
// class never cuts the pulse short.
const SHUFFLE_MARK_MS = 950;

/**
 * Shuffle: pick a random disc from the *currently visible* set, scroll to it,
 * pulse it, and open its detail view. Playful spin on the button first,
 * unless reduced motion is on.
 */
export function shuffle() {
  const pool = currentMatches();
  if (pool.length === 0) {
    announce('No discs to shuffle. Clear a filter and try again.');
    return;
  }

  const pick = pool[Math.floor(Math.random() * pool.length)];

  const land = () => {
    const card = pick._cardEl;
    if (card) {
      // Focus the card before anything else. openDetail is about to call
      // showModal(), which records whatever holds focus as where Esc will put
      // it back — and that's the shuffle button, up in the controls, several
      // screens from where the page is about to be. preventScroll because
      // scrollIntoView below owns where we end up; focus() just says which
      // element the keyboard is on when the dialog closes.
      card.focus({ preventScroll: true });
      card.scrollIntoView({
        behavior: reducedMotion() ? 'auto' : 'smooth',
        block: 'center',
      });
      card.classList.remove('is-shuffled');
      // reflow so the animation can retrigger
      void card.offsetWidth;
      card.classList.add('is-shuffled');
      // Give the marker its own lifetime. Normally .is-shuffled is a 0.9s pulse
      // that ends itself, but under reduced motion the stylesheet swaps the
      // animation for a plain outline — and an outline never ends, so without
      // this the card wore it until the next shuffle, or all session if there
      // wasn't one. A timer rather than an `animationend` listener for exactly
      // that reason: the branch that needs cleaning up has no animation to end.
      clearTimeout(card._shuffleMarkTimer);
      card._shuffleMarkTimer = setTimeout(() => {
        card.classList.remove('is-shuffled');
        card._shuffleMarkTimer = null;
      }, SHUFFLE_MARK_MS);
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
