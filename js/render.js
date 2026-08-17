/* ============================================================
   render.js — stats card, filter pills, and the disc grid
   ------------------------------------------------------------
   Everything that puts discs on screen short of opening one: the
   count card, the genre and tag rails, and the cards themselves in
   either view. Cards are built once per disc per view and then
   reused (see "Card reuse" below), which is what keeps filtering
   from churning through the art pipeline.
   ============================================================ */
import { CONFIG } from './config.js';
import { reducedMotion, hideWithoutLosingFocus } from './util.js';
import { el } from './collection.js';
import { shelfTag } from './owned.js';
import { colorForArtist, sampleDominantColor } from './color.js';
import { cachedCoverArt, resolveCoverArt, artLookupSettled } from './art.js';
import { generatePlaceholderCover } from './cover.js';
import { dom } from './dom.js';
import { state } from './store.js';


/* ----------------------------------------------------------
   What happens when a card is activated
   ----------------------------------------------------------
   Every card gets a click handler here, but what that handler *does*
   is registered from outside rather than imported. This file used to
   `import { openDetail } from './detail.js'`, and detail.js needs
   what's on screen to build the dialog, so the two imported each
   other — the last link in a cycle that ran render → detail → url →
   state → render.

   Inverting this one edge unpicks the whole thing: detail.js is free
   to import render.js, and render.js knows only that something wants
   to be told which disc was picked. app.js does the introduction, in
   wireEvents(), and state.js's shuffle goes through openCard() too so
   that landing on a disc and clicking it are the same act.

   The default is a no-op, so a card clicked before app.js has wired
   anything up (or on a page that has cards but no dialog) does
   nothing rather than throwing.
   ---------------------------------------------------------- */
let cardOpener = () => {};

// Say what opening a disc means. Called once, at startup.
export function setCardOpener(fn) {
  cardOpener = fn;
}

// Open a disc the same way clicking its card would.
export function openCard(disc) {
  cardOpener(disc);
}


// Announce something to screen readers via the polite live region. Discrete
// events (shuffle, export, view switch) go straight through — they're user
// actions, and one action deserves one announcement.
export function announce(message) {
  // Any pending count would land on top of this one; drop it.
  clearTimeout(countAnnounceTimer);
  lastCountAnnounced = '';
  dom.liveRegion.textContent = message;
}

let countAnnounceTimer;
let lastCountAnnounced = '';

/**
 * Announce the result count — the one announcement that isn't tied to a
 * discrete action.
 *
 * The search box refilters every 120ms while you type, and a polite live region
 * rewritten that often is one a screen reader spends its whole time restarting:
 * you hear the first syllable of a dozen counts and the end of none. So wait for
 * typing to settle, and say nothing when the number didn't actually change —
 * three keystrokes that keep narrowing to the same 4 discs are one result.
 */
export function announceCount(message) {
  clearTimeout(countAnnounceTimer);
  countAnnounceTimer = setTimeout(() => {
    if (message === lastCountAnnounced) return;
    lastCountAnnounced = message;
    dom.liveRegion.textContent = message;
  }, 700);
}

/**
 * Drop a queued count announcement without making one.
 *
 * Every other caller that takes the live region over — announce() above —
 * clears this timer on the way past, so the only paths that need this are the
 * ones that decide to say *nothing*. Not calling announceCount isn't the same as
 * silence: the 700ms timer armed by the keystroke or the click before is still
 * running, and it fires into a page that has moved on, reading out a count from
 * the state before last. That's worst in exactly the case applyFilters skips
 * for — focus has just landed on the results readout and the screen reader is
 * reading it — where the stale count interrupts the very announcement the skip
 * exists to protect.
 */
export function cancelCountAnnounce() {
  clearTimeout(countAnnounceTimer);
  // Same reset announce() does: something else has spoken (or deliberately
  // hasn't), so the next real count is news again even if the number matches.
  lastCountAnnounced = '';
}

