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

const CACHE_VERSION = 'v10';
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
  'wishlist.html',
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
  'js/owned.js',
  'js/shop.js',
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
  'data/wishlist.csv',
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
    const response = await fetch(revalidating(request));
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
      // `url` because there is more than one sheet now: the collection tab and
      // the wishlist tab are separate published CSVs, and the wishlist page
      // fetches both (its own rows, plus the shelf it checks them against). A
      // message that only said "a sheet is stale" would have that page reporting
      // whichever one it happens to be built around, regardless of which one
      // actually came out of the cache.
      await notifyClients({
        type: 'sheet-stale',
        url: request.url,
        cachedAt: cached.headers.get(CACHED_AT_HEADER),
      });
      return cached;
    }
    throw err;
  }
}

/**
 * The same request, with the browser's own HTTP cache told to check first.
 *
 * Without this the whole network-first strategy can be a no-op. Google serves
 * the published CSV with a cache lifetime of its own, so a plain fetch() is
 * free to answer out of the browser's HTTP cache without going near the
 * network — the worker sees a 200, the page sees a 200, and what everyone is
 * actually holding is the sheet as it stood the last time it was fetched. Add
 * an edit to the sheet and the site shows the version before it, indefinitely,
 * with nothing on screen to say so: the stale banner only fires when the
 * *worker's* cache is the one answering, and here it never gets asked.
 *
 * That was the bug worth catching. The sheet is edited constantly and the
 * whole point of the shop check is being told what is on the shelf right now.
 *
 * 'no-cache' rather than 'reload' or 'no-store': it still sends the
 * conditional headers, so an unchanged sheet comes back 304 with no body and
 * costs nothing on a phone's connection. Only the freshness lie is removed.
 *
 * Offline is untouched — the fetch throws either way, and the catch above
 * hands back the cached copy with the message that says it is one.
 */
function revalidating(request) {
  // A Request is immutable, and the constructor is the only way to change the
  // cache mode. Copy through explicitly: a bare `new Request(request)` keeps
  // most of it, but being specific here is what stops a future header from
  // being dropped silently. These sheets are plain cross-origin GETs.
  return new Request(request.url, {
    cache: 'no-cache',
    credentials: request.credentials,
    headers: request.headers,
    method: request.method,
    mode: request.mode,
    redirect: 'follow',
    referrer: request.referrer,
  });
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

/**
 * Can this cached response answer this request?
 *
 * The Cache API matches on URL alone — request mode is not part of the lookup —
 * so an opaque response stored from a no-cors request is handed straight back
 * to a cors one for the same URL. The browser then rejects it, because a cors
 * request may not be satisfied by a response it isn't allowed to read, and the
 * image fires `error`.
 *
 * That is what put a cover in the detail dialog and a placeholder on the card
 * behind it. The dialog's <img> is a plain request; the card's carries
 * crossOrigin="anonymous", because the shadow tint is sampled off the pixels
 * and a canvas won't give them up otherwise. Both ask for the same URL, and
 * whichever lands in the cache first is what everyone gets afterwards — so a
 * disc opened while its card was still resolving cached the dialog's opaque
 * copy, and the card fell back to its placeholder from then on. Permanently:
 * the cache outlives the tab, so no amount of reloading changed it.
 *
 * Refetching lets the cors response overwrite the opaque one, which is strictly
 * the more useful of the two — a no-cors request is happy with either, so the
 * entry converges on the copy that answers both and stays there. Nothing has to
 * be thrown away to repair a poisoned entry, which is why CACHE_VERSION isn't
 * bumped for this: the first cors request after this ships fixes the disc it
 * was asking about.
 */
function answers(cached, request) {
  return !(cached.type === 'opaque' && request.mode === 'cors');
}

/**
 * Fetch art in the mode that can answer both kinds of request.
 *
 * Asking CORS-first regardless of how the page asked is what stops the cache
 * entry being poisoned again by the next no-cors request, and it buys
 * something the opaque copy never could: a readable status. An opaque response
 * is status 0 whether the archive sent back an image or a 404, so a cover the
 * archive simply hasn't got was indistinguishable from one it had, and the
 * miss went into the cache as though it were art — a junk entry, holding a slot
 * against ART_CACHE_MAX, evicting a real cover to do it. Optimistic URLs make
 * that common rather than rare: caaUrl builds a front-image address out of an
 * MBID without asking whether there's an image at it. A cors 404 is visibly not
 * ok and is never stored.
 *
 * The no-cors fallback is for the day the archive stops sending CORS headers.
 * Nothing suggests it will — the whole card path has always depended on those
 * headers, since the shadow tint is sampled off the pixels — but the failure
 * mode without a fallback is every cover on the site disappearing, and an
 * opaque copy still paints.
 */
async function fetchArt(request) {
  try {
    return await fetch(new Request(request.url, { mode: 'cors', credentials: 'omit' }));
  } catch (err) {
    // No point handing an opaque response to a caller that can't accept one —
    // let it fail, and render.js's un-CORS retry comes back through here as a
    // no-cors request that can.
    if (request.mode === 'cors') throw err;
    return fetch(request);
  }
}

// The art strategy, and only that despite the general-sounding name — it goes
// through fetchArt, which knows the archive sends CORS headers. Route something
// else here and that assumption comes with it.
//
// Takes the FetchEvent for the same reason staleWhileRevalidate does: the trim
// runs after the response is handed back, and without waitUntil() the worker is
// free to be killed mid-delete — which is how a capped cache quietly stops
// being capped.
async function cacheFirst(event, cacheName, { trimTo } = {}) {
  const { request } = event;
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached && answers(cached, request)) return cached;

  let response;
  try {
    response = await fetchArt(request);
  } catch (err) {
    // Offline, or a CORS failure on the one path that gets here holding
    // something: an opaque entry a cors request can't use. Hand it over anyway
    // rather than failing outright — the cors <img> still can't read it, but
    // render.js retries without CORS on that error, and the retry is answered
    // from this same entry.
    if (cached) return cached;
    throw err;
  }

  // Opaque responses only reach here from fetchArt's fallback, and only because
  // an opaque image still paints. They're stored for the same reason, with the
  // known cost that a miss is opaque too and gets stored looking like a hit.
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
