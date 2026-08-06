/* ============================================================
   labels.js — the printable label generator
   ------------------------------------------------------------
   Loaded as a classic <script> after collection.js (for escapeHtml)
   and musicbrainz.js (for the auto-fill lookup). No build step.

   This page is the odd one out in the site: it doesn't read the
   sheet at all. Labels are typed in by hand, kept in localStorage,
   and exist only to be printed. Everything here is either editing
   that list or turning it into a print sheet.
   ============================================================ */

(function () {
  const { escapeHtml } = Collection;

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
      return;
    }
    // Nothing but .label elements here: the print rules page-break on
    // `.label:nth-child(2n)`, which counts every child of this container.
    dom.previewArea.innerHTML = labels.map(buildLabelHtml).join('');
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
     release scoring both live in musicbrainz.js, shared with app.js.
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
      const query = `artist:"${MB.escapeLucene(artist)}" AND release:"${MB.escapeLucene(title)}"`;
      const search = await MB.wsFetch('/release', { query, limit: '25' });

      const best = MB.pickBestRelease(search.releases, wantYear);
      if (!best) {
        setFillStatus('No match found. Try tweaking the artist or title.');
        return;
      }

      const release = await MB.wsFetch(`/release/${best.id}`, { inc: 'recordings' });
      const tracks = MB.flattenTracks(release);

      if (tracks.length === 0) {
        setFillStatus('Found a release but no track list was available.');
        return;
      }

      dom.tracks.value = tracks
        .map(({ title: name, length }) => {
          const dur = MB.formatDuration(length);
          return dur ? `${name} ${dur}` : name;
        })
        .join('\n');

      const yr = MB.releaseYear(release);
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

  Collection.registerServiceWorker();

  render();
})();
