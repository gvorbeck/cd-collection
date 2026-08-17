/* ============================================================
   stats.js — the infographic breakdown
   ------------------------------------------------------------
   Reads the same sheet as the grid, through collection.js, and
   counts it three ways: by decade, by genre, and by artist.
   Everything here is derived — there is no state to keep and
   nothing to persist, so it renders once and stops.

   Charts are plain DOM (a labelled row, a track, a filled bar)
   rather than a charting library. At this data size a bar is a
   div with a width, and a div can be styled to look printed.
   ============================================================ */

// Side effect only, and first: installs the global error handlers as it
// evaluates, which has to happen before any module below it runs. See errors.js.
import './errors.js';
import {
  el, load, loadedFrom, noteDataSource, DATA_SOURCES, usingSample,
  registerServiceWorker,
  staleReportForPage, listenForStaleSheet, dataSourceNotice,
} from './collection.js';

// How many rows each ranked chart shows before it stops being a chart and
// starts being a list.
const TOP_GENRES = 12;
const TOP_ARTISTS = 15;

// Bar colors, cycled in order. Same five accents the rest of the site uses.
const BAR_COLORS = ['--brick', '--mustard', '--teal', '--orange', '--forest'];

// The tag cloud's type-size range, in rem. The floor is the smallest mono size
// used anywhere on the site (the panel notes sit at 0.68rem) — a cloud that
// scales all the way down to unreadable is a cloud that hides its long tail.
// The ceiling is a shade under .panel-title's smallest clamp, so the busiest
// tag never out-shouts the heading above it.
const TAG_SIZE_MIN = 0.72;
const TAG_SIZE_MAX = 1.75;

const dom = {};

document.addEventListener('DOMContentLoaded', init);

async function init() {
  registerServiceWorker();
  listenForStaleSheet();

  dom.figures     = document.getElementById('figures');
  dom.decades     = document.getElementById('chart-decades');
  dom.genres      = document.getElementById('chart-genres');
  dom.tags        = document.getElementById('tag-cloud');
  dom.tagPanel    = document.getElementById('panel-tags');
  dom.tagNote     = document.getElementById('note-tags');
  dom.artists     = document.getElementById('chart-artists');
  dom.stateMsg    = document.getElementById('state-msg');
  dom.staleNotice = document.getElementById('stale-notice');

  try {
    // The wishlist is the second tone in the tag cloud and nothing else on this
    // page, so it fails soft: an unreachable or unpublished wishlist tab costs
    // the comparison, not the statistics. Started alongside the collection
    // rather than after it — they are two independent GETs and the page has
    // nothing to draw until both are in.
    const [discs, wants] = await Promise.all([
      load('collection'),
      load('wishlist').catch((err) => {
        console.warn('Counted the collection, but the wishlist did not load — one-tone tag cloud:', err);
        return [];
      }),
    ]);

    // Fold the worker's answer in now that load() has made its own — see the
    // note on staleReportForPage in collection.js for why it can't be applied
    // any earlier.
    if (staleReportForPage() && loadedFrom() === DATA_SOURCES.SHEET) {
      noteDataSource(DATA_SOURCES.CACHE);
    }

    if (discs.length === 0) {
      dom.stateMsg.textContent = 'The collection is empty right now.';
      return;
    }
    render(discs, wants);
    dom.stateMsg.hidden = true;
    // Immediately after, and only here: this is the one path where the figures
    // actually rendered, so it is the one path where #state-msg goes quiet and
    // the notice takes its turn. Those two are the page's only spoken elements
    // (see the comment on each in stats.html), and they don't overlap — the
    // notice holds its text back a beat, so it speaks after this line has.
    refreshDataNotice();
    // Coming back online: the numbers on screen were counted from a copy, and
    // the notice can now offer the reload that would recount them from the
    // sheet. Nothing else on this page waits on a connection.
    window.addEventListener('online', refreshDataNotice);
  } catch (err) {
    console.error(err);
    dom.stateMsg.textContent = 'Could not load the collection. Check the sheet is still published.';
    dom.stateMsg.classList.add('is-error');
  }
}

