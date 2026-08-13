/* ============================================================
   CD COLLECTION — app.js
   ------------------------------------------------------------
   The grid page's entry point: wire the controls up, hydrate the
   theme constants out of the stylesheet, load the sheet, render.
   Nothing else imports this file; it is the end of every chain.

   The modules it pulls together, roughly in dependency order:

     collection.js  the sheet: fetch, parse, disc objects (shared)
     musicbrainz.js the MB web service + its 1/sec throttle (shared)
     config.js      presentation settings
     util.js        small helpers + the localStorage wrapper
     color.js       hashing, brightness, cover sampling
     cover.js       generated placeholder covers
     art.js         cover-art and tracklist lookup, cached
     dom.js         the element cache
     render.js      stats card, pills, the grid itself
     detail.js      the disc dialog and its history entry
     state.js       the discs, the filters, sort/view/export
     url.js         filter state and deep links in the address bar
   ============================================================ */
import { CONFIG } from './config.js';
import {
  load, loadedFrom, noteDataSource, DATA_SOURCES, registerServiceWorker,
} from './collection.js';
import { $, isHex6, cssVar } from './util.js';
import { hexToRgb, setPaperRgb } from './color.js';
import { repaintPlaceholders } from './cover.js';
import { dom, cacheDom } from './dom.js';
import { announce, renderStats, renderPills, layoutTagCloud, enableDragScroll, repointCardImages } from './render.js';
import { openDetail, dismissDetail, onDetailClosed, makeLabelForCurrentDisc } from './detail.js';
import {
  DISCS, state, applyFilters, togglePill, clearAllFilters,
  setView, syncViewControls, exportCurrentCsv, shuffle,
} from './state.js';
import {
  discSlugFromHash, discBySlug, syncUrl, readStateFromUrl,
  syncControlsToState, onPopState,
} from './url.js';


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
   ---------------------------------------------------------- */

// What the service worker said about the sheet request, or null if it said
// nothing. Held rather than acted on: the message lands while load() is still
// fetching, and load() records its own source when the parse resolves, so
// anything applied before then is overwritten a moment later.
let staleSheetReport = null;

/**
 * Start listening for the worker's word that it answered the sheet request out
 * of its own cache.
 *
 * A cached CSV is byte-identical to a live one from this side: the fetch
 * succeeds, the parse succeeds, and nothing about the discs says they were
 * downloaded three weeks ago. Only the worker knows, and it says so with a
 * { type: 'sheet-stale' } message (see sw.js). Called before load(), because
 * the message arrives during load()'s own fetch rather than after it.
 */
function listenForStaleSheet() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.addEventListener('message', (event) => {
    const data = event.data;
    if (!data || data.type !== 'sheet-stale') return;
    // cachedAt is an ISO string stamped when the copy was stored, or null from
    // a worker old enough to predate the stamp. Both are usable answers.
    staleSheetReport = { cachedAt: typeof data.cachedAt === 'string' ? data.cachedAt : null };
  });

  // A ServiceWorkerContainer's message queue starts disabled and is only
  // enabled by onmessage, startMessages(), or the window's load event. We used
  // addEventListener and we run from DOMContentLoaded, which is earlier than
  // load — so without this the worker's message can still be sitting in the
  // queue when init() reads staleSheetReport, and the notice reports the wrong
  // source. No-op if the queue is already going.
  navigator.serviceWorker.startMessages();
}

/**
 * The line to show when the discs on screen didn't come from the live sheet.
 *
 * Two of the four DATA_SOURCES need no line at all: `sheet` is the ordinary
 * answer, and `sample` is a dev switch someone asked for on purpose. The other
 * two both mean "the sheet didn't answer", but they are different copies and
 * are worded as different copies — one is this browser's own last-known-good,
 * the other is the snapshot committed with the site.
 *
 * Neither line says the *sheet* is out of date, and neither may: Google's
 * published CSV can trail the spreadsheet behind it all on its own, and nothing
 * on this side can see that. All we honestly know is which copy we read.
 */
function dataSourceNotice() {
  const source = loadedFrom();
  if (source !== DATA_SOURCES.CACHE && source !== DATA_SOURCES.SNAPSHOT) return '';
  const copy = source === DATA_SOURCES.CACHE
    ? `the copy saved on this device${savedOn()}`
    : 'the copy published with the site';
  // Only offer the retry when there's a connection to make it over. Offline
  // it's advice to reload straight back into the same fallback, which is how a
  // status line stops being worth reading.
  const retry = navigator.onLine === false ? '' : ' Reload to try again.';
  return `Could not reach the sheet — showing ${copy}.${retry}`;
}

// " (12 Aug 2026)" for a stamped cache entry, "" for one written before sw.js
// started stamping them. The notice stands either way; the date is what makes
// it possible to judge whether last week's shelf additions are in there.
function savedOn() {
  const at = staleSheetReport && staleSheetReport.cachedAt
    ? new Date(staleSheetReport.cachedAt)
    : null;
  if (!at || Number.isNaN(at.getTime())) return '';
  return ` (${at.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })})`;
}

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
  const notice = dataSourceNotice();
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
  registerServiceWorker();
  listenForStaleSheet();

  try {
    DISCS.push(...await load());

    // Fold the worker's answer in now that load() has made its own. It has to
    // be now: the worker knows something load() can't, but it says so first and
    // load() assigns SHEET on the way out, so an earlier write is simply lost.
    // Only that one value is overridden — a fall back to the committed snapshot
    // is the older copy of the two, and the one worth naming.
    if (staleSheetReport && loadedFrom() === DATA_SOURCES.SHEET) {
      noteDataSource(DATA_SOURCES.CACHE);
    }

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
    const notice = refreshDataNotice();
    applyFilters({ announceResults: false });
    // One announcement, not two. #stale-notice is deliberately not a live region
    // — this page has exactly one, #live-region, and a second would double-speak
    // — so the notice rides along with the count instead of being said on its
    // own. It also can't be a second announce() call: the live region holds a
    // single string, and the second would overwrite the count before a screen
    // reader had finished reading it.
    announce(`Loaded ${DISCS.length} discs.${notice ? ` ${notice}` : ''}`);

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
    console.error('Failed to load collection:', err);
    dom.stateMsg.hidden = false;
    dom.stateMsg.classList.add('is-error');
    dom.stateMsg.textContent = 'Could not load the collection. Please try again later.';
    announce('Could not load the collection. Please try again later.');
  }
}

document.addEventListener('DOMContentLoaded', init);
