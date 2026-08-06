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
import { reducedMotion } from './util.js';
import { el } from './collection.js';
import { colorForArtist, sampleDominantColor } from './color.js';
import { resolveCoverArt } from './art.js';
import { generatePlaceholderCover } from './cover.js';
import { dom } from './dom.js';
import { openDetail } from './detail.js';
import { state } from './state.js';


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

// Build the stats "data card": total + per-genre counts.
export function renderStats(discs) {
  dom.statTotal.textContent = discs.length;

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

  pills.forEach((pill, i) => {
    pill.hidden = i >= fit && pill.getAttribute('aria-pressed') !== 'true';
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
  card.addEventListener('click', () => openDetail(disc));

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
  // e.g. "B2 · #42–43"; a multi-disc release shows its slot range.
  if (disc.locationLabel) {
    coverWrap.appendChild(el('span', 'card-number', disc.locationLabel));
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
  // string, and "em dash" in the middle of it means nothing.
  row.appendChild(el('span', 'row-loc', disc.locationLabel || 'Uncataloged'));

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
 * - No Art URL: generate a placeholder immediately and tint from its hash.
 */
function setCoverImage(img, disc, card) {
  if (disc.art) {
    // Explicit Art URL from the sheet always wins — load it directly.
    loadRealCover(img, disc, card, disc.art);
  } else {
    // No Art URL: show the generated placeholder now, then try to find real art
    // via MusicBrainz — but only once this card scrolls on-screen (lazy), so we
    // never look up covers the visitor doesn't actually see.
    applyPlaceholder(img, disc, card);
    observeForArt(img, disc, card);
  }
}

/**
 * Point an <img> at a real cover URL, CORS-enabled so its dominant color stays
 * canvas-readable. On load, sample + tint the card shadow; on error, fall back
 * to the generated placeholder.
 */
function loadRealCover(img, disc, card, url) {
  img.crossOrigin = 'anonymous'; // so the canvas stays readable for sampling
  img.src = url;

  img.addEventListener('load', () => {
    // Skip if this load is the placeholder swapped in after an error (the
    // error handler drops crossOrigin), or if we already have a sampled color
    // cached from a previous render — re-sampling would just repeat the work.
    if (!img.crossOrigin || disc._sampled) return;
    const color = sampleDominantColor(img) || CONFIG.NEUTRAL_SHADOW;
    disc.coverColor = color;
    disc._sampled = true;
    card.style.setProperty('--card-shadow', color);
  });

  img.addEventListener('error', () => {
    // Broken/blocked image → fall back to a designed placeholder.
    applyPlaceholder(img, disc, card);
  });
}

function applyPlaceholder(img, disc, card) {
  img.removeAttribute('crossorigin'); // it's a data URL now; no CORS needed
  img.src = generatePlaceholderCover(disc); // memoized per disc
  const color = colorForArtist(disc.artist);
  disc.coverColor = color;
  card.style.setProperty('--card-shadow', color);
}

// --- Lazy, on-screen-only art resolution --------------------------------
// One shared observer for the whole grid. When a placeholder card lingers near
// the viewport, resolve its real art (once) and swap it in if found. rootMargin
// starts the lookup a bit before the card is fully visible.
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
          obs.unobserve(card); // resolve at most once per card
          const { disc, img } = card._artTarget || {};
          if (disc && img) resolveAndSwap(img, disc, card);
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
// still gets the real art. loadRealCover's own guard skips re-sampling.
async function resolveAndSwap(img, disc, card) {
  const url = await resolveCoverArt(disc);
  if (url) {
    // Remember the resolved URL on the disc so the detail view can reuse it
    // directly instead of running another lookup.
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
