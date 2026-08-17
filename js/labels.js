/* ============================================================
   labels.js — the printable label generator
   ------------------------------------------------------------
   This page is the odd one out in the site: it doesn't read the
   sheet at all. Labels are typed in by hand, kept in localStorage,
   and exist only to be printed. Everything here is either editing
   that list or turning it into a print sheet.
   ============================================================ */

// Side effect only, and first: installs the global error handlers as it
// evaluates. This page builds its whole `dom` object at module scope (below),
// outside any try, so a renamed id throws before a single line of init() runs —
// there is no other net under it. See errors.js.
import './errors.js';
import { escapeHtml, registerServiceWorker } from './collection.js';
import { coerceLabel, takeLabelDraft } from './labelDraft.js';
import { hideWithoutLosingFocus } from './util.js';
import {
  findReleaseGroup,
  tracksForRelease,
  tracksForReleaseGroup,
  escapeLucene,
  wsFetch,
  pickBestRelease,
  formatDuration,
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

// The stack that was thrown away wholesale, held so it can be handed back.
// Null when there's nothing on offer. See offerUndo below for why this is an
// undo rather than a confirm().
let undoLabels = null;
let undoTimer = 0;

// How long "Undo" stays on offer. Long enough to read what just happened and
// reach for it, short enough that it isn't still sitting there twenty minutes
// later offering to restore something you've since forgotten clearing.
const UNDO_WINDOW_MS = 30000;

// "1 label" / "3 labels", which the export and both bulk actions have to say.
const plural = (n) => `${n} label${n === 1 ? '' : 's'}`;

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

/**
 * Persist the stack. Returns '' when it landed, or the message to show when it
 * didn't — quota, or a private window that won't take writes. The sheet on
 * screen is still printable either way, so a failure is something to say, not
 * something to throw the stack away over.
 *
 * Returned rather than shown, because this function is always too early to show
 * it. Every caller does something to the status line afterwards: clearForm()
 * blanks it, offerUndo() and the import both write their own line over it. So a
 * message set from in here was wiped a beat later by the same code that saved,
 * and a full quota came out on screen as "Imported 12 labels." — the one
 * outcome the user most needs to know about, reported as a success. Handing the
 * text back makes it the caller's job to say it last, which is the only place it
 * survives.
 */
function saveLabels() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(labels));
    return '';
  } catch (err) {
    return `Couldn't save to this browser: ${err.message}`;
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
  undoBtn: $('undoBtn'),
  addBtn: $('addBtn'),
  clearFormBtn: $('clearFormBtn'),
  printBtn: $('printBtn'),
  clearAllBtn: $('clearAllBtn'),
  exportBtn: $('exportBtn'),
  importBtn: $('importBtn'),
  importFile: $('importFile'),
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

  // A pending Undo restores a whole stack over the top of whatever is there,
  // so anything that adds to the stack in the meantime has to withdraw it —
  // otherwise the label being added right now is what the undo throws away.
  dismissUndo();

  if (editingIndex !== null) {
    labels[editingIndex] = entry;
  } else {
    labels.push(entry);
  }

  const saveErr = saveLabels();
  clearForm();   // also resets editingIndex and re-renders — and blanks the status
  if (saveErr) setFillStatus(saveErr);
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
  // Asked before anything re-renders, because by then the answer is gone: the
  // button that was just pressed is inside the list renderStack() empties.
  const hadFocus = dom.stackList.contains(document.activeElement);

  // Same rule addLabel() follows: a pending Undo restores a whole stack over
  // the top of whatever is there, so anything that changes the stack in the
  // meantime has to withdraw it. Remove one of three freshly-imported labels
  // and then hit Undo, and the offer still standing is the pre-import one —
  // taking it would throw away the whole imported sheet, the two survivors
  // along with the label just removed.
  dismissUndo();

  labels.splice(index, 1);

  const saveErr = saveLabels();

  // The form was editing something; keep it pointed at the same entry.
  // Removing that entry drops the form back to composing a new one, and
  // removing anything above it shifts the target down by one — without this
  // the form would silently start overwriting its neighbour on save.
  if (editingIndex === index) {
    clearForm();
  } else {
    if (editingIndex !== null && index < editingIndex) editingIndex -= 1;
    render();
  }
  // After the re-render either way: clearForm() blanks the status line, so a
  // failure reported before it would never be read.
  if (saveErr) setFillStatus(saveErr);

  if (hadFocus) refocusStack(index);
}