function render(discs, wants) {
  renderFigures(discs);
  renderDecades(discs);
  renderGenres(discs);
  renderTags(discs, wants);
  renderArtists(discs);
}


/* ----------------------------------------------------------
   Where these numbers came from
   ----------------------------------------------------------
   The shared half of this — which sheet the worker answered out of its cache,
   when that copy was saved, and the sentence describing it — is in
   collection.js, alongside DATA_SOURCES. It used to be a hand-synced duplicate
   of the same functions in app.js, with a comment in each asking the next
   editor to change both. They drifted anyway.

   The one word the two pages legitimately disagree on is passed in: this page
   *counted from* the saved copy where the grid page is *showing* it, because
   that is what each did with the rows.

   refreshDataNotice below is genuinely a different function on each page, not
   the same one twice, and stays here. The grid has a dedicated #live-region and
   hands its notice back so init() can fold it into a single announcement; here
   the notice element is itself the live region, so this writes to it, times the
   write so it registers as a change, and returns nothing.
   ---------------------------------------------------------- */


// What the notice element has been told to say, and the timer that will tell
// it. Both exist for refreshDataNotice below and nothing else reads them.
let noticeSaid = '';
let noticeTimer;

/**
 * Put that line in #stale-notice, or take it back out. That element carries
 * role=status here — this page has no separate live region the way the grid
 * does — so writing to it is also how the notice gets announced, and the write
 * has to be timed rather than just made.
 */
function refreshDataNotice() {
  // Called before load() settled, or after it failed outright: #state-msg is
  // still carrying the counting line or the error, and neither is ours to clear.
  if (!loadedFrom() || !dom.staleNotice) return;
  // "counted from" — see the note above, and dataSourceNotice in collection.js.
  const notice = dataSourceNotice('counted from');
  if (!notice) { dom.staleNotice.hidden = true; return; }

  // 'online' fires on every reconnect, spurious ones included, and the only
  // part of the notice that depends on a connection is the closing "Reload to
  // try again." So the string usually comes back identical — and writing an
  // identical string into a live region is still a change as far as the region
  // is concerned. Without this, a flaky café connection has the page say the
  // same sentence over and over.
  if (notice === noticeSaid) return;
  noticeSaid = notice;

  // Unhide first, fill in second, with a task in between. A hidden element is
  // out of the accessibility tree entirely, so doing both in one go hands
  // assistive tech a region that arrives with its text already in it — read as
  // the region's starting content rather than as a change to it, and so never
  // spoken. That is the same trap labels.js's fill status steps around, and it
  // costs more here: this line is the only thing telling someone the figures
  // they are about to read were counted from a copy of the sheet.
  //
  // The cost is the 1.35rem of .panel-note margin standing empty for those
  // 120ms, on a page that is still drawing its charts. A timer rather than
  // requestAnimationFrame, because rAF doesn't run while the document is
  // hidden — this would then be spoken whenever the tab was next painted,
  // which could be minutes later or never.
  dom.staleNotice.hidden = false;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => { dom.staleNotice.textContent = notice; }, 120);
}


/* ----------------------------------------------------------
   Headline figures
   ---------------------------------------------------------- */

function renderFigures(discs) {
  // A release and a disc aren't the same thing: a 3-CD box set is one row in
  // the sheet but occupies three slots in a book. Both numbers are worth
  // showing, and they're the two most likely to be misread as each other.
  const physical = discs.reduce((sum, d) => sum + d.discCount, 0);
  const artists = new Set(discs.map((d) => d.artist)).size;
  const genres = new Set(discs.map((d) => d.genre)).size;

  const years = discs.map((d) => parseInt(d.year, 10)).filter(isPlausibleYear);
  const span = years.length
    ? `${Math.min(...years)}–${Math.max(...years)}`
    : '—';

  const figures = [
    { value: discs.length, label: 'releases' },
    { value: physical,     label: 'physical discs' },
    { value: artists,      label: 'artists' },
    { value: genres,       label: 'genres' },
    { value: span,         label: 'years covered', wide: true },
  ];

  dom.figures.replaceChildren(...figures.map(({ value, label, wide }) => {
    const card = el('div', `figure-card${wide ? ' is-wide' : ''}`);
    card.append(
      el('span', 'figure-value', typeof value === 'number' ? value.toLocaleString() : value),
      el('span', 'figure-label', label)
    );
    return card;
  }));
}