// Build the stats "data card": total + per-genre counts.
export function renderStats(discs) {
  // Grouped, so a four-figure shelf reads as 1,234 and not as the serial number
  // 1234. stats.js has always done this to its own copy of the very same
  // number; the header never did, and the two pages sit one nav hop apart.
  //
  // The figure is the RELEASE count — one row of the sheet, however many discs
  // are in the box — which is why stats.js prints "releases" and "physical
  // discs" as two separate cards. The label beside this one in index.html reads
  // "releases on the shelf" for that reason; it used to say "discs", and the
  // wording is what moved rather than the number, because putting the disc
  // count under the old label would only have relocated the disagreement.
  dom.statTotal.textContent = discs.length.toLocaleString();

  // A Map, not a plain object: genres come from a spreadsheet anyone can type
  // into, and a genre literally named "constructor" or "__proto__" would
  // otherwise read back an inherited function instead of a count.
  const counts = new Map();
  for (const d of discs) counts.set(d.genre, (counts.get(d.genre) || 0) + 1);

  const ordered = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const visible = CONFIG.STATS_GENRES_VISIBLE;

  const rows = ordered.map(([genre, count], i) => {
    const li = document.createElement('li');
    // Genres past the top N start hidden; the toggle button reveals them.
    if (i >= visible) li.classList.add('is-collapsed');
    const dots = el('span', 'g-dots');
    dots.setAttribute('aria-hidden', 'true');
    // Built as nodes rather than an innerHTML string — every other renderer
    // here does, and it's the one construction that can't go wrong no matter
    // what the sheet contains.
    li.append(el('span', 'g-name', genre), dots, el('span', 'g-count', String(count)));
    return li;
  });

  // Only offer the toggle when there's something hidden to reveal.
  const hidden = ordered.length - visible;
  if (hidden > 0) rows.push(makeGenresToggle(hidden));

  dom.statGenres.replaceChildren(...rows);
}

// Build the "show more / show less" button that expands the collapsed genres.
// Toggling flips a class on the list and rewrites the button's label + ARIA
// state; the actual hiding is done in CSS via `.stats-genres li.is-collapsed`.
function makeGenresToggle(hiddenCount) {
  const btn = el('button', 'stats-genres-toggle');
  btn.type = 'button';
  btn.setAttribute('aria-expanded', 'false');

  const label = (expanded) =>
    expanded ? 'Show fewer' : `Show ${hiddenCount} more`;
  btn.textContent = label(false);

  btn.addEventListener('click', () => {
    const expanded = dom.statGenres.classList.toggle('is-expanded');
    btn.setAttribute('aria-expanded', String(expanded));
    btn.textContent = label(expanded);
  });

  const li = el('li', 'stats-genres-toggle-row');
  li.appendChild(btn);
  return li;
}

// Build the filter pill rails for genres and tags.
export function renderPills(discs) {
  const genres = new Set();
  const tagCounts = new Map();
  for (const d of discs) {
    genres.add(d.genre);
    d.tags.forEach((t) => tagCounts.set(t, (tagCounts.get(t) || 0) + 1));
  }

  buildPillRail(dom.genrePills, [...genres].sort(), 'genre');

  // Tags go in popularity order, ties A–Z. The cloud shows one line by default,
  // so which tags win that line has to mean something — alphabetical would put
  // whatever happens to start with "a" ahead of the tag on half the shelf.
  const tags = [...tagCounts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([tag]) => tag);
  buildPillRail(dom.tagPills, tags, 'tag');
  buildTagToggle();

  // Hide the tags group heading area gracefully if there are no tags at all.
  dom.tagPills.closest('.filter-group').hidden = tags.length === 0;
}

function buildPillRail(rail, values, type) {
  rail.innerHTML = '';
  for (const value of values) {
    const btn = el('button', 'pill', value);
    btn.type = 'button';
    btn.setAttribute('aria-pressed', 'false');
    btn.dataset.filterType = type;
    btn.dataset.filterValue = value;
    rail.appendChild(btn);
  }
}

/**
 * The tag cloud's expand control, appended inside the cloud rather than under
 * it so it flows at the end of the visible line.
 */
function buildTagToggle() {
  const btn = el('button', 'pill-more');
  btn.type = 'button';
  btn.hidden = true;               // layoutTagCloud decides whether it's needed
  btn.setAttribute('aria-expanded', 'false');
  btn.addEventListener('click', () => {
    tagsExpanded = !tagsExpanded;
    layoutTagCloud();
    // Focus stays on a button whose label just changed under it; say why.
    announce(tagsExpanded ? 'Showing all tags.' : 'Showing the most common tags.');
  });
  dom.tagMore = btn;
  dom.tagPills.appendChild(btn);
}

