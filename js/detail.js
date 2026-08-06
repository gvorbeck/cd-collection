/* ============================================================
   detail.js — the disc dialog
   ------------------------------------------------------------
   Opening a card: the cover at full size, the shelf location, the
   notes, the search links, and a tracklist fetched on first open.

   The dialog is also a history entry — opening a disc pushes
   `#disc-<slug>` so Back closes it — so its lifecycle flags and the
   cleanup that removes the hash live here too, next to the code
   that sets them.
   ============================================================ */
import { el, formatLocation } from './collection.js';
import { formatDuration } from './musicbrainz.js';
import { hexToRgb, safeHex, blendWithPaper } from './color.js';
import { artCache, artCacheKey, resolveCoverArt, mbidFromCaaUrl, resolveTracklist } from './art.js';
import { generatePlaceholderCover } from './cover.js';
import { dom } from './dom.js';
import { DISC_HASH_PREFIX, buildUrl, discSlugFromHash } from './url.js';


/**
 * Open (or re-point) the detail dialog for a disc.
 *
 * `pushUrl` controls the history entry. A normal click pushes `#disc-<slug>`
 * so the dialog becomes shareable and the browser's Back button closes it;
 * opening in response to the URL itself (a deep link, or a popstate) passes
 * false, because the history entry is already the reason we're here.
 *
 * Re-points in place when the dialog is already open — showModal() throws on an
 * open dialog, and closing/reopening would flicker.
 */
export function openDetail(disc, { pushUrl = true } = {}) {
  // Location line, spelled out: "Book 2 · Catalog #42–43 (2 discs)".
  // Blank (no book and no number) reads as uncataloged.
  const loc = formatLocation(disc, { verbose: true });
  dom.detailNumber.textContent = loc || 'Uncataloged';
  dom.detailTitle.textContent = disc.title;
  dom.detailArtist.textContent = disc.artist;

  // Dialog background: a solid, opaque tint from the cover color (blended into
  // paper) — not translucent, so nothing from the page bleeds through.
  const tint = blendWithPaper(hexToRgb(safeHex(disc.coverColor)), 0.16);
  dom.detail.style.setProperty('--detail-bg', tint);

  // Tag the dialog with the disc it's showing, so an async art lookup that
  // resolves after a fast close/reopen can tell whether it's still the right
  // disc — ids are unique per row, unlike artist+title which can collide
  // (duplicates, reissues, same-named "Greatest Hits", etc.).
  dom.detail.dataset.discId = disc.id;

  dom.detailCover.innerHTML = '';
  const img = document.createElement('img');
  // Intrinsic 1:1 dimensions so the browser reserves a square box before the
  // art loads — no layout shift as it streams in. CSS scales it to fit.
  img.width = 400;
  img.height = 400;
  // Decorative, same as the cards: the dialog is labelled by the title and the
  // artist is the line under it, so alt text here reads them a second time.
  img.alt = '';
  if (disc.art) {
    img.src = disc.art;
    img.addEventListener('error', () => { img.src = generatePlaceholderCover(disc); });
  } else if (disc._resolvedArt) {
    // A card (or a prior detail open) already looked this disc up and found real
    // art — reuse that URL directly instead of running another lookup. Show the
    // placeholder first so there's no blank box while the remote image loads,
    // then swap to the real art once it has actually decoded.
    img.src = generatePlaceholderCover(disc);
    swapWhenLoaded(img, disc._resolvedArt, disc.id);
  } else {
    // No sheet Art URL and none resolved yet. Show the placeholder, then resolve.
    // resolveCoverArt is cache- and in-flight-aware: a URL already in the cache
    // (or a lookup still running from the card) returns without a second API
    // call, and a disc previously settled as a known-miss returns null without
    // any network. So opening the detail before the card's art came back never
    // fires a duplicate request — it joins the existing one.
    img.src = generatePlaceholderCover(disc);
    resolveCoverArt(disc).then((url) => {
      if (!url) return;
      // Remember a found URL on the disc so future opens skip the lookup path.
      disc._resolvedArt = url;
      // Preload into a detached image and only swap the visible src once the
      // real art has decoded, so the placeholder holds until then (no blank box).
      swapWhenLoaded(img, url, disc.id);
    });
  }
  dom.detailCover.appendChild(img);

  // Meta rows: only show fields that have content.
  dom.detailMeta.innerHTML = '';
  if (disc.year)  addMetaRow('Year', disc.year);
  addMetaRow('Genre', disc.genre);

  // Tags
  dom.detailTags.innerHTML = '';
  disc.tags.forEach((t) => dom.detailTags.appendChild(el('span', 'detail-tag', t)));

  // Notes (hidden when empty via CSS :empty)
  dom.detailNotes.textContent = disc.notes || '';

  // "Look it up" links out to the streaming shops and databases.
  renderDetailLinks(disc);

  // Tracklist: fetched from MusicBrainz on demand, so it only costs a request
  // for discs someone actually opens.
  renderTracklist(disc);

  // Only show a dialog that isn't already showing — showModal() on an open
  // dialog throws, and everything above has already re-pointed it at `disc`.
  if (!dom.detail.open) {
    if (typeof dom.detail.showModal === 'function') {
      dom.detail.showModal();
    } else {
      dom.detail.setAttribute('open', ''); // very old browsers
    }
    // Lock background scroll while the dialog is up (see .modal-open in CSS).
    dom.body.classList.add('modal-open');
    // Arm the close cleanup for this showing.
    detailCleanedUp = false;
  }

  // Owned here rather than by the caller: the flag means "did opening this
  // dialog add a history entry", which is exactly what `pushUrl` decides.
  if (pushUrl) pushDiscUrl(disc);
  else detailPushedHistory = false;
}