/**
 * Put keyboard focus back on the stack after a row is removed.
 *
 * util.js's hideWithoutLosingFocus solves the same problem for a control that
 * hides itself, and it can't help here: this is a destroy-and-rebuild, not a
 * hide. renderStack() sets dom.stackList.textContent = '', so the Remove button
 * that was pressed no longer exists to move focus off — by the time there is
 * somewhere to put it, focus has already fallen to <body> and the next Tab
 * starts over at the top of the document. So the same idea, done by hand and
 * after the rebuild: the row that slid up into the removed one's place inherits
 * the focus, the row above it when the list ran out (the last row was the one
 * removed), and the Add button when there are no rows left at all.
 */
function refocusStack(index) {
  const buttons = dom.stackList.querySelectorAll('.stack-remove');
  const next = buttons[index] || buttons[index - 1];
  (next || dom.addBtn).focus();
}

function clearAll() {
  if (labels.length === 0) return;
  const previous = labels;
  labels = [];   // a new array, so `previous` still holds the cleared stack
  const saveErr = saveLabels();
  clearForm();   // also resets editingIndex and re-renders
  // The offer stands whether or not the write landed — undoing a clear is a
  // change to what's on screen, which still works — so the save error goes in
  // as its message rather than suppressing it.
  offerUndo(previous, saveErr || `Cleared ${plural(previous.length)}.`);
}

/* ----------------------------------------------------------
   Undoing a bulk change
   ------------------------------------------------------------
   Clear all and Import are the only two things on this page that can destroy
   more than one label at once, and the stack is not in the sheet — there is
   nothing to re-sync it from and no second copy anywhere. Both needed a guard.

   A confirm() on each would have been fewer lines, and it's the wrong guard: a
   dialog that fires every single time is one people learn to dismiss without
   reading, so by the tenth clear it stops protecting anything and only ever
   costs a click. An undo asks nothing of the people who meant it and still
   catches the miss.
   ---------------------------------------------------------- */

/**
 * Put a whole-stack replacement on offer as an Undo, and say what happened.
 *
 * The write to localStorage has already happened by the time this runs, on
 * purpose. Holding it back for the length of the window would leave storage and
 * screen disagreeing, and a tab closed mid-window would then resurrect a stack
 * that was deliberately cleared. So the offer is honestly only good for this
 * page view: a reload inside the window is still final.
 */
function offerUndo(previous, message) {
  undoLabels = previous;
  clearTimeout(undoTimer);
  undoTimer = setTimeout(dismissUndo, UNDO_WINDOW_MS);
  dom.undoBtn.hidden = false;
  setFillStatus(message);
}

// Withdraw the offer: on the timer, once it's been taken, and whenever the
// stack changes underneath it. A no-op when there was nothing on offer, so
// callers don't have to check.
function dismissUndo() {
  if (!undoLabels) return;
  undoLabels = null;
  clearTimeout(undoTimer);
  undoTimer = 0;
  // The button hides itself the moment it's used, which is exactly the case
  // hideWithoutLosingFocus exists for — without it, undoing from the keyboard
  // drops focus to <body>. Clear all is where it goes: the control immediately
  // before it in the row, and the one focus was on when the offer appeared, so
  // the keyboard ends up back where it started rather than somewhere new.
  hideWithoutLosingFocus(dom.undoBtn, dom.clearAllBtn);
}

function takeUndo() {
  if (!undoLabels) return;
  const restored = undoLabels;
  labels = restored;
  dismissUndo();
  const saveErr = saveLabels();
  clearForm();   // the old editingIndex meant nothing once the stack was gone
  setFillStatus(saveErr || `Restored ${plural(restored.length)}.`);
}

/* ----------------------------------------------------------
   Export and import
   ------------------------------------------------------------
   The stack lives in one localStorage key on one machine. It isn't in the
   sheet, it isn't on a server, and "clear site data" takes it with everything
   else — so until now a stack of hand-typed tracklists had no way out of the
   browser it was typed into. These two are that way out: a file you can keep,
   mail to yourself, or carry to the laptop the printer is attached to.
   ---------------------------------------------------------- */

