/* ============================================================
   CD COLLECTION — app.js
   ------------------------------------------------------------
   The grid page's entry point: wire the controls up, hydrate the
   theme constants out of the stylesheet, load the sheet, render.
   Nothing else imports this file; it is the end of every chain.

   The modules it pulls together, roughly in dependency order:

     errors.js      the global error reporter (imported first, on purpose)
     collection.js  the sheet: fetch, parse, disc objects (shared)
     musicbrainz.js the MB web service + its 1/sec throttle (shared)
     config.js      presentation settings
     util.js        small helpers + the localStorage wrapper
     color.js       hashing, brightness, cover sampling
     cover.js       generated placeholder covers
     art.js         cover-art and tracklist lookup, cached
     dom.js         the element cache
     store.js       the discs and the current filter state, as data
     url.js         filter state and deep links in the address bar
     render.js      stats card, pills, the grid itself
     controls.js    pushing that state back out to the widgets
     state.js       acting on it: filter, sort, view, export, shuffle
     detail.js      the disc dialog and its history entry

   That list is a real order — the graph has no cycles in it, and
   test/imports.test.mjs fails the build if one appears. Which is
   less pedantic than it sounds: a cycle here doesn't break at build
   time, it breaks at load time, as a temporal-dead-zone error
   pointing at a line with nothing wrong on it.
   ============================================================ */
// First, and deliberately so: errors.js installs the global error and
// unhandled-rejection handlers as it evaluates, and a module's imports are
// evaluated before the module's own body. Registering from inside init() would
// be too late to catch a throw from any module below this line. See errors.js.
import { reportFatal } from './errors.js';
import { CONFIG } from './config.js';
import {
  load, loadedFrom, noteDataSource, DATA_SOURCES, registerServiceWorker,
  activeSource, noun,
  staleReportForPage, listenForStaleSheet, dataSourceNotice,
} from './collection.js';
import { markOwnership } from './owned.js';
import { wireShopCheck, staleWishlistNote } from './shop.js';
import { $, isHex6, cssVar } from './util.js';
import { hexToRgb, setPaperRgb } from './color.js';
import { repaintPlaceholders } from './cover.js';
import { dom, cacheDom } from './dom.js';
import { announce, renderStats, renderPills, layoutTagCloud, enableDragScroll, repointCardImages, setCardOpener } from './render.js';
import { openDetail, dismissDetail, onDetailClosed, closeDetailForHistory, makeLabelForCurrentDisc } from './detail.js';
import { DISCS, state } from './store.js';
import { syncControlsToState, syncViewControls } from './controls.js';
import {
  applyFilters, togglePill, clearAllFilters,
  setView, exportCurrentCsv, shuffle,
} from './state.js';
import {
  discSlugFromHash, discBySlug, syncUrl, readStateFromUrl, stateSignature,
} from './url.js';


/**
 * Bring the page in line with the URL after a Back/Forward. Handles both
 * halves — the filter state and whether a disc dialog should be showing.
 *
 * Here rather than in url.js because it is the one thing in that area that
 * isn't about the address bar: it re-renders the grid, resets the controls and
 * opens or closes the dialog. Doing all that from url.js meant url.js imported
 * render.js, detail.js and state.js, which is three of the four edges that made
 * those modules a cycle.
 */
function onPopState() {
  const before = stateSignature();
  readStateFromUrl();

  // Opening and closing a disc are history entries too, and they move only the
  // hash — the grid behind the dialog is unchanged. A re-render would reorder
  // and re-reveal every card for nothing, in full view behind a dialog the user
  // is in the middle of dismissing. Only touch the grid when the grid's own
  // inputs actually changed.
  if (stateSignature() !== before) {
    syncControlsToState();
    applyFilters({ announceResults: false });
  }

  const disc = discBySlug(discSlugFromHash());
  if (disc) {
    // The entry we landed on names a disc: show it (re-pointing the dialog in
    // place if it's already open). No push — this history entry already exists.
    openDetail(disc, { pushUrl: false });
  } else if (dom.detail.open) {
    closeDetailForHistory();
  }
}


function wireEvents() {
  // What a click on a card means. render.js builds the cards and attaches the
  // listener, but it is deliberately not told what opening one does — see
  // setCardOpener there. Registered before anything can be clicked, and before
  // the first render, since shuffle goes through the same door.
  setCardOpener(openDetail);

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
  // Take this disc to the labels page with its form already filled.
  dom.detailMakeLabel.addEventListener('click', makeLabelForCurrentDisc);
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
  if (isHex6(paper)) setPaperRgb(hexToRgb(paper));
}


/* ----------------------------------------------------------
   Where these discs came from
   ----------------------------------------------------------
   The machinery — which sheet the worker answered out of its cache, when that
   copy was saved, and the sentence describing it — lives in collection.js now,
   shared with stats.js. It used to be duplicated across the two files behind a
   comment asking the next editor to change both copies, and they drifted anyway.

   What stays here is the half that really is this page's own: where the notice
   goes, and how it gets announced.
   ---------------------------------------------------------- */

