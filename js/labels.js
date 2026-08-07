/* ============================================================
   labels.js — the printable label generator
   ------------------------------------------------------------
   This page is the odd one out in the site: it doesn't read the
   sheet at all. Labels are typed in by hand, kept in localStorage,
   and exist only to be printed. Everything here is either editing
   that list or turning it into a print sheet.
   ============================================================ */

import { escapeHtml, registerServiceWorker } from './collection.js';
import { takeLabelDraft } from './labelDraft.js';
import {
  escapeLucene,
  wsFetch,
  pickBestRelease,
  flattenTracks,
  formatDuration,
  releaseYear,
} from './musicbrainz.js';

const STORAGE_KEY = 'cdLabels';

// Two labels fit on a letter page; the count readout says how many sheets
// that comes to, so you know what you're feeding the printer.
const LABELS_PER_PAGE = 2;

/* ----------------------------------------------------------
   State
   ---------------------------------------------------------- */

let labels = readLabels();

// Index of the label currently loaded into the form, or null when the form
// is composing a new one. Drives both the Add/Save button text and which
// stack row is highlighted.
let editingIndex = null;

/**
 * Labels survive a bad write better than they survive a bad read: a corrupt
 * or hand-edited value would otherwise throw before the page renders at all,
 * leaving a blank screen and no way to clear it. An unreadable list is
 * treated as an empty one.
 */
function readLabels() {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed;
  } catch {
    return [];
  }
}

function saveLabels() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(labels));
  } catch (err) {
    // Quota or a private-window restriction. The sheet on screen is still
    // printable, so say what was lost rather than throwing it away.
    setFillStatus(`Couldn't save to this browser: ${err.message}`);
  }
}

/* ----------------------------------------------------------
   DOM
   ---------------------------------------------------------- */

const $ = (id) => document.getElementById(id);

const dom = {
  artist: $('artist'),
  title: $('title'),
  year: $('year'),
  tracks: $('tracks'),
  fillBtn: $('fillBtn'),
  fillStatus: $('fillStatus'),
  addBtn: $('addBtn'),
  clearFormBtn: $('clearFormBtn'),
  printBtn: $('printBtn'),
  clearAllBtn: $('clearAllBtn'),
  sheetCount: $('sheetCount'),
  sheetWarning: $('sheetWarning'),
  stackList: $('stackList'),
  stackHint: $('stackHint'),
  previewArea: $('previewArea'),
};

/* ----------------------------------------------------------
   Editing
   ---------------------------------------------------------- */

// The form's four fields as a label object. Tracks are one per line, with
// blank lines dropped so a trailing newline doesn't become an empty track.
function readForm() {
  return {
    artist: dom.artist.value.trim(),
    title: dom.title.value.trim(),
    year: dom.year.value.trim(),
    tracks: dom.tracks.value
      .split('\n')
      .map((t) => t.trim())
      .filter((t) => t.length > 0),
  };
}

function addLabel() {
  const entry = readForm();

  // A label with neither an artist nor a title is a blank card. Year and
  // tracks alone aren't enough to identify one.
  if (!entry.artist && !entry.title) {
    setFillStatus('Enter an artist or a title first.');
    return;
  }

  if (editingIndex !== null) {
    labels[editingIndex] = entry;
  } else {
    labels.push(entry);
  }

  saveLabels();
  clearForm();   // also resets editingIndex and re-renders
}

function loadForEdit(index) {
  const l = labels[index];
  if (!l) return;

  dom.artist.value = l.artist || '';
  dom.title.value = l.title || '';
  dom.year.value = l.year || '';
  dom.tracks.value = (l.tracks || []).join('\n');

  editingIndex = index;
  dom.addBtn.textContent = 'Save changes';
  setFillStatus('');
  render();
  dom.artist.focus();
}

function clearForm() {
  dom.artist.value = '';
  dom.title.value = '';
  dom.year.value = '';
  dom.tracks.value = '';
  editingIndex = null;
  dom.addBtn.textContent = 'Add to print sheet';
  setFillStatus('');
  render();
}

function removeLabel(index) {
  labels.splice(index, 1);

  // The form was editing something; keep it pointed at the same entry.
  // Removing that entry drops the form back to composing a new one, and
  // removing anything above it shifts the target down by one — without this
  // the form would silently start overwriting its neighbour on save.
  if (editingIndex === index) {
    clearForm();
    saveLabels();
    return;
  }
  if (editingIndex !== null && index < editingIndex) editingIndex -= 1;

  saveLabels();
  render();
}

function clearAll() {
  if (labels.length === 0) return;
  labels = [];
  saveLabels();
  clearForm();
}

/* ----------------------------------------------------------
   Rendering
   ---------------------------------------------------------- */