// Swap the detail cover's src to `url` only once that image has fully loaded,
// so the placeholder already in the <img> stays visible until the real art is
// ready — no blank box or flicker. Preloads via a detached Image; a load error
// simply leaves the placeholder in place. Re-checks that the dialog still shows
// this disc (by id) before swapping, since the load may finish after a
// close/reopen. The preload is a plain (non-CORS) request to match the visible
// <img>, so both share one browser cache entry and the swap is instant — a
// crossOrigin preload would be cached separately and force a second fetch.
function swapWhenLoaded(img, url, discId) {
  const pre = new Image();
  pre.onload = () => {
    if (dom.detail.open && dom.detail.dataset.discId === discId) img.src = url;
  };
  pre.src = url;
}

function addMetaRow(label, value) {
  dom.detailMeta.append(el('dt', null, label), el('dd', null, value));
}

/* ---------- "Look it up" links ----------
   The detail view knows where a disc sits on the shelf; these say where to go
   next with it. All are plain search URLs built from artist + title, so they
   need no API keys and no network of our own — except MusicBrainz, which gets
   a direct link when a release group has already been identified. */
const SERVICE_LINKS = [
  { name: 'Discogs',  href: (q) => `https://www.discogs.com/search/?type=release&q=${q}` },
  { name: 'Bandcamp', href: (q) => `https://bandcamp.com/search?q=${q}` },
  // The iTunes Store's music catalogue lives at music.apple.com now; this is
  // where an itms:// store link resolves to on the web.
  { name: 'iTunes',   href: (q) => `https://music.apple.com/search?term=${q}` },
  { name: 'Spotify',  href: (q) => `https://open.spotify.com/search/${q}` },
];

function renderDetailLinks(disc) {
  const query = encodeURIComponent(`${disc.artist} ${disc.title}`);
  dom.detailLinks.innerHTML = '';

  for (const svc of SERVICE_LINKS) {
    dom.detailLinks.appendChild(makeDetailLink(svc.name, svc.href(query)));
  }

  // MusicBrainz last: a direct release-group link if we already resolved one
  // (from the cover-art lookup), otherwise its search page. Never fires a
  // lookup of its own — a link shouldn't cost a request to draw.
  const mbid = disc._mbid || mbidFromCaaUrl(disc._resolvedArt || artCache[artCacheKey(disc)]);
  dom.detailLinks.appendChild(makeDetailLink(
    'MusicBrainz',
    mbid
      ? `https://musicbrainz.org/release-group/${mbid}`
      : `https://musicbrainz.org/search?type=release_group&query=${query}`
  ));
}

function makeDetailLink(name, href) {
  const a = el('a', 'detail-link');
  a.href = href;
  a.target = '_blank';
  // noopener/noreferrer: these are third-party sites opened in a new tab.
  a.rel = 'noopener noreferrer';
  // The icon says "this leaves the site" to anyone looking; the sr-only text
  // says the same thing to anyone listening. Both, or the cue is sighted-only.
  a.append(
    el('span', 'detail-link-name', name),
    externalIcon(),
    el('span', 'sr-only', '(opens in a new tab)')
  );
  return a;
}

/**
 * The box-and-arrow "leaves this site" glyph. Drawn with square caps and no
 * corner radii to match the hard-edged borders it sits inside, and stroked in
 * currentColor so it inverts along with the text on hover.
 */
function externalIcon() {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('class', 'detail-link-icon');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2.5');
  svg.setAttribute('stroke-linecap', 'square');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');

  for (const [tag, attrs] of [
    ['path',     { d: 'M17 13v7H4V7h7' }],            // frame, open at the corner
    ['polyline', { points: '14 3 21 3 21 10' }],      // arrowhead
    ['line',     { x1: '10', y1: '14', x2: '21', y2: '3' }],
  ]) {
    const node = document.createElementNS(NS, tag);
    for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
    svg.appendChild(node);
  }
  return svg;
}