/**
 * Put that line in #stale-notice, or take it back out. Returns it so the caller
 * can also say it out loud.
 *
 * It has an element of its own rather than sharing #state-msg because the two
 * say different kinds of thing: #state-msg is loading, empty and error — states
 * where there is nothing on screen — and this one describes discs that are
 * right there and fine, just not freshly fetched. It isn't in dom.js's cache
 * either; that object holds what the grid, the pills and the dialog reach for
 * over and over, and this is read twice in the life of the page.
 */
function refreshDataNotice() {
  // Called before load() settled, or after it failed outright: #state-msg is
  // still carrying the loading line or the error, and a note about which copy
  // we read would only crowd the more urgent thing the page is already saying.
  if (!loadedFrom()) return '';
  // "showing" — this page is displaying the saved copy. stats.js passes
  // "counted from" for the same sentence; see dataSourceNotice in collection.js.
  const notice = dataSourceNotice('showing');
  // Looked up rather than assumed: markup is cached and revalidated separately
  // from the module that reads it, and a null dereference here would be caught
  // by init()'s catch and report a failed load for a collection that loaded
  // perfectly well. The announcement still carries the notice either way.
  const box = $('stale-notice');
  if (box) {
    box.hidden = !notice;
    if (notice) box.textContent = notice;
  }
  return notice;
}