/**
 * Decide how much of the tag cloud is on screen.
 *
 * Collapsed, it's one line: the pills are measured and greedily packed until
 * the next one wouldn't leave room for the toggle, and everything past that
 * gets `hidden` — the attribute, not a class, so the overflow leaves the tab
 * order instead of sitting invisible and still focusable.
 *
 * A pressed pill is never hidden, even if that spills onto a second line. An
 * active filter you can't see is one you can't turn off, and arriving on a
 * ?tag= deep link can press a pill well down the popularity order.
 *
 * Every width is read in one pass while the whole cloud is visible, so this
 * costs a single layout rather than one per pill.
 */
export function layoutTagCloud() {
  const btn = dom.tagMore;
  if (!btn) return;

  const pills = [...dom.tagPills.querySelectorAll('.pill')];
  if (!pills.length) return;

  // Show everything first — widths are only measurable once laid out, and this
  // is also the finished expanded state.
  pills.forEach((pill) => { pill.hidden = false; });

  if (tagsExpanded) {
    btn.hidden = false;
    btn.setAttribute('aria-expanded', 'true');
    btn.textContent = 'Show fewer';
    return;
  }

  // Measure the toggle at its widest possible label, so the space reserved for
  // it can't come up short once the real count is known.
  btn.hidden = false;
  btn.textContent = `Show ${pills.length} more`;
  const btnWidth = btn.offsetWidth;

  const gap = parseFloat(getComputedStyle(dom.tagPills).columnGap) || 8;
  const avail = dom.tagPills.clientWidth;
  const widths = pills.map((pill) => pill.offsetWidth);

  let used = 0;
  let fit = 0;
  for (let i = 0; i < pills.length; i++) {
    const next = used + (i ? gap : 0) + widths[i];
    if (next + gap + btnWidth > avail) break;
    used = next;
    fit++;
  }

  // Where focus goes if the pill about to be hidden is the one holding it. That
  // is not a corner case: un-pressing an overflow tag pill is what un-pins it,
  // so the pill you just clicked is exactly the pill this loop hides, and
  // [hidden] is display:none — focus would land back on <body> and the next Tab
  // would restart at the top of the document. The toggle is the honest
  // destination because it is where the pill just went; it is also guaranteed
  // to be on screen here (anything hidden below means `hidden > 0`, so the
  // early-out that hides the toggle can't be reached), and the search input
  // stands by for the case where some future edit makes that untrue.
  const fallback = btn.hidden ? dom.search : btn;

  pills.forEach((pill, i) => {
    // Everything was shown above; only the hiding half needs the focus care.
    if (i >= fit && pill.getAttribute('aria-pressed') !== 'true') {
      hideWithoutLosingFocus(pill, fallback);
    }
  });

  const hidden = pills.reduce((n, pill) => n + (pill.hidden ? 1 : 0), 0);
  if (hidden === 0) {
    // Everything fit, or everything that didn't is pressed. Either way there's
    // nothing behind the toggle, so there's no toggle.
    btn.hidden = true;
    return;
  }
  btn.setAttribute('aria-expanded', 'false');
  btn.textContent = `Show ${hidden} more`;
}

/* ---------- Card reuse ----------
   A disc's card is built once and kept, per view. Filtering and sorting then
   move existing nodes around instead of discarding and rebuilding them.

   This started as a leak fix. Rebuilding meant every filter keystroke threw
   away every card and made new ones, and an IntersectionObserver holds a STRONG
   reference to each target it is given — dropping the node out of the DOM does
   not release it — so the observer accumulated every card ever rendered. That
   was patched by unobserving each card on the way out, which worked but left
   the underlying waste: a few hundred cards re-created, and a few hundred
   canvas placeholders re-drawn, on every keystroke.

   Reuse fixes both at once. The observer's target set is now bounded by the
   collection (one card per disc per view) instead of growing without limit, and
   a card that survives a filter keeps its loaded <img>, its sampled shadow
   color, and its place in the art pipeline. */

// disc → { grid: {li, card}, list: {li, card} }
const cardNodes = new Map();

