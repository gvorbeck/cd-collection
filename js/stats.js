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

import { el, load, usingSample, registerServiceWorker } from './collection.js';

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

  dom.figures  = document.getElementById('figures');
  dom.decades  = document.getElementById('chart-decades');
  dom.genres   = document.getElementById('chart-genres');
  dom.artists  = document.getElementById('chart-artists');
  dom.stateMsg = document.getElementById('state-msg');

  try {
    const discs = await load();
    if (discs.length === 0) {
      dom.stateMsg.textContent = 'The collection is empty right now.';
      return;
    }
    render(discs);
    dom.stateMsg.hidden = true;
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
