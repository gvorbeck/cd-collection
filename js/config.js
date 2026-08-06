/* ============================================================
   config.js — presentation settings
   ------------------------------------------------------------
   Everything the grid page decides about how the collection
   LOOKS. The sheet URL, the column names, and the blank-cell
   fallbacks are NOT here — they're in collection.js, shared with
   the stats and labels pages.
   ============================================================ */
import { APP_IDENTITY, WS_BASE } from './musicbrainz.js';


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
    // MusicBrainz asks every client to identify itself with a descriptive
    // User-Agent (app name/version + contact). Sent via a query param since
    // browsers can't set User-Agent on fetch; MB reads either.
    APP_IDENTITY: APP_IDENTITY,
    // Release-group text search endpoint.
    SEARCH_URL: `${WS_BASE}/release-group`,
    // Release browse endpoint — used to pull a tracklist for a release group.
    RELEASE_URL: `${WS_BASE}/release`,
    // Cover Art Archive front-image endpoint (CORS-enabled + canvas-readable).
    // {mbid} is a release-group id; size is one of 250 / 500 / 1200.
    CAA_URL: 'https://coverartarchive.org/release-group',
    CAA_SIZE: 500,
    // localStorage key + schema version. Bump the version to invalidate the
    // whole cache if the lookup logic changes.
    CACHE_KEY: 'cdc:art-cache:v1',
    // Cached tracklists, keyed by release-group MBID. Capped because these are
    // much bigger than a cover URL and localStorage is a shared ~5MB budget —
    // past the cap the least-recently-fetched entries are dropped.
    TRACKS_CACHE_KEY: 'cdc:tracks:v1',
    TRACKS_CACHE_MAX: 250,
  },
};