// Stamped on every export. Deliberately not what the import gates on — a bare
// array is accepted too, and refusing one would refuse the easiest way to build
// a stack from a script or by hand. What it's for is the file itself: a loose
// cd-labels-2026-08-12.json found in a downloads folder a year from now should
// say what it is without having to be guessed at.
const EXPORT_TYPE = 'cd-collection-labels';

/**
 * Hand a generated string to the browser as a file download.
 *
 * The same eight lines as downloadFile in js/state.js, which the collection's
 * CSV export uses. Duplicated rather than shared because that one isn't
 * exported, and importing state.js to reach it would pull the disc list, the
 * filters and the renderer onto a page that reads no sheet at all. Worth
 * lifting into util.js the next time either side is touched.
 */
function downloadFile(text, mime, filename) {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Release the blob once the download has been handed off.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function exportLabels() {
  if (labels.length === 0) {
    setFillStatus('Nothing to export — there are no labels saved yet.');
    return;
  }

  const now = new Date();
  // Pretty-printed rather than minified: this is a file a person may well open
  // and edit by hand, and the import below accepts what they'd write.
  const json = JSON.stringify({
    type: EXPORT_TYPE,
    version: 1,
    exported: now.toISOString(),
    labels,
  }, null, 2);

  // Dated, so successive backups sit beside each other instead of overwriting.
  downloadFile(json, 'application/json', `cd-labels-${now.toISOString().slice(0, 10)}.json`);
  setFillStatus(`Exported ${plural(labels.length)}.`);
}

/**
 * A file's text as a list of labels: `{ labels }` when the whole file checks
 * out, `{ error }` — a phrase that completes "Couldn't import x.json: …" — when
 * any part of it doesn't.
 *
 * Nothing is applied until the last entry has passed, and nothing here throws.
 * An import that replaced a stack of typed tracklists with half a file, or with
 * nothing, would be the same unrecoverable click Clear all used to be.
 */
function parseLabelFile(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch (err) {
    return { error: `it isn't JSON (${err.message})` };
  }

  // Both shapes: the wrapper exportLabels writes, and the bare array someone
  // hand-writing or scripting one would reach for first.
  const rows = Array.isArray(data) ? data
    : (data && Array.isArray(data.labels) ? data.labels : null);
  if (!rows) return { error: "there's no list of labels in it" };
  if (rows.length === 0) return { error: "there are no labels in it" };

  const out = [];
  for (let i = 0; i < rows.length; i += 1) {
    const label = coerceLabel(rows[i]);
    // The same test addLabel applies to the form. Without it any array of
    // objects imports "successfully" as that many blank cards — a package.json
    // full of dependencies would come through as a print sheet of ARTIST/TITLE
    // placeholders, having quietly replaced the real stack to do it.
    if (!label || (!label.artist && !label.title)) {
      return { error: `entry ${i + 1} of ${rows.length} isn't a label` };
    }
    out.push(label);
  }
  return { labels: out };
}

async function importLabels(file) {
  if (!file) return;

  let text;
  try {
    text = await file.text();
  } catch (err) {
    setFillStatus(`Couldn't read ${file.name}: ${err.message}`);
    return;
  }

  const result = parseLabelFile(text);
  if (result.error) {
    setFillStatus(`Couldn't import ${file.name}: ${result.error}. Nothing was changed.`);
    return;
  }

  const previous = labels;

  // The same rule addLabel and removeLabel follow, and the one this function
  // was missing: a pending Undo restores a whole stack over the top of whatever
  // is there, so anything that changes the stack has to withdraw it first.
  // Clear all and then an import inside the undo window is the case that bit —
  // `previous` is empty by then, so the branch below never re-armed, the
  // pre-clear offer stayed live, and Undo threw away the sheet just imported.
  // Unconditional because "was the page empty" says nothing about whether an
  // offer is outstanding; a no-op when there isn't one.
  dismissUndo();

  labels = result.labels;
  const saveErr = saveLabels();
  clearForm();   // the incoming indices have nothing to do with the old ones

  // Replacing a stack is destructive in exactly the way Clear all is, so it
  // goes through the same offer. Nothing to offer when the page was empty.
  if (previous.length === 0) {
    setFillStatus(saveErr || `Imported ${plural(labels.length)}.`);
  } else {
    offerUndo(previous, saveErr || `Imported ${plural(labels.length)}, replacing the ${previous.length} that were here.`);
  }
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
   cover art. What's shared with the grid page is the whole lookup, not just its
   plumbing: findReleaseGroup picks the record out of the EP, single and remix
   set that reuse its name, and tracksForReleaseGroup picks a pressing inside
   that group — both in musicbrainz.js, along with the 1/sec rate limit. Getting
   the first of those wrong is what once showed "three tracks for an eleven-track
   record" on the grid page; here the same mistake gets printed on card stock.

   What is NOT shared is the fallback below, and it's this page that needs it.
   Grid titles come out of the sheet; these are typed in by hand, off the back
   of a case or from memory, so a misspelling or a half-remembered subtitle is
   ordinary here. The two searches hit different indexes — one document per
   release group against one per pressing — and the pressing index is the bigger
   and looser of the two, so a title that finds nothing at all as a group can
   still land there. It's the weaker match by definition, and a tracklist to
   correct beats an empty textarea to fill.
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
    // The shared path first, and the one that should answer almost every time.
    const mbid = await findReleaseGroup({ artist, title, year: wantYear });
    let tracks = mbid ? await tracksForReleaseGroup(mbid, wantYear) : null;

    // Fall back on the looser search — see the note above. Also reached when
    // the group was found but held nothing usable (every pressing in it a
    // vinyl-only listing with no recordings attached, say): either way we came
    // back with no tracklist, and the fallback is the remaining thing to try.
    const loose = !tracks;
    if (loose) tracks = await looseReleaseTracks(artist, title, wantYear);

    if (!tracks) {
      setFillStatus('No match found. Try tweaking the artist or title.');
      return;
    }

    dom.tracks.value = tracks
      .map(({ title: name, length }) => {
        const dur = formatDuration(length);
        return dur ? `${name} ${dur}` : name;
      })
      .join('\n');

    // The year the release came out used to be part of this sentence, taken off
    // the release the old search had in hand. The shared lookup returns tracks
    // and nothing else, and a third request purely to print a year in a status
    // line isn't worth another second of the rate limit.
    setFillStatus(loose
      ? `Filled ${tracks.length} tracks from a looser title match — worth checking against the disc.`
      : `Filled ${tracks.length} tracks. Edit as needed.`);
  } catch (err) {
    setFillStatus(`Lookup failed: ${err.message}. Check your connection and try again.`);
  } finally {
    dom.fillBtn.disabled = false;
  }
}

