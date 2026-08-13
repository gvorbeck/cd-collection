/* ============================================================
   config.js — presentation settings
   ------------------------------------------------------------
   Everything the grid page decides about how the collection
   LOOKS. The sheet URL, the column names, and the blank-cell
   fallbacks are NOT here — they're in collection.js, shared with
   the stats and labels pages.

   Nothing here imports anything, on purpose. This file used to
   pull the MusicBrainz web-service base and app identity out of
   musicbrainz.js to build endpoint URLs, which quietly dragged
   the whole web-service module into the import graph of color.js
   and render.js — modules that only ever wanted a palette. These
   are values; they should cost nothing to read.
   ============================================================ */

export const CONFIG = {
  // Palette used to color generated placeholder covers.
  // Any disc without art gets a color hashed from its artist name,
  // so one artist's untitled discs read as a set.
  // The first five mirror the accent vars in styles.css (--brick, --mustard,
  // --teal, --orange, --forest); keep them in sync if you retune the theme.
  // The last three (plum, ink blue, raspberry) are placeholder-only extras.
  PLACEHOLDER_PALETTE: [
    '#c8452f', // brick red     (--brick)
    '#e0a51f', // mustard       (--mustard)
    '#2f8f8a', // teal          (--teal)
    '#d9711f', // burnt orange  (--orange)
    '#3e6b3a', // forest green  (--forest)
    '#7a4ea3', // plum          (placeholder-only)
    '#3866a8', // ink blue      (placeholder-only)
    '#b23a6d', // raspberry     (placeholder-only)
  ],

  // Neutral tint used for card shadows when we can't sample a cover color.
  // Mirrors --shadow-neutral in styles.css and is overwritten from that CSS
  // var at startup (hydrateThemeConstants), so the stylesheet stays canonical;
  // this literal is just the pre-hydration fallback.
  NEUTRAL_SHADOW: '#3a3128',

  // How many genres the stats card shows before collapsing the rest behind a
  // "show more" toggle. The top N (by count) stay visible.
  STATS_GENRES_VISIBLE: 3,

  // Automatic cover-art lookup via MusicBrainz + the Cover Art Archive.
  // Only used for discs with a BLANK Art URL — an explicit Art URL in the sheet
  // always wins. Lookups fire lazily (only when a card scrolls on-screen) and
  // are cached in localStorage, so we stay well under MusicBrainz's ~1 req/sec
  // limit and never look a disc up more than once per browser.
  MUSICBRAINZ: {
    // Only the Cover Art Archive is named here: it's a different host with its
    // own URL shape, built by hand from a release-group id. The ws/2 endpoints
    // and the app identity MusicBrainz wants sent with them live in
    // musicbrainz.js, which is the only module that should be calling them.
    //
    // Cover Art Archive front-image endpoint (CORS-enabled + canvas-readable).
    // {mbid} is a release-group id; size is one of 250 / 500 / 1200.
    CAA_URL: 'https://coverartarchive.org/release-group',
    // The same archive addressed by release instead of by release group, for a
    // disc the sheet pinned with a Barcode. A group's front image is whichever
    // pressing's cover the archive nominates to stand for the record as a
    // whole; this one is the cover of the pressing actually on the shelf, which
    // is the point of having pinned it.
    CAA_RELEASE_URL: 'https://coverartarchive.org/release',
    CAA_SIZE: 500,
    // localStorage key + schema version. Bump the version to invalidate the
    // whole cache if the lookup logic changes.
    // v2: the release-group search now weighs the disc's year, so entries from
    // v1 can point at the wrong record entirely — the same-named EP rather than
    // the album. The tracklist reads its release group back out of these URLs,
    // so a stale one here is a stale tracklist too; both caches start over.
    // v3: a lookup that merely *failed* used to be written here as a permanent
    // miss, so any browsing done offline left discs that would never be looked
    // up again — those entries have to go. And the release tiebreakers no
    // longer overturn an exact year match, which changes which pressing inside
    // a group a tracklist is taken from; both caches start over again.
    // Deliberately *not* bumped to v4 for the Barcode column: artCacheKey grows
    // a third field only for the discs that have a barcode, so every entry
    // already in a visitor's browser still matches the disc it was written for.
    // A bump would have thrown all of them away to re-resolve the handful of
    // discs the new column actually changes the answer for.
    CACHE_KEY: 'cdc:art-cache:v3',
    // Cached tracklists, keyed by release-group MBID + the disc's year (which
    // pressing within the group we pick depends on it). Capped because these
    // are much bigger than a cover URL and localStorage is a shared ~5MB
    // budget — past the cap the least-recently-fetched entries are dropped.
    TRACKS_CACHE_KEY: 'cdc:tracks:v3',
    TRACKS_CACHE_MAX: 250,
  },
};
