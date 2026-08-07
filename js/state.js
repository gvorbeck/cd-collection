/* ============================================================
   state.js — the collection, and what's showing of it
   ------------------------------------------------------------
   The loaded discs, the current search/genre/tag/sort/view, and
   everything that acts on them: filtering, sorting, the view
   toggle, CSV export, and shuffle.

   `state` is mirrored to the querystring by url.js, so every
   combination reachable here is a link that can be sent to someone.
   ============================================================ */
import { reducedMotion, foldText } from './util.js';
import { CONFIG as SHEET } from './collection.js';
import { dom } from './dom.js';
import { announce, announceCount, layoutTagCloud, renderCards } from './render.js';
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
  // Folded the same way as disc.searchText, so an unaccented query still
  // matches accented text (and an accented query matches too).
  const q = foldText(state.search);
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
export function applyFilters({ announceResults = true } = {}) {
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
 * Columns match the sheet's, so an export can be pasted straight back into a
 * spreadsheet — handy for taking a filtered slice somewhere else, or keeping a
 * dated snapshot of the collection.
 */
export function exportCurrentCsv() {
  const discs = sortDiscs(currentMatches());
  if (discs.length === 0) {
    announce('Nothing to export — no discs match your filters.');
    return;
  }

  const C = SHEET.COLUMNS;
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