/**
 * The lookup this page used before the release-group one existed, kept as the
 * fallback: search pressings directly and take the best-scoring one.
 *
 * pickBestRelease is still the grid page's, so a pressing is chosen the same way
 * here as anywhere else. What's missing is the step above it — nothing in a
 * /release search separates an album from the same-named single, which is
 * precisely why this is second in line rather than first. Null when the search
 * finds nothing, or finds something MusicBrainz has no tracklist for.
 */
async function looseReleaseTracks(artist, title, wantYear) {
  const query = `artist:"${escapeLucene(artist)}" AND release:"${escapeLucene(title)}"`;
  const search = await wsFetch('/release', { query, limit: '25' });

  const best = pickBestRelease(search.releases, wantYear);
  if (!best) return null;

  // Fetching one known release's tracks is shared with the grid page now — it's
  // what a disc pinned by Barcode does for its whole tracklist.
  return tracksForRelease(best.id);
}

/* ----------------------------------------------------------
   Wiring
   ---------------------------------------------------------- */

dom.addBtn.addEventListener('click', addLabel);
dom.clearFormBtn.addEventListener('click', clearForm);
dom.fillBtn.addEventListener('click', autoFillTracks);
dom.printBtn.addEventListener('click', () => window.print());
dom.clearAllBtn.addEventListener('click', clearAll);
dom.undoBtn.addEventListener('click', takeUndo);
dom.exportBtn.addEventListener('click', exportLabels);

// The <input type="file"> is opened by the button beside it rather than being
// worn on the page: a file input can't be given the site's button styling, and
// its "no file selected" text is furniture that says nothing useful once the
// import has happened.
dom.importBtn.addEventListener('click', () => dom.importFile.click());
dom.importFile.addEventListener('change', () => {
  const file = dom.importFile.files[0];
  // Cleared straight away, and before the read: picking the same file a second
  // time is otherwise no change at all and the event never fires again — which
  // matters most right after a failed import, when re-picking the file you just
  // fixed is the obvious next thing to do.
  dom.importFile.value = '';
  importLabels(file);
});

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
