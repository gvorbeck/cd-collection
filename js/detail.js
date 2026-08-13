/* ============================================================
   detail.js — the disc dialog
   ------------------------------------------------------------
   Opening a card: the cover at full size, the shelf location, the
   notes, the genre and tags as filters you can follow back out to
   the shelf, the search links, and a tracklist fetched on first
   open.

   The dialog is also a history entry — opening a disc pushes
   `#disc-<slug>` so Back closes it — so its lifecycle flags and the
   cleanup that removes the hash live here too, next to the code
   that sets them.
   ============================================================ */
import { el, formatLocation } from './collection.js';
import { formatDuration } from './musicbrainz.js';
import { hexToRgb, safeHex, blendWithPaper } from './color.js';
import { cachedCoverArt, resolveCoverArt, mbidFromCaaUrl, resolveTracklist } from './art.js';
import { generatePlaceholderCover } from './cover.js';
import { dom } from './dom.js';
import { saveLabelDraft } from './labelDraft.js';
import { state, togglePill } from './state.js';
import { DISC_HASH_PREFIX, buildUrl, discSlugFromHash, syncControlsToState } from './url.js';


// The disc the dialog is currently showing, and the tracklist painted for it.
// "Make label" reads both — the disc for artist/title/year, the tracks for the
// running order — and is held shut until the second one has settled, so the two
// are always in step. Cleared when the dialog closes.
let currentDisc = null;
let currentTracks = [];


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
  currentDisc = disc;

  dom.detailCover.innerHTML = '';
  const img = document.createElement('img');
  // Intrinsic 1:1 dimensions so the browser reserves a square box before the
  // art loads — no layout shift as it streams in. CSS scales it to fit.
  img.width = 400;
  img.height = 400;
  // Decorative, same as the cards: the dialog is labelled by the title and the
  // artist is the line under it, so alt text here reads them a second time.
  img.alt = '';

  // Real art this browser already has on file for the disc, if any: found by a
  // card or an earlier open in this session, or by any visit before it — the
  // art cache is localStorage and outlives the page.
  const knownArt = disc._resolvedArt || cachedCoverArt(disc);

  if (disc.art) {
    img.src = disc.art;
    img.addEventListener('error', () => { img.src = generatePlaceholderCover(disc); });
  } else if (knownArt) {
    // Already looked up and found — reuse that URL directly instead of running
    // another lookup. resolveCoverArt below would answer out of the same cache,
    // but only after a microtask and after pinning an in-flight promise to the
    // disc; taking the synchronous answer keeps the settled case out of the
    // async path altogether. Recorded on the disc exactly as that route would
    // have, so nothing downstream can tell the two apart.
    disc._resolvedArt = knownArt;
    // Show the placeholder first so there's no blank box while the remote image
    // loads, then swap to the real art once it has actually decoded.
    img.src = generatePlaceholderCover(disc);
    swapWhenLoaded(img, knownArt, disc.id);
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
  addMetaRow('Genre', filterButton('genre', disc.genre, 'detail-filter'));

  // Tags. Same chip as before, now the control it always looked like.
  dom.detailTags.innerHTML = '';
  disc.tags.forEach((t) => {
    dom.detailTags.appendChild(filterButton('tag', t, 'detail-tag detail-filter'));
  });

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

/**
 * The MusicBrainz thing this page can name for a disc without asking anyone —
 * `{ kind, id }`, or null when nothing here knows one, which is also the answer
 * to "would MusicBrainz have to be asked?". Either an id a lookup already
 * resolved this session, or the one sitting inside a cached Cover Art Archive
 * URL, which carries it in its path.
 *
 * The pinned release comes first when there is one: it's the more specific of
 * the two answers, and it's the pressing the sheet went to the trouble of
 * naming. Its group is a fine page to land on but not the one that was asked
 * for, and a release id in a /release-group/ URL is simply a 404.
 */
function knownMbEntity(disc) {
  const art = disc._resolvedArt || cachedCoverArt(disc);

  const release = disc._releaseMbid || mbidFromCaaUrl(art, 'release');
  if (release) return { kind: 'release', id: release };

  const group = disc._mbid || mbidFromCaaUrl(art);
  return group ? { kind: 'release-group', id: group } : null;
}

// One label/value row of the meta list. `value` is a string or a node — the
// genre is a button now (see filterButton), everything else is still text.
function addMetaRow(label, value) {
  const dd = el('dd');
  dd.append(value);
  dom.detailMeta.append(el('dt', null, label), dd);
}

/* ---------- Genre and tag, as filters ----------
   The dialog is otherwise a dead end: five links off the site and "Make label".
   Seeing that a record is post-punk and having no way to ask for the rest of
   the post-punk is the obvious missing move, so the genre and the tags are the
   same control here as they are on the rails above the grid. */

/**
 * A genre or tag rendered as the filter it stands for.
 *
 * The dataset is exactly what buildPillRail writes in render.js, because that
 * dataset is all togglePill reads — so this drives the shelf through the same
 * function the pills do, with no dialog-shaped special case at either end.
 * aria-pressed starts from live state for the same reason a pill's does: the
 * dialog can be opened with that genre already filtered, and a pressed state
 * that's a guess is worse than none.
 *
 * The visible word says what it is; the sr-only tail says what pressing it
 * does, the same split the "look it up" links use.
 */
function filterButton(type, value, className) {
  const btn = el('button', className, value);
  btn.type = 'button';
  btn.dataset.filterType = type;
  btn.dataset.filterValue = value;
  const set = type === 'genre' ? state.genres : state.tags;
  btn.setAttribute('aria-pressed', String(set.has(value)));
  btn.append(el('span', 'sr-only', ` — filter the shelf by this ${type}`));
  btn.addEventListener('click', () => filterByAndClose(btn));
  return btn;
}

/**
 * Apply one of those filters and get the dialog out of the way, so the press
 * lands you on the filtered shelf rather than on the record you just filtered by.
 *
 * The order matters, and so does which of the two close routes runs. A dialog
 * opened by a click pushed a history entry, and dismissDetail() normally unwinds
 * that entry with history.back() — but the entry it goes back to holds the URL
 * as it was BEFORE the dialog opened, filters and all, and onPopState reads that
 * URL back over state. Filter first and the pop undoes it; filter after and the
 * pop still undoes it, because the navigation is asynchronous either way. So the
 * entry is spent rather than unwound: clearing detailPushedHistory (declared
 * below, with the rest of the dialog's history bookkeeping) sends onDetailClosed
 * down its other existing branch, which drops the disc hash from the current
 * entry in place — no navigation, no popstate, nothing to fight. Back still
 * lands where it always did, on the shelf as it was before the dialog opened,
 * which is also the honest undo for the filter.
 *
 * Then the filter goes on, in that order, so the grid re-renders behind a dialog
 * that has already gone rather than during its dismissal.
 */
function filterByAndClose(btn) {
  // Read before dismissDetail: onDetailClosed clears currentDisc, and this is
  // the only handle on which card the keyboard is about to be knocked off.
  const disc = currentDisc;

  detailPushedHistory = false;
  dismissDetail();
  togglePill(btn);
  // togglePill presses the button it was handed, and this one isn't the rail's.
  // Without this the filter is on while its pill still reads unpressed — and an
  // unpressed tag pill is one the cloud is free to hide behind "show more".
  syncControlsToState();
  landOnShelf(disc);
}

/**
 * Put the keyboard back on the shelf after following a filter out of the dialog.
 *
 * dismissDetail closes the <dialog>, which hands focus back to the card that
 * opened it — right, and immediately undone. togglePill above re-renders the
 * grid, and renderCards moves every match through a DocumentFragment to get
 * them into sort order; a node parked in a fragment is out of the document, so
 * the browser drops focus to <body>. A disc always matches its own genre, so
 * its card is always one of the moved ones, so this always happened: Tab after
 * following a filter restarted at the top of the page, several screens from the
 * shelf you were just looking at. Same hazard hideWithoutLosingFocus exists
 * for, one step further along — there the element goes away, here it only
 * leaves and comes back, and the keyboard doesn't know the difference.
 *
 * _cardEl is re-pointed by renderCards for every disc it lays out, so this is
 * the live node by the time it runs — including after a view switch, where the
 * card for a disc is a different element than it was in grid. No preventScroll:
 * the filter moved the disc to a new place in a shorter grid, and seeing where
 * it landed is the point.
 *
 * The disc can also fail to survive: following a genre that's already on turns
 * it OFF, and another filter still standing can exclude the disc once it does.
 * Then its card was retired and removed, and the results readout takes focus —
 * the same fallback clearing a filter uses, sitting just ahead of the tools
 * cluster, and its text is the answer to what just happened.
 */
function landOnShelf(disc) {
  const card = disc && disc._cardEl;
  if (card && card.isConnected) card.focus();
  else if (dom.resultsCount) dom.resultsCount.focus({ preventScroll: true });
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

  // MusicBrainz last: a direct link to whatever we already resolved (from the
  // cover-art lookup, or from the disc's barcode), otherwise its search page.
  // Never fires a lookup of its own — a link shouldn't cost a request to draw.
  const found = knownMbEntity(disc);
  dom.detailLinks.appendChild(makeDetailLink(
    'MusicBrainz',
    found
      ? `https://musicbrainz.org/${found.kind}/${found.id}`
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

// How long "Make label" will wait on a tracklist before opening up anyway.
// Nothing in the MusicBrainz path has a request timeout, and its calls are
// throttled to one a second, so a stalled or queued lookup could otherwise hold
// the button shut for as long as the connection takes to give up. This site is
// built to be useful in a shop with no signal; a manual action can't be hostage
// to a best-effort lookup. Long enough to cover the throttle queue and a slow
// round trip, short enough not to read as broken.
const TRACKLIST_WAIT_CAP = 8000;

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
  currentTracks = [];

  // Offline, the only tracklist that can still arrive is one already in
  // localStorage from a previous visit, and that one arrives in a microtask —
  // long before anyone could reach the button. So there is nothing in flight for
  // "Make label" to be held shut over, and nothing to still be waiting on eight
  // seconds from now: this site is built to be useful in a shop with no signal,
  // and a control disabled for the length of a request that already failed is
  // the opposite of that. navigator.onLine is only trustworthy in one direction
  // — true can still mean a captive portal or a dead uplink — and false is the
  // direction being relied on here.
  const offline = navigator.onLine === false;

  // Nothing to hand over yet. "Make label" stays shut until this settles, so a
  // press during the lookup can't send a release stripped of the tracks that
  // are still in flight — the one way this feature could lose data quietly.
  setMakeLabelPending(!offline);

  // Offline with no release group known for this disc, the lookup would open
  // with a MusicBrainz search: certain to fail, a full throttle slot spent
  // failing, and nothing cached behind it either — the tracklist cache is keyed
  // by the very id we haven't got. So don't ask. The section stays hidden and
  // says nothing about it, exactly as it does for a disc MusicBrainz has never
  // heard of; an "you're offline" line here would be the apology this panel
  // deliberately doesn't make.
  if (offline && !knownMbid(disc)) return;

  const paint = (tracks) => {
    // The dialog may have moved on to another disc while we were waiting.
    if (dom.detail.dataset.discId !== disc.id) return;
    box.innerHTML = '';
    currentTracks = tracks || [];
    setMakeLabelPending(false);
    if (!tracks || !tracks.length) { box.hidden = true; return; }

    box.hidden = false;
    box.appendChild(el('h3', 'detail-tracks-heading', 'Tracklist'));
    const ol = el('ol', 'tracklist');
    // .tracklist turns off list-style, which is enough for Safari to drop the
    // list out of the accessibility tree entirely. Say it explicitly instead.
    ol.setAttribute('role', 'list');
    tracks.forEach((t, i) => {
      const li = el('li', 'tracklist-item');
      // The running order, written out as a real element. The <ol> would number
      // these itself, but Blink won't paint a ::marker on a flex list item and
      // the items have to be flex for the dotted leader — so the numbers were
      // there in the markup and invisible on screen.
      li.appendChild(el('span', 'track-num', `${i + 1}.`));
      li.appendChild(el('span', 'track-title', t.title));
      const len = formatDuration(t.length);
      if (len) li.appendChild(el('span', 'track-len', len));
      ol.appendChild(li);
    });
    box.appendChild(ol);
    const total = totalRuntime(tracks);
    if (total) box.appendChild(total);
  };

  // Still asked for on the offline path that got this far — but as a maybe, not
  // a certainty. Knowing the release group is not the same as having the tracks:
  // art.js keys its tracklist cache by `mbid|year` and fills it only for discs
  // someone actually opened, so a disc whose cover resolved from a card has an
  // id and no running order at all. What the id does buy is that the question
  // becomes answerable — if this disc's tracklist was fetched on some earlier
  // visit it comes straight back out of localStorage, and a disc looked up at
  // home should still show its running order in a shop. If it wasn't, the
  // request fails and the panel stays hidden, which is exactly what it does for
  // a disc MusicBrainz has no tracks for anyway. Worth one doomed request
  // against an id we already hold; the search this function bailed on above
  // would have been a doomed request AND a wasted throttle slot. Only the two
  // timers below are about an answer that might yet be coming over the wire,
  // and offline none is.
  const pending = resolveTracklist(disc);
  let settled = false;
  // resolveTracklist swallows its own failures, but a rejection here would be
  // an unhandled one — and "no tracklist" is the right answer either way.
  pending.then((tracks) => { settled = true; paint(tracks); })
         .catch(() => { settled = true; paint(null); });
  if (offline) return;

  // A cached tracklist resolves in a microtask, so only show the loading line
  // if we're actually about to hit the network.
  setTimeout(() => {
    if (settled || dom.detail.dataset.discId !== disc.id) return;
    box.hidden = false;
    box.innerHTML = '';
    box.appendChild(el('h3', 'detail-tracks-heading', 'Tracklist'));
    box.appendChild(el('p', 'tracklist-loading', 'Looking it up…'));
  }, 150);

  // Give up holding the button shut. The tracklist may still land later and
  // paint normally; this only says the wait is over, not the lookup.
  setTimeout(() => {
    if (settled || dom.detail.dataset.discId !== disc.id) return;
    setMakeLabelPending(false);
  }, TRACKLIST_WAIT_CAP);
}

/**
 * The disc's running time, as a footer row under the tracklist — or null when
 * MusicBrainz timed none of the tracks and there's nothing to add up.
 *
 * Built to sit under the list as one more leader row, so the figure lands in
 * the same column as the track times above it. When only some tracks are timed
 * the sum is a floor rather than the answer, and it says so out loud instead of
 * quietly presenting a short total as the real one.
 */
function totalRuntime(tracks) {
  const timed = tracks.filter((t) => t.length);
  if (!timed.length) return null;

  const ms = timed.reduce((sum, t) => sum + t.length, 0);
  const partial = timed.length < tracks.length;

  const row = el('p', 'tracklist-total');
  row.appendChild(el('span', 'tracklist-total-label', partial ? 'At least' : 'Total time'));
  row.appendChild(el('span', 'track-len', formatDuration(ms)));
  if (partial) {
    // The count is the whole explanation for a total that looks short; on
    // screen it's the small print, and to a screen reader it's part of the row.
    row.appendChild(el(
      'span',
      'sr-only',
      ` — ${timed.length} of ${tracks.length} tracks are timed`
    ));
  }
  return row;
}

/* ---------- "Make label" ---------- */

/**
 * Shut the button while a tracklist is on its way, and say why.
 *
 * A disabled control with no explanation is its own bug, so the reason goes on
 * the button itself — aria-disabled rather than the `disabled` attribute would
 * keep it focusable but wouldn't stop the click, and stopping the click is the
 * point. The title/aria-label pair covers pointer and screen reader alike.
 */
function setMakeLabelPending(pending) {
  const btn = dom.detailMakeLabel;
  btn.disabled = pending;
  if (pending) {
    btn.title = 'Waiting for the tracklist…';
    btn.setAttribute('aria-label', 'Make label — waiting for the tracklist');
  } else {
    btn.removeAttribute('title');
    btn.removeAttribute('aria-label');
  }
}

/**
 * Hand the disc on screen to the label generator: stash a draft and go there.
 *
 * The labels page fills its form from the draft and stops — nothing is added
 * to the print sheet, because the whole point of the trip is to look the thing
 * over (and top up the tracks) before committing it.
 *
 * Only reachable once the tracklist has settled (see setMakeLabelPending), so
 * what travels is the finished list, not however much of it had arrived. A disc
 * MusicBrainz doesn't know still comes over — with no tracks, which the labels
 * page says out loud and its own auto-fill can have another go at.
 */
export function makeLabelForCurrentDisc() {
  if (!currentDisc) return;

  saveLabelDraft({
    artist: currentDisc.artist,
    title: currentDisc.title,
    year: currentDisc.year,
    tracks: currentTracks.map(trackToLabelLine),
  });

  location.href = 'labels.html';
}

// One track as one line of a label's track list: the title, plus its running
// time when MusicBrainz gave us one. Same shape the labels page's own auto-fill
// writes, so a handed-over disc is indistinguishable from one typed in there.
function trackToLabelLine(track) {
  const len = formatDuration(track.length);
  return len ? `${track.title} ${len}` : track.title;
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

  // Let go of the disc and its tracks. Nothing can reach them once the dialog
  // is closed — a closed <dialog> is display:none, so its button takes neither
  // clicks nor focus — but leaving them set means every later reader has to
  // work that out, and it pins a tracklist for as long as the tab is open.
  currentDisc = null;
  currentTracks = [];

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