function render() {
  renderCount();
  renderStack();
  renderPreview();
}

function renderCount() {
  const count = labels.length;
  const pages = Math.ceil(count / LABELS_PER_PAGE);
  dom.sheetCount.textContent = count === 0
    ? ''
    : `${count} label${count === 1 ? '' : 's'} · ${pages} print page${pages === 1 ? '' : 's'}`;
}

function renderStack() {
  dom.stackList.textContent = '';
  dom.stackHint.hidden = labels.length === 0;

  labels.forEach((l, i) => {
    const item = document.createElement('li');
    item.className = 'stack-item' + (editingIndex === i ? ' is-editing' : '');

    const name = document.createElement('button');
    name.type = 'button';
    name.className = 'stack-name';
    name.textContent = describe(l);
    // The row's highlight says which entry is loaded; aria-pressed is what
    // says it to a screen reader.
    name.setAttribute('aria-pressed', String(editingIndex === i));
    name.addEventListener('click', () => loadForEdit(i));

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'stack-remove';
    remove.textContent = 'Remove';
    // "Remove" alone is ambiguous once there are a dozen of these.
    remove.setAttribute('aria-label', `Remove ${describe(l)}`);
    remove.addEventListener('click', () => removeLabel(i));

    item.append(name, remove);
    dom.stackList.appendChild(item);
  });
}

// How a saved label reads in the stack list. Either field can be blank —
// the em dash only earns its place when both sides are there.
function describe(l) {
  const artist = l.artist || '';
  const title = l.title || '';
  if (artist && title) return `${artist} — ${title}`;
  return artist || title || 'Untitled';
}

function renderPreview() {
  if (labels.length === 0) {
    dom.previewArea.innerHTML =
      '<div class="empty-state no-print">No labels yet. Fill out the form and add one to the print sheet.</div>';
    setOverflowWarning([]);
    return;
  }
  // Nothing but .label elements here: the print rules page-break on
  // `.label:nth-child(2n)`, which counts every child of this container.
  dom.previewArea.innerHTML = labels.map(buildLabelHtml).join('');

  // Every label gets fitted; the ones that can't be are collected so the form
  // can name them.
  const trimmed = [];
  dom.previewArea.querySelectorAll('.label').forEach((el, i) => {
    const dropped = fitTracks(el);
    if (dropped > 0) trimmed.push({ label: labels[i], dropped });
  });
  setOverflowWarning(trimmed);
}

/* ----------------------------------------------------------
   Fitting the tracklist to the card
   ------------------------------------------------------------
   The label is a fixed physical object — 120mm square, because that's the
   jewel case — so a long tracklist can't be answered by giving it more room.
   The only variable left is the type, and CSS alone can't set it: how tall a
   list runs depends on how many of its titles wrap, which nothing but layout
   knows. So the density steps live in labels.css and the choice between them
   is made here, by measuring.
   ---------------------------------------------------------- */

/**
 * The order the card gives up room in, as [header step, tracklist step] against
 * the two ladders in labels.css.
 *
 * The whole sequence is one idea: SPEND THE HEADER FIRST. The artist and title
 * are display type, read at a glance from across the room, and a glance barely
 * notices 30px becoming 19px. The tracklist is read up close, one line at a
 * time, and shrinking it past legibility doesn't preserve the information — it
 * just leaves a grey smudge where the information used to be. So all three
 * header steps are spent before the tracks give up a single point, and even
 * then the title stays roughly twice the size of a track title.
 *
 * Header steps aren't revisited once the tracks start shrinking: there are only
 * three of them and by then they're all spent.
 */
const FIT_STEPS = [
  [0, 0],  // untouched — where nearly every disc lands
  [1, 0],  // header gives, tracks still at full size
  [2, 0],
  [3, 0],  // header at its floor
  [3, 1],  // only now does the tracklist tighten
  [3, 2],
  [3, 3],
  [3, 4],
  [3, 5],
  [3, 6],  // 7.25px, the legibility floor — see labels.css
];

/**
 * Walks the steps and stops at the first one where the tracklist ends inside
 * the card. Returns the number of tracks that had to be dropped to make it fit
 * — 0 for every disc that fits, which is nearly all of them.
 *
 * Reading a rect between writes forces a synchronous layout each time round,
 * which is the cost of measuring at all. It's a handful of small boxes, and it
 * only happens when the sheet changes.
 */