/**
 * Point the cards held here at freshly-drawn placeholders.
 *
 * cover.js does the redraw and swaps the results in by walking document.images,
 * which reaches the dialog and every card on screen and by definition misses
 * the ones parked in the map above. Those are the whole point of the map — a
 * disc filtered out at the instant the webfonts arrived keeps its Arial Narrow
 * cover, and is re-attached still wearing it the next time it matches, which is
 * the one case the repaint exists to prevent. Nothing else can see these nodes,
 * so the other half of the swap has to live here.
 *
 * Takes cover.js's stale-src → fresh-src map rather than the discs, so the two
 * passes can't come to different conclusions about which covers were stale.
 */
export function repointCardImages(swaps) {
  if (!swaps || swaps.size === 0) return;
  for (const byView of cardNodes.values()) {
    for (const entry of Object.values(byView)) {
      const img = entry.card && entry.card.querySelector('img');
      if (!img) continue;
      const fresh = swaps.get(img.getAttribute('src'));
      if (fresh) img.src = fresh;
    }
  }
}

/**
 * The cached node pair for a disc in a view, built on first use.
 * Returns `isNew` so the caller can animate only the cards that have never
 * been on screen — a card that was already showing shouldn't re-animate just
 * because the result set moved around it.
 */
function nodeFor(disc, view) {
  let byView = cardNodes.get(disc);
  if (!byView) {
    byView = {};
    cardNodes.set(disc, byView);
  }
  if (byView[view]) return { ...byView[view], isNew: false };

  const li = view === 'list' ? buildRow(disc) : buildCard(disc);
  const entry = { li, card: li.firstElementChild };
  byView[view] = entry;
  return { ...entry, isNew: true };
}

/**
 * Take a card out of the grid without destroying it.
 * The node stays in `cardNodes` for the next time it matches; only the armed
 * dwell timer has to go, so a card filtered away mid-dwell can't spend a
 * MusicBrainz call on a cover that is no longer on screen. It stays observed
 * on purpose — when it comes back, it should still resolve its art.
 */
function retireCard(li) {
  const card = li.firstElementChild;
  if (card && card._artDwellTimer) {
    clearTimeout(card._artDwellTimer);
    card._artDwellTimer = null;
  }
  li.remove();
}

/**
 * Render a set of disc cards into the grid.
 * Handles cover art vs generated placeholder, and kicks off async color
 * sampling for real art so the card shadow gets tinted once it loads.
 */
export function renderCards(discs) {
  // The grid and the list are the same <ul> wearing a different class, so the
  // art pipeline, the observer, and the shuffle-landing code all keep working
  // unchanged across a view switch.
  const view = state.view;
  const isList = view === 'list';
  dom.grid.classList.toggle('is-list', isList);
  labelGrid(view);

  const fresh = [];
  const frag = document.createDocumentFragment();

  discs.forEach((disc) => {
    const { li, card, isNew } = nodeFor(disc, view);
    // Shuffle scrolls to and pulses whatever is currently on screen, so this
    // backref has to follow the view rather than being fixed at build time.
    disc._cardEl = card;
    if (isNew) fresh.push(card);
    // Appending to the fragment MOVES a node that's already in the grid, which
    // is what puts the matches in sort order without rebuilding them.
    frag.appendChild(li);
  });

  // Everything the loop didn't claim is left behind in the grid: those are the
  // discs that just stopped matching.
  Array.from(dom.grid.children).forEach(retireCard);

  dom.grid.appendChild(frag);
  revealCards(fresh, isList);
}

/**
 * Keep the grid's accessible name honest about which view it's wearing.
 *
 * The grid and the list are one <ul> with a class toggled on it, and the name
 * is the one thing about the element that can't be shared: "Album covers"
 * announced over a column of text rows describes the markup as it was written,
 * not what is in it — and the name is all a screen reader user gets before
 * deciding whether to walk in.
 *
 * Kept behind a memo on the view rather than written on every call, because
 * renderCards runs on every filter change and the search box refilters every
 * 120ms while you type: the name changes only when the toggle does, so that is
 * the only thing worth comparing.
 */
let labelledView = '';
function labelGrid(view) {
  if (view === labelledView) return;
  labelledView = view;
  // Deliberately no count. The element is a <ul>, so assistive tech already
  // says how many items are in it — putting the same figure in the name would
  // have it read twice in one breath, and #results-count is where the number
  // lives for everyone else.
  dom.grid.setAttribute('aria-label', view === 'list' ? 'Album list' : 'Album covers');
}

