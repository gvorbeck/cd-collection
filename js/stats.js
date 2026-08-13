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

import {
  el, load, loadedFrom, noteDataSource, DATA_SOURCES, usingSample, registerServiceWorker,
} from './collection.js';

// How many rows each ranked chart shows before it stops being a chart and
// starts being a list.
const TOP_GENRES = 12;
const TOP_ARTISTS = 15;

// Bar colors, cycled in order. Same five accents the rest of the site uses.
const BAR_COLORS = ['--brick', '--mustard', '--teal', '--orange', '--forest'];

const dom = {};

document.addEventListener('DOMContentLoaded', init);

async function init() {
  registerServiceWorker();
  listenForStaleSheet();

  dom.figures     = document.getElementById('figures');
  dom.decades     = document.getElementById('chart-decades');
  dom.genres      = document.getElementById('chart-genres');
  dom.artists     = document.getElementById('chart-artists');
  dom.stateMsg    = document.getElementById('state-msg');
  dom.staleNotice = document.getElementById('stale-notice');

  try {
    const discs = await load();

    // Fold the worker's answer in now that load() has made its own — see the
    // note on staleSheetReport for why it can't be applied any earlier.
    if (staleSheetReport && loadedFrom() === DATA_SOURCES.SHEET) {
      noteDataSource(DATA_SOURCES.CACHE);
    }

    if (discs.length === 0) {
      dom.stateMsg.textContent = 'The collection is empty right now.';
      return;
    }
    render(discs);
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

function render(discs) {
  renderFigures(discs);
  renderDecades(discs);
  renderGenres(discs);
  renderArtists(discs);
}


/* ----------------------------------------------------------
   Where these numbers came from
   ----------------------------------------------------------
   A deliberate duplicate of the same four functions in app.js. Two of them —
   listenForStaleSheet and savedOn — are meant to be the same code, and any
   difference in them is drift to be reconciled. The other two are not:

     dataSourceNotice   one word apart. This page *counted* from the saved copy
                        where the grid page is *showing* it, because that is
                        what each page did with the rows. That verb is the only
                        licensed difference in that string.
     refreshDataNotice  a different function on each page, not the same one
                        twice. The grid has a dedicated #live-region and hands
                        the notice back so init() can fold it into a single
                        announcement; here the notice element is itself the live
                        region, so this writes to it, times the write so it
                        registers as a change, and returns nothing.
   The honest home for them is collection.js, alongside DATA_SOURCES:
   these two pages sit one nav hop apart and must not be able to describe the
   same fallback differently. But that file is the shared data layer and this is
   a line of page copy, so the copies stay in step by hand until there's another
   reason to open it — and if you edit one of them, edit the other.
   ---------------------------------------------------------- */

// What the service worker said about the sheet request, or null if it said
// nothing. Held rather than acted on: the message lands while load() is still
// fetching, and load() records its own source when the parse resolves, so
// anything applied before then is overwritten a moment later.
let staleSheetReport = null;

/**
 * Start listening for the worker's word that it answered the sheet request out
 * of its own cache. A cached CSV is byte-identical to a live one from this
 * side, so this message is the only way to find out (see sw.js). Called before
 * load(), because it arrives during load()'s own fetch rather than after it.
 */
function listenForStaleSheet() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.addEventListener('message', (event) => {
    const data = event.data;
    if (!data || data.type !== 'sheet-stale') return;
    // cachedAt is an ISO string stamped when the copy was stored, or null from
    // a worker old enough to predate the stamp. Both are usable answers.
    staleSheetReport = { cachedAt: typeof data.cachedAt === 'string' ? data.cachedAt : null };
  });

  // A ServiceWorkerContainer's message queue starts disabled and is only
  // enabled by onmessage, startMessages(), or the window's load event. We used
  // addEventListener and we run from DOMContentLoaded, which is earlier than
  // load — so without this the worker's message can still be sitting in the
  // queue when init() reads staleSheetReport, and the notice reports the wrong
  // source. No-op if the queue is already going.
  navigator.serviceWorker.startMessages();
}

/**
 * The line to show when these counts weren't taken from the live sheet. Two of
 * the four DATA_SOURCES need no line — `sheet` is the ordinary answer and
 * `sample` was asked for on purpose — and the other two are different copies,
 * worded as different copies. Neither says the *sheet* is out of date: Google's
 * published CSV can trail the spreadsheet on its own and nothing here can see
 * that. All we honestly know is which copy we counted.
 */
function dataSourceNotice() {
  const source = loadedFrom();
  if (source !== DATA_SOURCES.CACHE && source !== DATA_SOURCES.SNAPSHOT) return '';
  const copy = source === DATA_SOURCES.CACHE
    ? `the copy saved on this device${savedOn()}`
    : 'the copy published with the site';
  // Only offer the retry when there's a connection to make it over. Offline
  // it's advice to reload straight back into the same fallback.
  const retry = navigator.onLine === false ? '' : ' Reload to try again.';
  return `Could not reach the sheet — counted from ${copy}.${retry}`;
}

// " (12 Aug 2026)" for a stamped cache entry, "" for one written before sw.js
// started stamping them. The notice stands either way; the date is what makes
// it possible to judge.
function savedOn() {
  const at = staleSheetReport && staleSheetReport.cachedAt
    ? new Date(staleSheetReport.cachedAt)
    : null;
  if (!at || Number.isNaN(at.getTime())) return '';
  return ` (${at.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })})`;
}

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
  const notice = dataSourceNotice();
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