/* ---------- Tracklist ---------- */

/**
 * Fill in the tracklist panel for a disc.
 * Async and best-effort: the panel shows a loading line, then either the
 * tracks or nothing at all. A disc MusicBrainz doesn't know simply has no
 * tracklist section, rather than an apology where content should be.
 */
function renderTracklist(disc) {
  const box = dom.detailTracks;
  box.innerHTML = '';
  box.hidden = true;

  const paint = (tracks) => {
    // The dialog may have moved on to another disc while we were waiting.
    if (dom.detail.dataset.discId !== disc.id) return;
    box.innerHTML = '';
    if (!tracks || !tracks.length) { box.hidden = true; return; }

    box.hidden = false;
    box.appendChild(el('h3', 'detail-tracks-heading', 'Tracklist'));
    const ol = el('ol', 'tracklist');
    tracks.forEach((t) => {
      const li = el('li', 'tracklist-item');
      li.appendChild(el('span', 'track-title', t.title));
      const len = formatDuration(t.length);
      if (len) li.appendChild(el('span', 'track-len', len));
      ol.appendChild(li);
    });
    box.appendChild(ol);
  };

  // A cached tracklist resolves in a microtask, so only show the loading line
  // if we're actually about to hit the network.
  const pending = resolveTracklist(disc);
  let settled = false;
  // resolveTracklist swallows its own failures, but a rejection here would be
  // an unhandled one — and "no tracklist" is the right answer either way.
  pending.then((tracks) => { settled = true; paint(tracks); })
         .catch(() => { settled = true; paint(null); });
  setTimeout(() => {
    if (settled || dom.detail.dataset.discId !== disc.id) return;
    box.hidden = false;
    box.innerHTML = '';
    box.appendChild(el('h3', 'detail-tracks-heading', 'Tracklist'));
    box.appendChild(el('p', 'tracklist-loading', 'Looking it up…'));
  }, 150);
}

// True when the dialog currently open was opened by us pushing a history
// entry (a click), rather than by the URL already pointing at it (a deep
// link or a Back/Forward). It decides how closing the dialog gets rid of the
// hash: go Back if we pushed, or rewrite the URL in place if we didn't —
// calling history.back() on a fresh deep link would leave the site entirely.
let detailPushedHistory = false;

// Set while WE are closing the dialog to match the URL, so the resulting
// `close` event doesn't try to drive history in turn and loop.
let closingForHistory = false;

// Guards the close cleanup against running twice for one dismissal (it is
// invoked directly by dismissDetail and again by the native `close` event).
// Starts true so a stray event before anything has opened does nothing.
let detailCleanedUp = true;

// Push a history entry for an opened disc, so Back closes the dialog.
function pushDiscUrl(disc) {
  history.pushState({ discSlug: disc.slug }, '', buildUrl(`${DISC_HASH_PREFIX}${disc.slug}`));
  detailPushedHistory = true;
}

/**
 * Close the dialog and tidy up after it.
 *
 * close() is synchronous but its event is only queued, so for the routes we
 * drive ourselves (close button, backdrop, Back) the cleanup runs here rather
 * than a task later — the page is scrollable and the URL is honest in the same
 * frame the dialog disappears. The `close` listener still fires afterwards and
 * covers Esc, which the browser handles without going through this function;
 * onDetailClosed is written to be safe to run twice.
 */
export function dismissDetail() {
  dom.detail.close();
  onDetailClosed();
}

// Close the dialog because the URL says it shouldn't be open, without letting
// the close handler push history back the other way.
export function closeDetailForHistory() {
  closingForHistory = true;
  dismissDetail();
}

/**
 * Release the scroll lock and clean the disc hash out of the URL once the
 * dialog is gone. Runs from dismissDetail for the routes we control and from
 * the dialog's native `close` event for the ones we don't (Esc) — so it runs
 * twice for most dismissals and must be idempotent. `detailCleanedUp` is what
 * makes the second run a no-op; openDetail arms it again.
 */
export function onDetailClosed() {
  if (detailCleanedUp) return;
  detailCleanedUp = true;

  dom.body.classList.remove('modal-open');

  // We closed it ourselves to match a Back/Forward — history is already right.
  if (closingForHistory) {
    closingForHistory = false;
    return;
  }
  if (!discSlugFromHash()) return; // nothing to clean up

  if (detailPushedHistory) {
    // We added this entry, so unwinding it is the honest way back: it also
    // restores whatever scroll position and filters preceded the dialog.
    detailPushedHistory = false;
    history.back();
  } else {
    // Arrived here by deep link, so there is nothing of ours to go back to —
    // going back would leave the site. Drop the hash in place instead.
    history.replaceState(history.state, '', buildUrl(''));
  }
}