/**
 * Fade/slide the newly-built cards in, staggered.
 * Reduced motion shows them immediately, and so does the list — it's dense
 * enough that a staggered reveal reads as jitter rather than as motion.
 */
function revealCards(cards, isList) {
  if (isList || reducedMotion()) {
    cards.forEach((c) => c.classList.add('is-in'));
    return;
  }
  cards.forEach((card, i) => {
    const delay = Math.min(i * 35, 600); // cap so big grids don't drag
    setTimeout(() => card.classList.add('is-in'), delay);
  });
}

/**
 * Everything the grid card and the list row have in common: the <li> wrapper,
 * the <button> that opens the detail view, and the cover <img> wired into the
 * art pipeline. The two views differ in what they arrange around this, not in
 * any of it — and the parts that were duplicated (the shadow-property guard,
 * the click handler, the lazy/decorative <img>) are all
 * ones where a change to one copy and not the other is a silent bug.
 */
function buildCardShell(disc, { className = 'card', coverClass = 'card-cover-wrap' } = {}) {
  const li = document.createElement('li');
  li.className = 'grid-item';

  const card = document.createElement('button');
  card.type = 'button';
  card.className = className;
  // Only once there's a sampled color — setting the property to `undefined`
  // stringifies, which invalidates the box-shadow that reads it and leaves the
  // card with no shadow at all instead of the neutral one the CSS defines.
  if (disc.coverColor) card.style.setProperty('--card-shadow', disc.coverColor);
  // What the shelf makes of this record, on the wishlist page: `owned`,
  // `artist` or `wanted`. Absent entirely on the shelf page, where the question
  // doesn't arise — so the stylesheet's rules are all scoped to the attribute
  // being there rather than to the page.
  if (disc._shelf) card.dataset.shelf = disc._shelf.status;
  card.addEventListener('click', () => openCard(disc));

  const coverWrap = el('div', coverClass);
  const img = document.createElement('img');
  img.className = 'card-cover';
  img.loading = 'lazy';
  img.decoding = 'async';
  // Decorative: the artist + title are already text inside the button, so
  // giving the image alt text would make screen readers announce them twice.
  img.alt = '';
  setCoverImage(img, disc, card);
  coverWrap.appendChild(img);
  card.appendChild(coverWrap);

  li.appendChild(card);
  return { li, card, coverWrap };
}

function buildCard(disc) {
  const { li, card, coverWrap } = buildCardShell(disc);

  // Shelf-location accession tag (omit entirely if blank). Shows book + slot,
  // e.g. "B2 · #42–43"; a multi-disc release shows its slot range. On the
  // wishlist nothing has a slot, so the same corner carries the shelf's verdict
  // instead — and a record already in the books wears it as a stamp across the
  // cover rather than a tag, because "put this one back" is the single most
  // useful thing the page can say in a shop.
  const tag = disc.locationLabel || shelfTag(disc);
  if (tag) {
    coverWrap.appendChild(el('span', 'card-number', tag));
  }
  if (disc._shelf && disc._shelf.status === 'owned') {
    // aria-hidden: the same words are already in the tag above, which is inside
    // the button and read out with it. This is the visual half.
    const stamp = el('span', 'card-stamp', 'Own it');
    stamp.setAttribute('aria-hidden', 'true');
    coverWrap.appendChild(stamp);
  }

  // Body
  const body = el('div', 'card-body');
  body.appendChild(el('span', 'card-artist', disc.artist));
  body.appendChild(el('span', 'card-title', disc.title));
  if (disc.year) {
    body.appendChild(el('span', 'card-year', disc.year));
  }

  card.appendChild(body);
  return li;
}

/**
 * The list view's row: the same disc, one line high.
 * A cover wall is the nicest way to browse and the worst way to *scan* — at a
 * few hundred discs you want to run your eye down a column of titles, or print
 * the thing and take it to a shop. Rows keep a small thumbnail (so the art
 * pipeline is identical to the grid's) and lay the rest out as columns.
 */
