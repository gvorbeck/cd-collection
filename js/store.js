/* ============================================================
   store.js — the collection, and what's selected of it
   ------------------------------------------------------------
   Two mutable things and three constants. No behaviour at all:
   everything that acts on these lives a layer up, in state.js,
   render.js, detail.js and url.js.

   They are here rather than in state.js because all four of those
   modules need to *read* them, and three of them also need to call
   into each other. When the data and the actions shared one file,
   that made a cycle — state.js imported render.js and url.js, and
   both imported it straight back for `state`. Circular ES modules
   do resolve, but only if every cross-reference happens at call
   time; one `const foo = state.sort` at the top level of the wrong
   module and the page dies at load with a temporal-dead-zone
   error that names a line with nothing wrong on it.

   Splitting the nouns out from the verbs makes the whole graph
   acyclic, which is checked by test/imports.test.mjs. Keep this
   file free of behaviour and it stays that way.
   ============================================================ */
import { defaultSort } from './collection.js';


// The full collection once loaded. Filled in place by init() rather than
// reassigned: every importer holds this same array.
export const DISCS = [];

// Defaults. A value equal to its default is left OUT of the URL, so a plain
// visit stays at a clean `/` rather than carrying a string of no-op params.
//
// Which is exactly why the sort default can't be a literal: it has to be the
// `selected` <option> of the page actually loaded. The shelf opens on Random
// and the wishlist on Artist, so a hardcoded 'random' made picking Random on
// the wishlist write a link with no ?sort in it — and reading that link back
// gave Artist. A page's source is fixed by its markup, so this is read once,
// here, at module scope.
export const DEFAULT_SORT = defaultSort();
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
