/* ============================================================
   dom.js — the page's element cache
   ------------------------------------------------------------
   One object of live element references, filled once at startup by
   cacheDom(). It is its own module because almost everything reads
   it and nothing else about it is interesting — keeping it here
   means rendering, the detail dialog, filtering and the URL layer
   can each import the elements without importing each other.

   The object is mutated in place rather than reassigned, so an
   importer's binding is always the filled one.
   ============================================================ */
import { $ } from './util.js';


// Cached DOM references.
export const dom = {};

export function cacheDom() {
  dom.grid            = $('grid');
  dom.stateMsg        = $('state-msg');
  dom.statTotal       = $('stat-total');
  dom.statGenres      = $('stat-genres');
  dom.genrePills      = $('genre-pills');
  dom.tagPills        = $('tag-pills');
  dom.search          = $('search');
  dom.shuffle         = $('shuffle');
  dom.resultsCount    = $('results-count');
  dom.clearFilters    = $('clear-filters');
  dom.sort            = $('sort');
  dom.viewToggle      = $('view-toggle');
  dom.exportBtn       = $('export-csv');
  dom.liveRegion      = $('live-region');
  dom.detail          = $('detail');
  dom.detailClose     = $('detail-close');
  dom.detailCover     = $('detail-cover');
  dom.detailNumber    = $('detail-number');
  dom.detailTitle     = $('detail-title');
  dom.detailArtist    = $('detail-artist');
  dom.detailMeta      = $('detail-meta');
  dom.detailTags      = $('detail-tags');
  dom.detailNotes     = $('detail-notes');
  dom.detailLinks     = $('detail-links');
  dom.detailTracks    = $('detail-tracks');
  dom.detailMakeLabel = $('detail-make-label');
  dom.body            = document.body;
}