function buildRow(disc) {
  // Same cover wrapper class as the grid (plus a sizing hook) so setCoverImage
  // and observeForArt need no special case here.
  const { li, card: row } = buildCardShell(disc, {
    className: 'card row',
    coverClass: 'card-cover-wrap row-thumb',
  });

  // Shelf location, in the mono "accession number" voice used everywhere else.
  // Spelled out rather than a dash: a screen reader reads this row as one
  // string, and "em dash" in the middle of it means nothing. A wishlist row has
  // no location to print, so this column becomes the verdict column — which is
  // what makes the list view the one to take to a shop.
  row.appendChild(el('span', 'row-loc', disc.locationLabel || shelfTag(disc) || (disc._shelf ? 'Wanted' : 'Uncataloged')));

  const text = el('div', 'row-text');
  text.appendChild(el('span', 'row-artist', disc.artist));
  text.appendChild(el('span', 'row-title', disc.title));
  row.appendChild(text);

  row.appendChild(el('span', 'row-genre', disc.genre));
  row.appendChild(el('span', 'row-year', disc.year || ''));

  return li;
}

/**
 * Decide what image a card shows.
 * - Real Art URL: load it CORS-enabled; on load, sample color and tint the
 *   shadow; on error, swap in a generated placeholder.
 * - Art we already found: same thing, straight away — no placeholder, no dwell.
 * - Nothing known: generate a placeholder immediately, tint from its hash, and
 *   go looking once the card is actually on screen.
 */
function setCoverImage(img, disc, card) {
  if (disc.art) {
    // Explicit Art URL from the sheet always wins — load it directly.
    loadRealCover(img, disc, card, disc.art);
    return;
  }

  // No sheet URL, but the disc may still have real art in hand. `_resolvedArt`
  // is what a lookup found earlier this session — here or in the detail view —
  // and art.js's localStorage cache answers for one found on any previous
  // visit, synchronously, for nothing. Not asking meant every repeat visit drew
  // a canvas placeholder and then sat out the 200ms observer dwell before
  // swapping in a URL the browser had had all along, on every card, every time.
  // detail.js does the same peek through the same helper; neither did before.
  const known = disc._resolvedArt || cachedCoverArt(disc);
  if (known) {
    // Same note resolveAndSwap leaves below, for the same reason: this is what
    // the detail view reads instead of running its own lookup.
    disc._resolvedArt = known;
    // buildCardShell sets img.loading = 'lazy' before calling us, so pointing
    // the <img> at a remote URL here buys the right src, not an eager download
    // — the fetch still waits for the card to come near the viewport.
    loadRealCover(img, disc, card, known);
    return;
  }

  // Nothing to go on: show the generated placeholder now, then try to find real
  // art via MusicBrainz — but only once this card scrolls on-screen (lazy), so
  // we never look up covers the visitor doesn't actually see.
  applyPlaceholder(img, disc, card);
  observeForArt(img, disc, card);
}

/**
 * Point an <img> at a real cover URL, CORS-enabled so its dominant color stays
 * canvas-readable. On load, sample + tint the card shadow. On error, ask once
 * more without CORS — the art may be perfectly reachable and only the stricter
 * request refused — and fall back to the generated placeholder only if that
 * fails too.
 */