function fitTracks(label) {
  const tracks = label.querySelector('.label-tracks');
  if (!tracks) return 0;

  // Where the card's content box ends. The tracklist is the last thing in the
  // label and doesn't shrink on its own, so any part of it below this line is
  // the amount by which the current step fails.
  const style = getComputedStyle(label);
  const floor = label.getBoundingClientRect().bottom
    - parseFloat(style.borderBottomWidth)
    - parseFloat(style.paddingBottom);

  // Half a pixel of slack throughout: sub-pixel rounding in a box measured in
  // fractional inches shouldn't cost a whole step of type size.
  const fits = () => tracks.getBoundingClientRect().bottom <= floor + 0.5;

  for (const [head, density] of FIT_STEPS) {
    label.dataset.head = String(head);
    label.dataset.density = String(density);
    if (fits()) {
      relaxHeader(label, fits);
      return 0;
    }
  }

  return truncateToFit(label, tracks, fits);
}

/**
 * Gives the header back whatever the tracklist didn't need.
 *
 * The steps are coarse — one of them is 8.25px to 7.5px — so the step that
 * finally fits usually clears the bottom edge by more than it had to, and the
 * header was charged for all of it. Left alone that reads as the worst of both
 * worlds: a title cut to 19px AND a band of empty card above the tracks, the
 * shrink having bought nothing you can see.
 *
 * So the header walks back up. The tracklist keeps the size it won — this runs
 * with the density fixed, and never trades a point of track size for a bigger
 * title — and the leftover room goes back into the display type instead of
 * staying as a gap.
 */
function relaxHeader(label, fits) {
  const spent = Number(label.dataset.head);
  for (let head = 0; head < spent; head += 1) {
    label.dataset.head = String(head);
    if (fits()) return;
  }
  // Every larger header overflows, so the step that got us here was the price.
  label.dataset.head = String(spent);
}

/**
 * The end of the road: a shrunk header plus three columns at the smallest type
 * still worth printing is a hard ceiling, and some discs are past it. Left
 * alone the card would still print every track — it would just print them
 * clipped, and because the columns balance to equal height, the clip takes the
 * bottom off ALL THREE of them. The card would be missing tracks 18-22 and
 * 40-44 as well as the tail, with nothing to say so.
 *
 * So the list is cut deliberately instead: drop from the end until what's left
 * fits, and give the last row over to a count of what didn't. The card then
 * says something true — these are the first N tracks — rather than looking
 * complete and being wrong.
 */
function truncateToFit(label, tracks, fits) {
  const marker = document.createElement('div');
  marker.className = 'track-more';
  tracks.appendChild(marker);

  let dropped = 0;
  // Everything but the marker itself.
  const remaining = () => tracks.children.length - 1;

  while (remaining() > 0) {
    dropped += 1;
    marker.textContent = `+${dropped} more`;
    tracks.children[remaining() - 1].remove();
    if (fits()) return dropped;
  }

  // Not even one track fits, so the trouble is above the tracklist rather than
  // in it — an artist and title long enough to fill the card on their own. A
  // count of what was dropped has nothing useful to say about that.
  marker.remove();
  return dropped;
}

function setOverflowWarning(trimmed) {
  dom.sheetWarning.hidden = trimmed.length === 0;
  if (trimmed.length === 0) {
    dom.sheetWarning.textContent = '';
    return;
  }

  if (trimmed.length === 1) {
    const { label, dropped } = trimmed[0];
    const kept = (label.tracks || []).length - dropped;
    dom.sheetWarning.textContent = kept > 0
      ? `“${describe(label)}” has more tracks than a jewel-case card can hold. `
        + `It prints the first ${kept} and a count of the ${dropped} it drops.`
      : `“${describe(label)}” has an artist and title long enough to fill the card `
        + `on their own, so none of its ${dropped} tracks print. Shorten one of them.`;
    return;
  }

  const total = trimmed.reduce((sum, t) => sum + t.dropped, 0);
  dom.sheetWarning.textContent =
    `${trimmed.length} labels have more tracks than a jewel-case card can hold. `
    + `They print as many as fit, dropping ${total} tracks between them.`;
}

/**
 * The printed artifact. Built as an HTML string, with every interpolated
 * value escaped — this is the one place on the page that writes markup from
 * user input.
 *
 * Frozen: the markup and its classes are measured against a real jewel-case
 * insert in labels.css. Changing the structure here changes what prints.
 */
function buildLabelHtml(l) {
  let tracksHtml = '';
  if (l.tracks && l.tracks.length > 0) {
    tracksHtml = '<div class="label-tracks">' +
      l.tracks.map((t, i) => `<div><span class="track-num">${i + 1}.</span><span>${escapeHtml(t)}</span></div>`).join('') +
      '</div>';
  }

  return `
    <div class="label">
      <div class="label-category">Compact Disc</div>
      <div class="label-main">
        <div class="label-artist">${escapeHtml(l.artist) || 'ARTIST'}</div>
        <div class="label-title">${escapeHtml(l.title) || 'TITLE'}</div>
        <div class="label-year">${escapeHtml(l.year)}</div>
      </div>
      ${tracksHtml}
    </div>
  `;
}