async function init() {
  // Outside both try blocks below, and safe there: cacheDom() only ever calls
  // getElementById, which answers null rather than throwing, and activeSource()
  // reads a dataset attribute off <body>. Neither can fail, and the catches
  // need what they produce — dom.stateMsg to write into, and the page name to
  // write about.
  cacheDom();
  const page = activeSource();

  /* Wiring.

     Every line here is synchronous DOM work against the 26 ids dom.js just
     looked up, and the failure mode is a null dereference: rename an id in the
     markup without renaming it in dom.js — or add a page that hasn't got one of
     them — and `dom.something.addEventListener` throws.

     It needs a catch of its own because init() is async and nothing awaits it,
     so before this existed such a throw became an unhandled rejection: no error
     state, no console entry anyone was watching, and a page left sitting on
     "Loading the collection…" for good. It gets a different message from the
     load below because it is a different failure — the sheet is not implicated
     and "try again later" would be false comfort. */
  try {
    hydrateThemeConstants();
    // The URL wins — an explicit link beats anything the browser remembers. But
    // a URL with no ?sort is silent rather than opinionated, so a select the
    // browser restored across a reload stands in as the fallback.
    readStateFromUrl({ sortFallback: dom.sort.value });
    dom.sort.value = state.sort;
    syncViewControls();
    dom.search.value = state.search;
    wireEvents();
    registerServiceWorker();
    listenForStaleSheet();
  } catch (err) {
    console.error(`Failed to start up ${page}:`, err);
    reportFatal('This page did not start up correctly. Reloading may help.');
    return;
  }

  const wantsShelfCheck = page === 'wishlist';

  try {
    // Both sheets at once on the wishlist page: its own rows, and the shelf to
    // check them against. In parallel because neither needs the other to parse,
    // and the shelf is allowed to fail on its own — a wishlist with no
    // ownership stamps on it is a slightly less useful wishlist, while a
    // wishlist page that refused to render because the *collection* tab was
    // unreachable would be no wishlist at all. Hence the catch that swallows
    // rather than a second entry in Promise.all.
    const [rows, shelf] = await Promise.all([
      load(page),
      wantsShelfCheck
        ? load('collection').catch((err) => {
          console.warn('Wishlist loaded, but the shelf did not — no ownership marks:', err);
          return [];
        })
        : Promise.resolve([]),
    ]);
    DISCS.push(...rows);

    // Fold the worker's answer in now that load() has made its own. It has to
    // be now: the worker knows something load() can't, but it says so first and
    // load() assigns SHEET on the way out, so an earlier write is simply lost.
    // Only that one value is overridden — a fall back to the committed snapshot
    // is the older copy of the two, and the one worth naming.
    if (staleReportForPage() && loadedFrom() === DATA_SOURCES.SHEET) {
      noteDataSource(DATA_SOURCES.CACHE);
    }

    // What the shelf makes of each wanted record, written onto the discs before
    // anything renders — the cards read it, the rows read it, the dialog reads
    // it, and none of them should have to wait for it. Nothing to say when the
    // shelf didn't load; the stamps are simply absent, which is what shelfTag()
    // and friends already return '' for.
    if (shelf.length) markOwnership(DISCS, shelf);

    // Unconditional, and ahead of the empty-list return below, because the shop
    // check is not a page decoration that can be skipped. #shop-form has no
    // action, so a form left unwired is not inert — the browser submits it, and
    // that is a full navigation to `wishlist.html?` which throws away whatever
    // filters were in the URL and answers nothing. The two cases where that
    // could happen are precisely the two where the box matters most: the shelf
    // unreachable (a shop with no signal) and an empty wishlist. Both still have
    // a real answer to give. wireShopCheck no-ops where the markup isn't, so the
    // other pages pass straight through.
    wireShopCheck({ shelf, wants: DISCS });

    if (DISCS.length === 0) {
      const empty = `The ${page === 'wishlist' ? 'wishlist' : 'collection'} is empty right now.`;
      dom.stateMsg.textContent = empty;
      announce(empty);
      return;
    }

    renderStats(DISCS);
    renderPills(DISCS);
    // The pills only exist now, so this is the first point at which genre/tag
    // filters from the URL can be shown as pressed.
    syncControlsToState();
    dom.stateMsg.hidden = true;
    const notice = refreshDataNotice();
    applyFilters({ announceResults: false });
    // One announcement, not two. #stale-notice is deliberately not a live region
    // — this page has exactly one, #live-region, and a second would double-speak
    // — so the notice rides along with the count instead of being said on its
    // own. It also can't be a second announce() call: the live region holds a
    // single string, and the second would overwrite the count before a screen
    // reader had finished reading it.
    // Three things can want this one live region at load, so they are joined
    // into the single string it holds rather than overwriting each other: how
    // many rows arrived, which copy they came from, and — on the wishlist — how
    // many of them turn out to be on the shelf already, which is the answer to
    // "did I buy this and forget" and the reason to look at the page at all.
    const stale = shelf.length ? staleWishlistNote(DISCS) : '';
    // On screen as well as spoken. It sits with the shop check rather than in
    // #stale-notice next to the count, because those two lines are about
    // different kinds of stale — one is "this copy of the sheet is old", this
    // one is "these rows are".
    const staleBox = $('wishlist-stale');
    if (staleBox) {
      staleBox.hidden = !stale;
      if (stale) staleBox.textContent = stale;
    }
    announce([
      `Loaded ${DISCS.length} ${noun(DISCS.length)}.`,
      notice,
      stale,
    ].filter(Boolean).join(' '));

    // The placeholder covers are drawn in Anton and Space Mono, and the CSV can
    // beat fonts.gstatic.com to the finish — every cover drawn in that window is
    // laid out, wrapped and memoized in Arial Narrow and Courier. Repaint them
    // once the faces have settled for good. Covers already drawn in the real
    // type are skipped, so on a warm cache this costs nothing. The guard is for
    // browsers with no FontFaceSet: there is no promise to wait on there, and
    // cover.js counts that as ready and draws in the fallback faces on purpose,
    // so there is nothing to come back and fix. On a slow font load the swap
    // shows as a one-frame change of type on covers already on screen; that
    // beats a whole session of them memoized in the wrong one.
    //
    // Two passes, because they can reach different nodes: cover.js repoints
    // what is in the document, and hands back the stale → fresh map so render.js
    // can do the same for the cards it is holding off-screen in its reuse map.
    if (document.fonts) {
      document.fonts.ready.then(() => repointCardImages(repaintPlaceholders(DISCS)));
    }

    // Coming back online. The offline bails in art.js and detail.js re-read
    // navigator.onLine on every call and leave no state behind, so there's no
    // latch here to release: the next dialog that opens goes to the network on
    // its own, and so does the next card that dwells — a card whose lookup
    // bailed stays under the art observer for exactly that reason (art.js's
    // artLookupSettled, and the unobserve it gates in render.js).
    //
    // "Dwells" is doing real work in that sentence: a card has to leave the
    // observer's margin and come back before it asks again, so sitting perfectly
    // still through a reconnect leaves the covers already on screen as
    // placeholders until something scrolls. Left that way on purpose — the
    // alternative is re-querying every visible card on an event that fires on
    // each flaky-Wi-Fi blip, and 'online' is the least trustworthy signal on the
    // page. The notice is the one thing
    // that can't reconsider by itself — it was written while the sheet was
    // unreachable, and there is now a way out of it worth offering.
    window.addEventListener('online', refreshDataNotice);

    // A deep link straight to a disc: open it once the collection exists.
    // No push — this history entry is what brought us here.
    const linked = discBySlug(discSlugFromHash());
    if (linked) openDetail(linked, { pushUrl: false });
  } catch (err) {
    console.error(`Failed to load ${page}:`, err);
    const message = `Could not load the ${page === 'wishlist' ? 'wishlist' : 'collection'}. Please try again later.`;
    // Guarded, because this catch is also what runs when the throw above *was*
    // a missing #state-msg. Writing the report into the element whose absence
    // caused the report is how a handled error becomes an unhandled one.
    if (dom.stateMsg) {
      dom.stateMsg.hidden = false;
      dom.stateMsg.classList.add('is-error');
      dom.stateMsg.textContent = message;
      announce(message);
    } else {
      reportFatal(message);
    }
  }
}

document.addEventListener('DOMContentLoaded', init);