function loadRealCover(img, disc, card, url) {
  img.crossOrigin = 'anonymous'; // so the canvas stays readable for sampling
  img.src = url;

  img.addEventListener('load', () => {
    // Real art is on screen now, so the grain tile comes off (styles.css scopes
    // it with :has(> .cover-placeholder) — see the block above that rule). This
    // sits ahead of every bail below, including the un-CORS one: a cover we can
    // display but not sample is still a photograph and still shouldn't wear
    // construction-paper tooth. The src check is what keeps the placeholder's
    // OWN load event from clearing the class it was just given — this handler
    // fires for whatever the <img> loads next, placeholder included, and
    // resolveAndSwap can leave more than one of these attached to one node.
    if (img.getAttribute('src') === url) img.classList.remove('cover-placeholder');

    // Two things reach this handler with no crossOrigin, and neither has pixels
    // worth reading: the placeholder the error handler draws (a data URL of our
    // own making) and the un-CORS retry it tries first (real art, but tainted —
    // sampling it would throw). Both already tinted the card on their way past.
    // The missing attribute is what tells them from the CORS load below, so this
    // bail stays first.
    if (!img.crossOrigin) return;

    if (disc._sampled) {
      // Already sampled, on some earlier card for this disc — usually the other
      // view's, since a disc gets one card per view. Re-sampling would only
      // repeat the work, but THIS card is a different node and may never have
      // been told the color: it was built (buildCardShell reads coverColor) at
      // a moment when the sample hadn't landed yet. Dropping straight through
      // is what left such a card wearing the stylesheet's neutral shadow while
      // its twin in the other view had the real one.
      card.style.setProperty('--card-shadow', disc.coverColor);
      return;
    }

    const color = sampleDominantColor(img) || CONFIG.NEUTRAL_SHADOW;
    disc.coverColor = color;
    disc._sampled = true;
    card.style.setProperty('--card-shadow', color);
  });

  img.addEventListener('error', () => {
    // A cors request is the fussier of the two ways to ask for this URL, and
    // failing it doesn't mean the image is unreachable — only that this
    // particular request couldn't have it. The detail dialog asks plainly and
    // may well be showing the very cover that just failed here, which is
    // exactly the complaint that put this branch in: art in the modal, a
    // placeholder on the card behind it, unchanged by any amount of reloading.
    // (sw.js's `answers` guard is the other half of that fix and repairs the
    // cache entry itself; this is what saves the card that's already on screen
    // when the response comes from somewhere the guard doesn't reach.) So try
    // once more without CORS before giving up on the art. The cost is the
    // sampled shadow — the pixels stay unreadable — so the tint falls back to
    // the artist hash, same as a placeholder would use.
    if (img.crossOrigin && img.getAttribute('src') === url) {
      img.removeAttribute('crossorigin');
      img.src = url;
      tintFromArtist(disc, card);
      return;
    }
    // Genuinely broken/blocked → fall back to a designed placeholder.
    applyPlaceholder(img, disc, card);
  });
}

function applyPlaceholder(img, disc, card) {
  img.removeAttribute('crossorigin'); // it's a data URL now; no CORS needed
  img.src = generatePlaceholderCover(disc); // memoized per disc
  // What the cover grain keys off (styles.css, .card-cover-wrap:has(...)).
  // Every path into this function is one where there is no photograph to show —
  // no art in the sheet, none cached, or a URL that just failed — so the class
  // is unconditional here. loadRealCover's load handler is the only thing that
  // takes it off, and only for the url it was itself asked to load.
  img.classList.add('cover-placeholder');
  tintFromArtist(disc, card);
}

// Tint a card from its artist hash — the stand-in for a color sampled off real
// art, used both by the placeholder and by a cover we can display but not read.
//
// The hash must never overwrite a real sample. It used to: switching to list
// view builds a second card for the disc (nodes are cached per disc PER VIEW),
// that card comes back through here, and the hash landed on top of the sampled
// color — after which loadRealCover's `_sampled` guard skipped the re-sample
// that would have put the real one back. The row kept the hash for the rest of
// the session, and so did the detail dialog's tint, which reads disc.coverColor:
// whether a disc's dialog was the right color depended on whether you had ever
// opened list view.
function tintFromArtist(disc, card) {
  if (!disc._sampled) disc.coverColor = colorForArtist(disc.artist);
  card.style.setProperty('--card-shadow', disc.coverColor);
}

// --- Lazy, on-screen-only art resolution --------------------------------
// One shared observer for the whole grid. When a placeholder card lingers near
// the viewport, resolve its real art and swap it in if found. rootMargin starts
// the lookup a bit before the card is fully visible. Once per card is the aim,
// but it's spelled "once per ANSWER" in the callback below — a lookup that
// bailed without learning anything doesn't spend the card's one chance.
//
// We do NOT fire on the intersecting edge directly: a fast scroll-past would
// enter the margin and leave it a moment later, but the lookup — once queued —
// runs unconditionally behind the ~1/sec MusicBrainz throttle, burning quota on
// covers already off-screen and blocking cards you actually stopped on. Instead
// each card must DWELL in the margin for ART_DWELL_MS before its lookup fires;
// a fly-by enters and leaves before the timer elapses, so it never enqueues.
const ART_DWELL_MS = 200;
let artObserver = null;