/* ----------------------------------------------------------
   Auto-fill from MusicBrainz
   ------------------------------------------------------------
   Key-free and CORS-friendly, the same service the collection page uses for
   cover art. Two calls: search for the best-matching release, then fetch it
   with recordings to get titles and lengths. The 1/sec rate limit and the
   release scoring both live in musicbrainz.js, shared with the grid page.
   ---------------------------------------------------------- */

function setFillStatus(msg) {
  dom.fillStatus.textContent = msg || '';
}

async function autoFillTracks() {
  const artist = dom.artist.value.trim();
  const title = dom.title.value.trim();
  const wantYear = parseInt(dom.year.value.trim(), 10) || null;

  if (!artist || !title) {
    setFillStatus('Enter both an artist and a title first.');
    return;
  }

  dom.fillBtn.disabled = true;
  setFillStatus('Looking up…');

  try {
    const query = `artist:"${escapeLucene(artist)}" AND release:"${escapeLucene(title)}"`;
    const search = await wsFetch('/release', { query, limit: '25' });

    const best = pickBestRelease(search.releases, wantYear);
    if (!best) {
      setFillStatus('No match found. Try tweaking the artist or title.');
      return;
    }

    const release = await wsFetch(`/release/${best.id}`, { inc: 'recordings' });
    const tracks = flattenTracks(release);

    if (tracks.length === 0) {
      setFillStatus('Found a release but no track list was available.');
      return;
    }

    dom.tracks.value = tracks
      .map(({ title: name, length }) => {
        const dur = formatDuration(length);
        return dur ? `${name} ${dur}` : name;
      })
      .join('\n');

    const yr = releaseYear(release);
    setFillStatus(`Filled ${tracks.length} tracks${yr ? ` from the ${yr} release` : ''}. Edit as needed.`);
  } catch (err) {
    setFillStatus(`Lookup failed: ${err.message}. Check your connection and try again.`);
  } finally {
    dom.fillBtn.disabled = false;
  }
}

/* ----------------------------------------------------------
   Wiring
   ---------------------------------------------------------- */

dom.addBtn.addEventListener('click', addLabel);
dom.clearFormBtn.addEventListener('click', clearForm);
dom.fillBtn.addEventListener('click', autoFillTracks);
dom.printBtn.addEventListener('click', () => window.print());
dom.clearAllBtn.addEventListener('click', clearAll);

// Enter anywhere in the single-line fields commits the label, the way it
// would in a real form. The textarea is exempt — Enter is a new track there.
[dom.artist, dom.title, dom.year].forEach((input) => {
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      addLabel();
    }
  });
});

registerServiceWorker();

render();

/* ----------------------------------------------------------
   Arriving from the collection page
   ---------------------------------------------------------- */

/**
 * A disc sent over by "Make label" in the collection's detail dialog.
 * It fills the form and stops there: adding it to the print sheet is still a
 * deliberate press of the button, since the point of the handoff is to get a
 * head start on the typing, not to skip the read-through.
 *
 * Runs after the first render(), which resets the status line.
 */
function applyIncomingDraft() {
  const draft = takeLabelDraft();
  if (!draft) return;

  dom.artist.value = draft.artist;
  dom.title.value = draft.title;
  dom.year.value = draft.year;
  dom.tracks.value = draft.tracks.join('\n');

  // Land on the first field rather than wherever the browser puts focus after
  // a navigation, so the form is immediately editable from the keyboard.
  dom.artist.focus();

  // editingIndex stays null, so the button still reads "Add to print sheet" —
  // this is a new label, not one of the saved ones loaded back for editing.
  const message = draft.tracks.length
    ? `Filled in from the collection (${draft.tracks.length} tracks). Check it over, then add it to the print sheet.`
    : 'Filled in from the collection. No tracks came across — auto-fill or type them in, then add it to the print sheet.';

  // #fillStatus is a live region, and a live region only announces changes it
  // sees AFTER assistive tech has registered it — text written this early in
  // page load is read as the region's initial content and goes unspoken. That
  // matters more than usual here: focus has just jumped into a form the user
  // didn't navigate to, and this sentence is the only thing that explains why.
  // A short delay makes it a change rather than a starting value.
  //
  // A timer rather than requestAnimationFrame: rAF is tied to painting and
  // doesn't run while the document is hidden, which would hang the one piece of
  // feedback this screen owes the user on whether the tab happens to be drawing.
  setTimeout(() => setFillStatus(message), 120);
}

applyIncomingDraft();
