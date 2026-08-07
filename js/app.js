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
import { load, registerServiceWorker } from './collection.js';
import { $, isHex6, cssVar } from './util.js';
import { hexToRgb, setPaperRgb } from './color.js';
import { dom, cacheDom } from './dom.js';
import { announce, renderStats, renderPills, layoutTagCloud, enableDragScroll } from './render.js';
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

  try {
    DISCS.push(...await load());

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
