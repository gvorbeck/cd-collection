/* ============================================================
   sw.js — service worker
   ------------------------------------------------------------
   The collection is most useful in a record shop, which is
   reliably where the signal isn't. This makes the site work with
   no network at all: the shell is precached, the sheet's last
   response is kept, and cover art is kept once fetched.

   Caching strategy, by kind of request:

     navigations      network-first, fall back to the cached page
     shell (css/js)   stale-while-revalidate — instant, self-updating
     sheet CSV        network-first, fall back to the last good copy
     cover art        cache-first, in a separate capped cache
     MusicBrainz API  never cached here (app.js caches in localStorage)

   Bump CACHE_VERSION whenever the shell changes. Old caches are
   deleted on activate, so a bump is also the way to force a
   refresh of anything stuck.

   Known trade-off: the HTML is network-first but its scripts are
   stale-while-revalidate, so the first load after a deploy can
   pair fresh markup with the previous app.js before the refetch
   lands. Nothing here is content-hashed (no build step to do it),
   so bumping CACHE_VERSION is the fix when a release changes the
   contract between the two.
   ============================================================ */

const CACHE_VERSION = 'v3';
const SHELL_CACHE = `cdc-shell-${CACHE_VERSION}`;
const DATA_CACHE  = `cdc-data-${CACHE_VERSION}`;
const ART_CACHE   = `cdc-art-${CACHE_VERSION}`;

// Cover art is unbounded in principle — one image per disc, forever. Trim it
// back to this many entries whenever it grows past it.
const ART_CACHE_MAX = 400;

// Everything needed to render the site with no network. Relative URLs so this
// keeps working if the site ever moves off the domain root.
const SHELL_ASSETS = [
  './',
  'index.html',
  'labels.html',
  'stats.html',
  'styles.css',
  'labels.css',
  'collection.js',
  'musicbrainz.js',
  'app.js',
  'stats.js',
  'labels.js',
  'sample.csv',
  'manifest.webmanifest',
  'icons/icon.svg',
  'icons/icon-180.png',
  'icons/icon-192.png',
  'icons/icon-512.png',
  // Third-party, but the site does not render without them.
  'https://cdn.jsdelivr.net/npm/papaparse@5.4.1/papaparse.min.js',
];

/* ---------- Install: precache the shell ---------- */

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    // addAll() is all-or-nothing: one 404 and the whole install fails, taking
    // offline support with it. Add them individually and tolerate misses.
    await Promise.all(SHELL_ASSETS.map(async (url) => {
      try {
        await cache.add(new Request(url, { cache: 'reload' }));
      } catch (err) {
        console.warn('[sw] could not precache', url, err);
      }
    }));
    // Don't make the user close every tab to pick up a new version.
    await self.skipWaiting();
  })());
});

/* ---------- Activate: drop caches from older versions ---------- */

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keep = new Set([SHELL_CACHE, DATA_CACHE, ART_CACHE]);
    const names = await caches.keys();
    await Promise.all(
      names.filter((n) => n.startsWith('cdc-') && !keep.has(n))
           .map((n) => caches.delete(n))
    );
    await self.clients.claim();
  })());
});

/* ---------- Fetch: route by request kind ---------- */

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // MusicBrainz lookups are throttled and already cached in localStorage by
  // the page. Caching them here would only duplicate that, and would risk
  // serving stale MBIDs. Let them go straight to the network.
  if (url.hostname === 'musicbrainz.org') return;

  // A page navigation. Try the network so edits show up, but never let a dead
  // connection produce the browser's offline page.
  if (request.mode === 'navigate') {
    event.respondWith(navigationFirst(request));
    return;
  }

  // The published Google Sheet: the actual collection data. Fresh if possible,
  // last-known-good if not.
  if (url.hostname === 'docs.google.com') {
    event.respondWith(networkFirst(request, DATA_CACHE));
    return;
  }

  // Cover art. Immutable once fetched — the archive serves a given image ID
  // forever — so cache-first, and skip the network entirely on a hit.
  if (url.hostname.endsWith('coverartarchive.org') || url.hostname.endsWith('archive.org')) {
    event.respondWith(cacheFirst(event, ART_CACHE, { trimTo: ART_CACHE_MAX }));
    return;
  }

  // Fonts: the CSS changes rarely, the font files never.
  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    event.respondWith(staleWhileRevalidate(event, SHELL_CACHE));
    return;
  }

  // Our own assets, plus the pinned PapaParse build.
  if (url.origin === self.location.origin || url.hostname === 'cdn.jsdelivr.net') {
    event.respondWith(staleWhileRevalidate(event, SHELL_CACHE));
  }
});

/* ---------- Strategies ---------- */

async function networkFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    const response = await fetch(request);
    if (response && response.ok) cache.put(request, response.clone());
    return response;
  } catch (err) {
    const cached = await cache.match(request);
    if (cached) return cached;
    throw err;
  }
}

/**
 * Network-first for page loads, keyed on the path alone.
 *
 * The querystring on this site is filter state (?q=…&genre=…) and the hash
 * names a disc — the page re-reads both at runtime, so every variant returns
 * byte-identical HTML. Caching them per-URL would mint a new entry for every
 * search anyone ever shares, so the path is the key and one entry covers all
 * of them. An unknown page offline still falls back to the grid.
 */
async function navigationFirst(request) {
  const cache = await caches.open(SHELL_CACHE);
  const key = new URL(request.url).pathname;
  try {
    const response = await fetch(request);
    if (response && response.ok) cache.put(key, response.clone());
    return response;
  } catch (err) {
    const cached = await cache.match(key) || await cache.match('index.html');
    if (cached) return cached;
    throw err;
  }
}

// Takes the FetchEvent for the same reason staleWhileRevalidate does: the trim
// runs after the response is handed back, and without waitUntil() the worker is
// free to be killed mid-delete — which is how a capped cache quietly stops
// being capped.
async function cacheFirst(event, cacheName, { trimTo } = {}) {
  const { request } = event;
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) return cached;

  const response = await fetch(request);
  // Opaque responses (no-cors, status 0) are still worth storing — they render
  // fine in an <img>, we just can't inspect them.
  if (response && (response.ok || response.type === 'opaque')) {
    await cache.put(request, response.clone());
    if (trimTo) event.waitUntil(trimCache(cacheName, trimTo));
  }
  return response;
}

// Takes the FetchEvent rather than just the Request, because the background
// refetch needs waitUntil() to keep the worker alive past the response.
async function staleWhileRevalidate(event, cacheName) {
  const { request } = event;
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);

  // Opaque here too: the Google Fonts stylesheet is CORS-friendly, but the
  // font files it pulls are not, and an `ok`-only guard silently refuses to
  // store them — which is exactly the request you want served offline.
  const network = fetch(request).then((response) => {
    if (response && (response.ok || response.type === 'opaque')) {
      cache.put(request, response.clone());
    }
    return response;
  }).catch(() => null);

  // Cached copy wins the race when there is one; the refetch keeps running in
  // the background so the next load is current.
  if (cached) {
    event.waitUntil(network);
    return cached;
  }
  const response = await network;
  if (response) return response;
  throw new Error(`offline and uncached: ${request.url}`);
}

/**
 * Keep a cache from growing without bound. Cache Storage preserves insertion
 * order, so the oldest entries are simply the first keys.
 */
async function trimCache(cacheName, maxEntries) {
  const cache = await caches.open(cacheName);
  const keys = await cache.keys();
  const excess = keys.length - maxEntries;
  for (let i = 0; i < excess; i++) await cache.delete(keys[i]);
}