// Guard against a typo'd or mis-parsed year turning the span into "3–2024".
function isPlausibleYear(n) {
  return Number.isInteger(n) && n >= 1900 && n <= new Date().getFullYear() + 1;
}


/* ----------------------------------------------------------
   By decade
   ---------------------------------------------------------- */

function renderDecades(discs) {
  const counts = new Map();
  let unknown = 0;

  for (const disc of discs) {
    const year = parseInt(disc.year, 10);
    if (!isPlausibleYear(year)) { unknown++; continue; }
    const decade = Math.floor(year / 10) * 10;
    counts.set(decade, (counts.get(decade) || 0) + 1);
  }

  if (counts.size === 0 && unknown === 0) return;

  // Fill in the empty decades between the earliest and latest. A histogram
  // with a decade silently missing reads as a decade with no gap at all,
  // which is a different claim than "nothing from the 90s".
  const rows = [];
  if (counts.size) {
    const decades = [...counts.keys()];
    for (let d = Math.min(...decades); d <= Math.max(...decades); d += 10) {
      rows.push({ label: `${d}s`, count: counts.get(d) || 0 });
    }
  }
  if (unknown) rows.push({ label: 'No year', count: unknown, muted: true });

  const max = Math.max(...rows.map((r) => r.count));
  dom.decades.replaceChildren(...rows.map((row, i) =>
    barRow({
      label: row.label,
      count: row.count,
      max,
      color: row.muted ? null : BAR_COLORS[i % BAR_COLORS.length],
    })
  ));
}


/* ----------------------------------------------------------
   By genre
   ---------------------------------------------------------- */

function renderGenres(discs) {
  const ranked = rank(discs.map((d) => d.genre));
  const shown = ranked.slice(0, TOP_GENRES);
  const max = shown.length ? shown[0].count : 0;

  const rows = shown.map((entry, i) =>
    barRow({
      label: entry.name,
      count: entry.count,
      max,
      color: BAR_COLORS[i % BAR_COLORS.length],
      // Back to the grid with that genre already selected — the numbers here
      // are only interesting if you can go look at what they describe.
      href: gridUrl(`genre=${encodeURIComponent(entry.name)}`),
    })
  );

  const rest = ranked.slice(TOP_GENRES);
  if (rest.length) {
    const tail = rest.reduce((sum, e) => sum + e.count, 0);
    rows.push(el('p', 'chart-tail',
      `+ ${rest.length} more ${rest.length === 1 ? 'genre' : 'genres'} (${tail} ${tail === 1 ? 'release' : 'releases'})`));
  }

  dom.genres.replaceChildren(...rows);
}


/* ----------------------------------------------------------
   By tag
   ----------------------------------------------------------
   The one chart here that isn't ranked. Genres are a short controlled list and
   rank cleanly; tags are the opposite — a long, self-invented vocabulary where
   more than half the entries appear exactly once. Ranked, that reads as a
   twelve-row chart with ninety-nine rows of tail cut off it. A cloud shows the
   whole vocabulary at once and lets size carry the count, which is the actual
   shape of this column.

   Drawn in two tones once the wishlist loads: what is on the shelf in ink, what
   is only wanted in teal. One cloud rather than two, because the interesting
   thing is not either list on its own — it is where they overlap and where they
   don't. Two clouds side by side put "shoegaze" in both and left you comparing
   two alphabets by eye; in one cloud a teal word is a corner of the vocabulary
   you have been circling and own nothing of, which is the fact worth having.

   One scale across both, so the two lists are sized against each other and a
   wanted tag reads at the weight it has actually earned. A word's size is the
   count printed next to it and nothing else: the shelf count for a shelf tag
   (the wishlist's extras ride along as a small "+2", not as size — this is
   still the page that counts the collection), and the wishlist count for a tag
   the shelf doesn't have. Tone, count and aria-label each say which list a word
   came from, so nothing here depends on telling teal from ink.
   ---------------------------------------------------------- */

