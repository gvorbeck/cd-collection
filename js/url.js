/* ============================================================
   url.js — shareable filters + per-disc deep links
   ------------------------------------------------------------
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
     which is otherwise the roughest edge on the whole site. That
     push is made by detail.js, which owns the dialog's lifecycle.
   ============================================================ */
import { usingSample } from './collection.js';
import { dom } from './dom.js';
import { layoutTagCloud } from './render.js';
import { openDetail, closeDetailForHistory } from './detail.js';
import { DISCS, DEFAULT_SORT, DEFAULT_VIEW, VIEWS, state, applyFilters, syncViewControls } from './state.js';


// The hash prefix for a disc deep link: "#disc-<slug>".
export const DISC_HASH_PREFIX = '#disc-';

// The disc slug named by the current URL hash, or '' if there isn't one.
export function discSlugFromHash() {
  const hash = location.hash;
  return hash.startsWith(DISC_HASH_PREFIX) ? hash.slice(DISC_HASH_PREFIX.length) : '';
}

// Look up a disc by its URL slug.
export function discBySlug(slug) {
  return slug ? DISCS.find((d) => d.slug === slug) || null : null;
}

/**
 * Build the URL for the current filter state.
 * Values equal to their default are omitted, so an unfiltered page is a bare
 * path. `hash` defaults to whatever the address bar already has, so updating a
 * filter while the dialog is open doesn't drop the disc it's showing.
 */
export function buildUrl(hash = location.hash) {
  const parts = [];
  // Preserve ?sample as a bare flag — it's a dev switch and reads better
  // spelled the way the README documents it.
  if (usingSample()) parts.push('sample');
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
export function syncUrl() {
  history.replaceState(history.state, '', buildUrl());
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
export function readStateFromUrl({ sortFallback = DEFAULT_SORT } = {}) {
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
export function syncControlsToState() {
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
export function onPopState() {
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
    // place if it's already open). No push — this entry already exists.
    openDetail(disc, { pushUrl: false });
  } else if (dom.detail.open) {
    closeDetailForHistory();
  }
}
