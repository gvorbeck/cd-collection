/* ============================================================
   controls.js — pushing state back out to the widgets
   ------------------------------------------------------------
   One direction only: read `state`, set the controls to match.
   Nothing here changes `state` or re-renders the grid — the
   callers do that themselves, in the order they need.

   Used after anything that moves the filters without the user
   having touched a control: a deep link at startup, a Back or
   Forward, the pills being built for the first time once the
   sheet has loaded, or a genre pill toggled from inside the disc
   dialog.

   It's a file of its own rather than living in url.js because
   these two functions have nothing to do with the address bar —
   they were only there because that's where the first caller was,
   and having url.js reach into render.js for the tag cloud is
   what made the address bar part of a four-module import cycle.
   ============================================================ */
import { dom } from './dom.js';
import { state } from './store.js';
import { layoutTagCloud } from './render.js';


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

// Reflect the current view on the toggle buttons.
export function syncViewControls() {
  dom.viewToggle.querySelectorAll('[data-view]').forEach((btn) => {
    btn.setAttribute('aria-pressed', String(btn.dataset.view === state.view));
  });
}