function renderTags(discs, wants) {
  // Set per disc: a row that lists the same tag twice ("punk, punk") is a typo
  // in the sheet, not two releases' worth of evidence for it.
  const owned = rank(discs.flatMap((d) => [...new Set(d.tags)]));
  const wanted = rank(wants.flatMap((d) => [...new Set(d.tags)]));
  if (!owned.length && !wanted.length) { dom.tagPanel.hidden = true; return; }

  const wantedBy = new Map(wanted.map((e) => [e.name, e.count]));
  const entries = owned.map((e) => ({ ...e, wanted: wantedBy.get(e.name) || 0 }));

  // Wishlist-only tags join the cloud at their own count. Everything already on
  // the shelf is in `entries` above, so this is exactly the tail that would
  // otherwise be invisible here — the whole point of drawing the two together.
  const ownedNames = new Set(owned.map((e) => e.name));
  for (const e of wanted) {
    if (!ownedNames.has(e.name)) entries.push({ name: e.name, count: e.count, wanted: e.count });
  }

  // The scale runs over every word actually drawn, so the two lists are sized
  // against each other rather than each against itself.
  const counts = entries.map((e) => e.count);
  const max = Math.max(...counts);
  const min = Math.min(...counts);

  // Display order is A–Z, not by count. In a cloud the size is what says which
  // tags are big, so sorting by size too spends the alphabet on nothing —
  // where you'd go looking for a particular tag is under its letter.
  entries.sort((a, b) => a.name.localeCompare(b.name));
  dom.tags.replaceChildren(...entries.map((entry) => tagCloudItem(entry, min, max, ownedNames)));

  // The legend, written only when there is something to legend. With no
  // wishlist loaded (offline, or the tab unpublished) the cloud is exactly what
  // it was before and the note stays as stats.html wrote it — a key to a color
  // that isn't on screen is worse than no key.
  const only = entries.filter((e) => !ownedNames.has(e.name)).length;
  if (only) {
    dom.tagNote.append(` ${only} ${only === 1 ? 'tag is' : 'tags are'} on the wishlist `
      + 'only, in teal — nothing on the shelf carries them yet.');
  }
}

/**
 * One word in the cloud: a link to the list it lives on with that tag pressed,
 * sized by how many releases carry it, with the count printed small beside it.
 */
function tagCloudItem({ name, count, wanted }, min, max, ownedNames) {
  const item = el('a', 'tag-cloud-item');

  // A tag nothing on the shelf carries would land on an empty grid, so it goes
  // where its releases actually are. Everything else keeps pointing at the
  // shelf even when the wishlist also has it: the shelf is the bigger answer,
  // and the superscript says the other half is there.
  const onShelf = ownedNames.has(name);
  const query = `tag=${encodeURIComponent(name)}`;
  item.href = onShelf ? gridUrl(query) : wishlistUrl(query);
  if (!onShelf) item.classList.add('is-wanted');
  else if (wanted) item.classList.add('is-also-wanted');

  // Square-rooted rather than linear. Type size is read as area, so a linear
  // map makes the top tag look several times heavier than it is and squashes
  // everything below the median into the floor — with a distribution this
  // lopsided (one tag at 43, most at 1) that's nearly the whole cloud.
  // When every tag is equally common there's no scale to draw, so sit them all
  // in the middle rather than at the floor.
  const t = max > min
    ? (Math.sqrt(count) - Math.sqrt(min)) / (Math.sqrt(max) - Math.sqrt(min))
    : 0.5;
  item.style.fontSize = `${(TAG_SIZE_MIN + t * (TAG_SIZE_MAX - TAG_SIZE_MIN)).toFixed(3)}rem`;

  // Ink weight tracks type size, so the three tiers are legible in a printout
  // or a screenshot where the sizes have nothing to be compared against. Both
  // colors are the text-safe tokens — see the palette note in styles.css.
  // Not on a wanted word: its color is already carrying which list it is on,
  // and a second meaning stacked on the same channel makes both unreadable.
  if (!onShelf) { /* teal, and that is the whole of it */ }
  else if (t > 0.6) item.classList.add('is-heavy');
  else if (t < 0.2) item.classList.add('is-light');

  // The count is on screen, but it reads as a bare number appended to the tag
  // ("ambient 20"). Label the link with the whole sentence instead; it still
  // starts with the visible name, so a voice command for the tag still hits it.
  item.setAttribute('aria-label', tagLabel(name, count, wanted, onShelf));
  item.append(name, el('span', 'tag-cloud-count', String(count)));
  if (onShelf && wanted) {
    // "+2" after the shelf count. Marked aria-hidden because the label above
    // already says it in words — read out, "43 +2" is a sum, not two counts.
    const also = el('span', 'tag-cloud-wanted', `+${wanted}`);
    also.setAttribute('aria-hidden', 'true');
    item.append(also);
  }
  return item;
}

