/* ============================================================
   state.js — acting on what's showing
   ------------------------------------------------------------
   Filtering, sorting, the view toggle, CSV export, and shuffle:
   the verbs. The nouns they act on — `DISCS`, `state` and the
   defaults — are in store.js, so that the modules below this one
   can read them without importing this file back.

   `state` is mirrored to the querystring by url.js, so every
   combination reachable here is a link that can be sent to someone.

   What's here is the part that needs the page: reading `state`,
   writing to `dom`, announcing. The comparators, the query parser
   and the CSV escaping are in discs.js, which imports nothing and
   is tested in test/discs.test.mjs.
   ============================================================ */
import { reducedMotion, foldText, hideWithoutLosingFocus } from './util.js';
import { searchTerms, matchesFilters, sortDiscs, csvCell } from './discs.js';
import { CONFIG as SHEET, noun, activeSource } from './collection.js';
import { dom } from './dom.js';
import { DISCS, VIEWS, state } from './store.js';
import { announce, announceCount, cancelCountAnnounce, layoutTagCloud, renderCards, openCard } from './render.js';
import { syncViewControls } from './controls.js';
import { syncUrl } from './url.js';


// sortDiscs, searchTerms, matchesFilters and csvCell live in discs.js — see the
// note at the top of that file. They're the ones that are a function of their
// arguments alone, and being out from under this module's DOM imports is what
// makes them loadable, and therefore testable, outside a browser.

// Compute the currently-visible discs from state.
function currentMatches() {
  // Folded the same way as disc.searchText, so an unaccented query still
  // matches accented text (and an accented query matches too).
  const terms = searchTerms(foldText(state.search));
  const { genres, tags } = state;
  return DISCS.filter((d) => matchesFilters(d, { terms, genres, tags }));
}

// What's on screen: matched, then ordered. Both callers want both steps, and
// pairing them here means `state.sort` is read in exactly one place now that
// sortDiscs takes the mode as an argument instead of reaching for it.
function currentView() {
  return sortDiscs(currentMatches(), state.sort);
}

// Re-render the grid + results readout for the current filter state.
export function applyFilters({ announceResults = true } = {}) {
  const matches = currentView();
  renderCards(matches);

  const n = matches.length;
  const total = DISCS.length;
  const anyFilter = state.search || state.genres.size || state.tags.size;

  // "discs" on the shelf, "records" on the wishlist — see SOURCES in
  // collection.js. Both counts describe the same number, so both take their
  // plural from the total rather than from the filtered figure beside it.
  dom.resultsCount.textContent = anyFilter
    ? `${n} of ${total} ${noun(total)}`
    : `${total} ${noun(total)}`;

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
    dom.stateMsg.textContent = `No ${noun()} match those filters.`;
  } else {
    dom.stateMsg.hidden = true;
  }

  // Focusing the readout above makes most screen readers read it out, so the
  // polite count would arrive ~700ms later saying the same thing a second time.
  // When focus just moved there, the readout speaks for itself.
  if (announceResults && !focusMoved) {
    announceCount(anyFilter
      ? `${n} ${noun(n)} match your filters.`
      : `Showing all ${total} ${noun(total)}.`);
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
  const discs = currentView();
  if (discs.length === 0) {
    announce(`Nothing to export — no ${noun()} match your filters.`);
    return;
  }

  const C = SHEET.COLUMNS;
  // Ordered to match the sheet's header row, so a paste lines up column for
  // column instead of quietly landing Notes under Art URL. The wishlist tab has
  // no Book or Number — nothing on it has a shelf position, which is the point
  // of it — so those two are dropped rather than exported as a pair of empty
  // columns that would shift every cell of a paste-back one place left.
  const shelved = activeSource() === 'collection';
  const headers = [
    ...(shelved ? [C.book, C.number] : []),
    C.artist, C.title, C.year, C.genre, C.tags, C.art, C.notes, C.barcode,
  ];
  // Barcode as the *cell*, not as the digits the lookup uses: normalizing it on
  // the way out would rewrite the sheet's own formatting for no reason, and a
  // cell parseBarcode rejects would come back blank, which isn't a rewrite —
  // it's a deletion of whatever was in there.
  const rows = discs.map((d) => [
    ...(shelved ? [d.book, d.number] : []),
    d.rawArtist, d.rawTitle, d.year, d.rawGenre, d.tags.join(', '),
    d.art, d.notes, d.rawBarcode,
  ]);

  const csv = [headers, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n');
  // A BOM so Excel opens UTF-8 as UTF-8 rather than mangling accented names.
  // Written as an escape, not a literal: a raw U+FEFF is invisible in every
  // editor and the next whitespace cleanup would silently delete it.
  downloadFile(`\uFEFF${csv}`, 'text/csv;charset=utf-8', exportFilename());
  announce(`Exported ${discs.length} ${noun(discs.length)}.`);
}


// Name the download after what it contains: filtered exports say so, and every
// file is dated so successive snapshots don't overwrite each other.
function exportFilename() {
  const stamp = new Date().toISOString().slice(0, 10);
  const filtered = state.search || state.genres.size || state.tags.size;
  return `cd-${activeSource()}${filtered ? '-filtered' : ''}-${stamp}.csv`;
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
    announce(`No ${noun()} to shuffle. Clear a filter and try again.`);
    return;
  }

  const pick = pool[Math.floor(Math.random() * pool.length)];

  const land = () => {
    const card = pick._cardEl;
    if (card) {
      // Focus the card before anything else. Opening the card is about to call
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
    // Through render.js's registered opener rather than detail.js directly: a
    // card click and a shuffle land on the same disc the same way, and this
    // module doesn't have to know the dialog exists. See setCardOpener.
    openCard(pick);
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