function getArtObserver() {
  if (artObserver || typeof IntersectionObserver === 'undefined') return artObserver;
  artObserver = new IntersectionObserver((entries, obs) => {
    for (const entry of entries) {
      const card = entry.target;
      if (entry.isIntersecting) {
        // Entered the margin: arm a dwell timer. If the card is still here when
        // it fires, resolve; a scroll-past clears it on the leave below.
        if (card._artDwellTimer) continue; // already armed
        card._artDwellTimer = setTimeout(() => {
          card._artDwellTimer = null;
          const { disc, img } = card._artTarget || {};
          if (!disc || !img) { obs.unobserve(card); return; }
          resolveAndSwap(img, disc, card).then(() => {
            // Stop watching once the ANSWER is in, not once the attempt is made.
            // Unobserving unconditionally right here — which is what this did —
            // made every non-answer permanent: browse offline and each card
            // bails at art.js's navigator.onLine check having learned nothing,
            // gets unobserved anyway, and is never asked again. The card-reuse
            // map hands the same <li> back for that disc all session and
            // observeForArt runs once per disc per view, so nothing re-attaches
            // the observer — reconnecting fixed nothing short of a reload, while
            // three comments claimed the opposite. Leaving an open question
            // observed costs one more dwell the next time the card re-enters the
            // margin, and art.js caps how many of those reach the network.
            if (artLookupSettled(disc)) obs.unobserve(card);
          });
        }, ART_DWELL_MS);
      } else if (card._artDwellTimer) {
        // Left the margin before dwelling long enough — cancel; nothing queued.
        clearTimeout(card._artDwellTimer);
        card._artDwellTimer = null;
      }
    }
  }, { rootMargin: '200px' });
  return artObserver;
}

function observeForArt(img, disc, card) {
  // Stash what this card needs so the observer callback can act on it.
  card._artTarget = { disc, img };
  const obs = getArtObserver();
  if (obs) {
    obs.observe(card);
  } else {
    // No IntersectionObserver (very old browser): resolve immediately.
    resolveAndSwap(img, disc, card);
  }
}

// Resolve real art for a placeholder disc and, if found, swap it in. Always
// loads the real cover when a URL exists — even after a re-render where the
// disc was sampled on a prior card — so the freshly-built placeholder card
// still gets the real art. loadRealCover's own guard skips the re-sample and
// just re-applies the color the first card found.
async function resolveAndSwap(img, disc, card) {
  const url = await resolveCoverArt(disc);
  if (url) {
    // Remember the resolved URL on the disc so the detail view — and the next
    // card built for it, in the other view — can reuse it directly instead of
    // running another lookup.
    disc._resolvedArt = url;
    loadRealCover(img, disc, card, url);
  }
}

// Whether the tag cloud is showing every tag or just the first line of them.
// Deliberately not in `state`: it's how much of a control is unrolled, not a
// view of the collection, so it has no business in a shared link.
let tagsExpanded = false;

/**
 * Click-and-drag horizontal scrolling for a pill rail (mouse only — touch
 * devices already get native momentum scrolling, so we leave those alone).
 * If the pointer moves past a small threshold we flag the rail so the click
 * that follows doesn't accidentally toggle a pill.
 */
export function enableDragScroll(rail) {
  let isDown = false;
  let startX = 0;
  let startScroll = 0;
  let moved = 0;

  rail.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'mouse' || e.button !== 0) return;
    isDown = true;
    moved = 0;
    startX = e.clientX;
    startScroll = rail.scrollLeft;
    rail.classList.add('is-dragging');
  });

  rail.addEventListener('pointermove', (e) => {
    if (!isDown) return;
    const dx = e.clientX - startX;
    moved = Math.max(moved, Math.abs(dx));
    rail.scrollLeft = startScroll - dx;
  });

  const end = () => {
    if (!isDown) return;
    isDown = false;
    rail.classList.remove('is-dragging');
    // Only suppress the click if this was a real drag, not a plain click.
    if (moved > 6) {
      rail._suppressClick = true;
      // Browsers don't reliably fire a click after a drag-scroll; clear the
      // flag shortly after so a later genuine click isn't swallowed.
      clearTimeout(rail._suppressTimer);
      rail._suppressTimer = setTimeout(() => { rail._suppressClick = false; }, 350);
    }
  };

  rail.addEventListener('pointerup', end);
  rail.addEventListener('pointerleave', end);
  rail.addEventListener('pointercancel', end);
}