function tagLabel(name, count, wanted, onShelf) {
  const releases = (n) => `${n} ${n === 1 ? 'release' : 'releases'}`;
  if (!onShelf) return `${name}, wishlist only, ${releases(count)}`;
  return wanted
    ? `${name}, ${releases(count)} on the shelf, ${wanted} more on the wishlist`
    : `${name}, ${releases(count)}`;
}


/* ----------------------------------------------------------
   By artist
   ---------------------------------------------------------- */

function renderArtists(discs) {
  const ranked = rank(discs.map((d) => d.artist)).slice(0, TOP_ARTISTS);
  if (!ranked.length) return;
  const max = ranked[0].count;

  dom.artists.replaceChildren(...ranked.map((entry, i) =>
    barRow({
      label: entry.name,
      count: entry.count,
      max,
      color: BAR_COLORS[i % BAR_COLORS.length],
      // The grid has no artist filter, but search matches the artist field,
      // and a quoted-exact name is close enough to one.
      href: gridUrl(`q=${encodeURIComponent(entry.name)}`),
    })
  ));
}


/* ----------------------------------------------------------
   Chart primitives
   ---------------------------------------------------------- */

/**
 * One labelled bar. Returns an <a> when `href` is given so the row is a real
 * link — keyboard-reachable and openable in a new tab — and a plain <div>
 * otherwise, rather than a div pretending to be a link.
 */
function barRow({ label, count, max, color, href }) {
  const row = document.createElement(href ? 'a' : 'div');
  row.className = `bar-row${href ? ' is-link' : ''}`;
  if (href) row.href = href;

  const name = el('span', 'bar-label', label);

  const track = el('span', 'bar-track');
  const fill = el('span', 'bar-fill');
  // Scale against the largest bar, not the total: this is a comparison
  // between rows, and percentages-of-total would render most of them as
  // slivers. A zero stays visibly zero.
  fill.style.width = max > 0 ? `${(count / max) * 100}%` : '0';
  if (color) fill.style.background = `var(${color})`;
  track.append(fill);

  const value = el('span', 'bar-value', String(count));

  row.append(name, track, value);
  return row;
}

/**
 * A link back to the grid with one filter applied, carrying ?sample along if
 * that's what these numbers were counted from — otherwise a chart of the
 * sample data would send you to the real collection.
 */
function gridUrl(query) {
  return `index.html?${usingSample() ? 'sample&' : ''}${query}`;
}

/** The same, pointed at the wishlist. Its page reads the same query params. */
function wishlistUrl(query) {
  return `wishlist.html?${usingSample() ? 'sample&' : ''}${query}`;
}

/** Count occurrences of each string, heaviest first, ties broken A–Z. */
function rank(values) {
  const counts = new Map();
  for (const value of values) {
    if (!value) continue;
    counts.set(value, (counts.get(value) || 0) + 1);
  }
  return [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}
