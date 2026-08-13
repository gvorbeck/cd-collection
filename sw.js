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

   Two things the pages depend on beyond plain caching:

   The shell precaches data/collection.csv, a committed snapshot of
   the sheet written by scripts/snapshot.js. Before it existed the
   only real data offline was whatever an earlier online visit had
   left in DATA_CACHE, so the very first launch of a fresh install
   with no signal showed "Could not load the collection" — in the
   record shop this whole file opens by claiming to cover.

   And when the sheet does fall back to the cached copy, the page
   is told: every controlled client gets a { type: 'sheet-stale' }
   message carrying the time the entry was written. A cached CSV is
   indistinguishable from a live one on the page side, so without
   the message the site shows last month's collection with all the
   confidence of today's.

   Bump CACHE_VERSION whenever the shell changes. Old caches are
   deleted on activate, so a bump is also the way to force a
   refresh of anything stuck.

   Known trade-off: the HTML is network-first but its scripts are
   stale-while-revalidate, so the first load after a deploy can
   pair fresh markup with the previous modules before the refetch
   lands. Nothing here is content-hashed (no build step to do it),
   so bumping CACHE_VERSION is the fix when a release changes the
   contract between the two.
   ============================================================ */

const CACHE_VERSION = 'v8';
const SHELL_CACHE = `cdc-shell-${CACHE_VERSION}`;
const DATA_CACHE  = `cdc-data-${CACHE_VERSION}`;
const ART_CACHE   = `cdc-art-${CACHE_VERSION}`;

// Our own header, stamped onto a sheet response on its way into DATA_CACHE.
// It has to be ours: the sheet is cross-origin, so the response the worker
// gets has its headers filtered down to the CORS-safelist, and Date is not on
// that list — cached.headers.get('date') is null, every time, no matter how
// reasonable it looks. Don't try it again.
const CACHED_AT_HEADER = 'x-cdc-cached-at';

// Cover art is unbounded in principle — one image per disc, forever. Trim it
// back to this many entries whenever it grows past it.
const ART_CACHE_MAX = 400;

// Everything needed to render the site with no network. Relative URLs so this
// keeps working if the site ever moves off the domain root.
//
// Kept by hand, because there is no build step to generate it. Run
// `node scripts/check-shell-assets.js` after editing this list — it walks the
// imports out of each page and tells you what you left off. CI runs it before
// anything deploys, which is the only reason drift here is survivable.
const SHELL_ASSETS = [
  './',
  'index.html',
  'labels.html',
  'stats.html',
  'styles.css',
  'labels.css',
  // Every module, listed one by one. A page names only its entry point, but
  // the browser resolves imports at fetch time, so an unlisted module is a
  // network request the offline shell can't answer.
  'js/collection.js',
  'js/musicbrainz.js',
  'js/config.js',
  'js/util.js',
  'js/color.js',
  'js/art.js',
  'js/cover.js',
  'js/dom.js',
  'js/render.js',
  'js/detail.js',
  'js/state.js',
  'js/url.js',
  'js/app.js',
  'js/stats.js',
  'js/labels.js',
  'js/labelDraft.js',
  'sample.csv',
  // The real collection, frozen into the tree by scripts/snapshot.js. This is
  // the one asset that may legitimately not be there — it is generated, so a
  // checkout where the script has never been run simply doesn't have it. The
  // per-asset catch in install() is what keeps that from failing the whole
  // precache and taking every other offline asset down with it.
  'data/collection.csv',
  'manifest.webmanifest',
  // Every icon manifest.webmanifest declares, plus the Apple touch icon the
  // pages link directly. The two lists drifted once — icon-maskable-512.png
  // was declared in the manifest and precached nowhere — so CI now checks that
  // everything the manifest names appears here.
  'icons/icon.svg',
  'icons/icon-180.png',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png',
  // Third-party, but the site does not render without them.
  'https://cdn.jsdelivr.net/npm/papaparse@5.4.1/papaparse.min.js',
];

/* ---------- Install: precache the shell ---------- */

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    // addAll() is all-or-nothing: one 404 and the whole install fails, taking
    // offline support with it. Add them individually and tolerate misses —
    // load-bearing now that data/collection.csv is on the list, since that one
    // is generated and a fresh clone hasn't got it until snapshot.js runs.
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
    if (response && response.ok && isCsv(response)) {
      // Stamped and stored, not stored as-is: the fallback below has no other
      // way to tell the page how old the copy it's serving is. Awaiting the
      // body here is free — the caller parses the whole CSV anyway — and it
      // guarantees the write finishes before respondWith() settles and the
      // worker becomes killable.
      await cache.put(request, await stampCachedAt(response.clone()));
    }
    return response;
  } catch (err) {
    const cached = await cache.match(request);
    if (cached) {
      // Hand back the frozen sheet, but say so. A cached response is
      // byte-identical to a live one from the page's side, so this message is
      // the only thing standing between an offline visitor and the belief that
      // they are looking at the current collection.
      await notifyClients({ type: 'sheet-stale', cachedAt: cached.headers.get(CACHED_AT_HEADER) });
      return cached;
    }
    throw err;
  }
}

/**
 * Is this response actually the sheet?
 *
 * A 200 is not proof of one: an unpublished sheet, or a URL that has picked up
 * a login redirect, comes back as a perfectly successful page of HTML. Caching
 * that would evict the last good CSV and leave the shop-floor fallback serving
 * a login wall — the same clobbering scripts/snapshot.js refuses to do to
 * data/collection.csv, for the same reason.
 *
 * Content-Type is readable here despite the sheet being cross-origin: unlike
 * Date, it is on the CORS-safelist. If Google ever stops sending a CSV type the
 * cost is that the copy stops refreshing rather than the copy going wrong, which
 * is the right way round to fail: the live response still goes straight back to
 * the page, and PapaParse doesn't look at content types, so a sheet suddenly
 * served as text/plain keeps loading.
 *
 * Nothing posts sheet-stale on that path, and nothing should. The fetch
 * succeeded and what the page is holding is the live response, not the frozen
 * one — there's no stale copy in play to warn about. And if what came back was
 * the login wall this guard is really for, the page works that out for itself:
 * the HTML fails assertExpectedHeaders in collection.js, load() falls back to
 * the committed snapshot, and that route puts up its own "from a saved copy"
 * line.
 */
function isCsv(response) {
  return (response.headers.get('content-type') || '').toLowerCase().includes('csv');
}

// Rebuild a response with the time it was cached written onto it. Responses
// are immutable, so this is a copy rather than a header edit.
async function stampCachedAt(response) {
  const headers = new Headers(response.headers);
  headers.set(CACHED_AT_HEADER, new Date().toISOString());
  return new Response(await response.blob(), {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

// Tell the open pages something. Controlled clients only: an uncontrolled page
// isn't having its fetches routed through here, so nothing it shows came from
// this worker and nothing here is news to it.
async function notifyClients(message) {
  const clients = await self.clients.matchAll({ type: 'window' });
  for (const client of clients) client.postMessage(message);
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
