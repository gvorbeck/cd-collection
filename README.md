# CD Collection

**Live site:** <https://cd.iamgarrett.com>

A browsable archive of my CD collection, shelved by catalog number. It's a
static site — no build step, no framework — that reads its data live from a
published Google Sheet and renders it as a grid of album covers with search,
genre/tag filters, sorting, and a shuffle. It installs as an app and works
with no network.

Four pages. Three read the sheet; the fourth is a print tool that doesn't:

| Page            | What it's for                                                     |
|-----------------|-------------------------------------------------------------------|
| `index.html`    | The collection itself — grid or compact list, search and filters.  |
| `wishlist.html` | Records not on the shelf yet, and a shop check for whether one already is. |
| `stats.html`    | Breakdowns by decade, genre, artist and shelf, and a tag cloud drawn in two tones — shelf and wishlist. |
| `labels.html`   | Printable jewel-case inserts, typed by hand or sent over from a disc, kept in this browser. |

### Also in here: `burncd`, `player` and `bandcamp-wishlist`

None of the three is part of the site. They're the rest of the hobby, in the
order it happens: find the music, burn it to a disc, play the disc.

[`scripts/burncd/`](scripts/burncd/README.md) is a command-line tool for turning
a folder of purchased music into an actual CD-R:

```bash
burncd ~/Music/Nonagon\ Infinity
```

Gapless, CD-Text, track order from tags rather than filenames, splits long sets
across discs. Run `burncd --check` first on the machine with the burner attached.
Full docs: [scripts/burncd/README.md](scripts/burncd/README.md).

[`scripts/player/`](scripts/player/README.md) is burncd's twin — same panel,
same amber, same meters — for playing an album rather than burning one, whether
it's a zip, a folder, or the CD in the drive:

```bash
player ~/Downloads/Nonagon\ Infinity.zip
```

A zip plays without unpacking: it opens into a scratch directory that's deleted
when you quit, so nothing joins a library and nothing is left behind. Run
`player --check` on a new machine. Full docs:
[scripts/player/README.md](scripts/player/README.md).

[`scripts/bandcamp-wishlist/`](scripts/bandcamp-wishlist/README.md) is a
bookmarklet for the buying end. Bandcamp shows a wishlist as a wall of album art
with no prices on it; click the bookmark on that page and it lists every item
with what it costs, cheapest first, plus a CSV. Prices come from Bandcamp's own
endpoints in your logged-in browser, so there's no scraping and no login to
handle. Install and edit instructions:
[scripts/bandcamp-wishlist/README.md](scripts/bandcamp-wishlist/README.md).

## How it works

- **Data** lives in a Google Sheet, published to the web as CSV. The page
  fetches and parses that CSV at load time with [PapaParse]; there is no
  server and no database. It's one spreadsheet with two published tabs — the
  shelf and the wishlist — described by `CONFIG.SOURCES` in `js/collection.js`.
  A page picks its tab with `data-source` on `<body>`, and that attribute is
  very nearly the whole difference between `wishlist.html` and `index.html`;
  see [The wishlist](#the-wishlist).
- **Covers** use the `Art URL` column when present (an explicit URL always
  wins). For discs with a blank `Art URL`, the page looks up cover art
  automatically via [MusicBrainz] → the [Cover Art Archive] — chosen for its
  deep coverage of non-mainstream and obscure releases. Lookups happen only
  when a card scrolls on-screen and are cached in `localStorage`, so usage
  stays well under MusicBrainz's rate limit and no disc is looked up twice.
  Anything still without art falls back to a generated placeholder cover — a
  solid color hashed from the artist name, the title in bold type, and the
  catalog number — drawn on a `<canvas>` and finished with the same paper grain
  as the page, which is what tells a drawn cover from a photographed one at a
  glance. Real art is left alone. A disc whose `Barcode` column is
  filled in skips the search entirely and goes straight to that pressing; see
  [Pinning a release with a barcode](#pinning-a-release-with-a-barcode).
- **Card shadows** are tinted by the dominant color sampled from each cover,
  falling back to a neutral tint when a cover can't be read.
- **Offline** works because a service worker (`sw.js`) precaches the pages,
  styles, and scripts, keeps the last good copy of the sheet, and holds on to
  cover art once it's been fetched. It also precaches `data/collection.csv`, a
  snapshot of the sheet committed to the repo, so a fresh install opened for
  the first time with no signal still has real discs to show. See
  [Offline & installing](#offline--installing).

The sheet URL, column names, and blank-cell fallbacks are in the `CONFIG` block
at the top of `js/collection.js` — the shared data layer every page imports.
The placeholder-cover palette is display-only and stays in `CONFIG` in
`js/config.js`.

## What the site does

### Search

The search box matches across everything a disc has — book, catalog number,
artist, title, year, genre, tags, and notes — and reads what you type as a set
of words rather than as a phrase. Every word has to turn up somewhere on the
record, but not in any particular order and not next to each other, so
`miles kind of blue`, `kind of blue miles` and `1959 miles` all find the same
disc. Accents fold, so `bjork` finds Björk and `andre` finds André Messager.

Double quotes hold words together when the order is the point: `"kind of blue"`
is one term, not three. A quote you haven't closed yet runs to the end of the
query — which is every quoted search halfway through being typed.

The honest cost of matching each word separately is that they can land in
different fields: a disc with one of them in its notes and another in its genre
now matches. That's the trade. A word that turns up anywhere on the record is
usually what someone scanning a shelf meant, and quotes are there for when it
isn't.

### Sharing a view

The current search, genre, tag, sort, and view are kept in the URL, so any
state you can reach is a link you can send:

    index.html?q=coltrane&genre=Jazz&sort=year-desc&view=list

Opening a disc adds `#disc-<artist>-<title>` to the URL, so a specific record
is linkable too. Back closes the dialog instead of leaving the site, and a
link arriving straight at a disc closes cleanly without stranding you.

### Detail view

Opening a card gives you the shelf location, notes, and:

- **Look it up** — search links to Discogs, MusicBrainz, Bandcamp, the iTunes
  Store, and Spotify's web player, built from artist + title. No API keys.
  MusicBrainz gets a direct release-group link once one has been identified.
- **Tracklist** — fetched from MusicBrainz on first open, then cached in
  `localStorage`. A failed lookup isn't cached, so re-opening retries. A track
  credited to somebody other than the disc's own artist names them alongside
  the title, which is what makes a Various Artists compilation readable; an
  album whose tracks are all by the album artist says nothing extra.
- **Make label** — opens the labels page with this release already filled in,
  tracklist and all if one has been fetched. See [Labels](#labels).

### List view and export

The **Grid / List** toggle swaps the covers for dense one-line rows — better
for scanning a few hundred titles, and what prints.

**Export CSV** downloads whatever is currently filtered — not the whole
collection — dated in the filename, and marked `-filtered` when a search or a
pill was on. The file carries every column the sheet has, in the sheet's own
header order (`Art URL` included), so a paste lands column for column instead
of quietly putting Notes under Art URL. Cells are written as the *sheet* has
them rather than as the page shows them: a blank Artist exports blank, not
"Various Artists."

"Spreadsheet-safe" means one specific thing here. A cell someone typed
beginning with `=`, `+`, `-` or `@` is read as a live formula by Excel, Sheets
and LibreOffice alike — no macro warning, no opt-in — so those cells are quoted
with a tab in front of the value, which no spreadsheet will start a formula
with. The tab is a real character and it stays: a note that legitimately opens
with a hyphen ("- see sleeve") comes back from a paste with a tab in front of
it, and re-exporting keeps it. That's the price of an export that can't run
anything, and it's the right way round. There's a UTF-8 BOM on the front too,
so Excel opens accented names as written.

### The wishlist

`wishlist.html` is the other tab of the same spreadsheet: records not on the
shelf yet. Everything described above works there unchanged — the search, the
pills, the sort, the grid and list views, the detail dialog, Export CSV — because
it is the same page. `<body data-source="wishlist">` is what makes it a
different one, and `js/app.js` is the entry point for both.

The two tabs share every column name, so the code that reads one reads the
other. Past the two URLs, three things are allowed to differ per tab, and all
three live together in `CONFIG.SOURCES`:

| Per-tab      | Shelf                   | Wishlist                          |
|--------------|-------------------------|-----------------------------------|
| Blank `Title`| "Self-Titled"           | "Any release" — half the list was jotted down as an artist and nothing more |
| A row is a   | disc                    | record                            |
| Opens sorted | random                  | by artist                         |

The default sort has to be per-tab rather than shared because `js/url.js` leaves
the sort out of a link when it matches the default and puts it back on arrival —
one shared default and the wishlist would write links that reopen in a different
order than they were shared in.

**Ownership marks.** The wishlist loads the shelf alongside itself and checks
every row against it, so a record bought months ago and never crossed off says
so instead of sitting there looking wanted. A match wears **Own it** stamped
across the cover, and the corner that carries the catalog tag on the grid page
carries the shelf position instead — `B2 · #219`, the part of the answer that
stops you buying it twice. A weaker match — the artist is on the shelf but not
this release — says so rather than claiming either: `2 on the shelf` on the
card, and in the dialog the actual titles when there are few enough to read,
because in a shop the useful form of "you have 2 of these" is which 2.

The matching is in `js/owned.js`, and it is deliberately forgiving in the ways
that don't change the answer and strict in the one that does. Case, accents,
punctuation and a leading "The" all fold, because a sheet two people typed into
over years has "The Clash" on one side and "clash" on the other, and "Vol. 2"
against "Vol 2". Two different albums by one artist stay two different records.
Barcodes match across UPC/EAN zero-padding.

**The shop check.** One box, above the browse controls, because in a shop it is
the thing you came for. Type or scan a barcode, artist, or title and it answers
in the order that matters with a case in your hand: you own it (and where it
is), you wanted it, or neither. It never touches the network — both tabs are
already in memory by the time the box is wired up, which is what makes it work
on a phone with no signal, and the whole reason the page exists.

The shelf is allowed to fail on its own here. If the collection tab can't be
reached, the wishlist still renders, just without ownership marks; a page that
refused to draw because the *other* tab was down would be no wishlist at all.

### Labels

`labels.html` prints jewel-case inserts. Labels get there two ways: typed into
the form by hand, or handed over from the collection by **Make label** in a
disc's detail view, which arrives with the artist, title and any
already-fetched tracklist filled in.

They live only in this browser, in `localStorage` under `cdLabels` — not in the
sheet, not on a server, and "clear site data" takes them with everything else.
**Export** is the way out: a dated `cd-labels-YYYY-MM-DD.json` holding the whole
stack, pretty-printed because it's a file a person may well open. **Import**
takes that back, or a bare array of labels written by hand or by a script.
Every entry is checked before anything is replaced, and a file with one bad
entry is refused whole, with a reason — an import that swapped a stack of
hand-typed tracklists for half a file would be unrecoverable.

Import and **Clear all** are the only two things on the page that can destroy
more than one label at once, and both offer **Undo** for 30 seconds afterwards
rather than a confirmation first: a dialog that fires every single time is one
people learn to dismiss without reading. The offer is only good for that page
view. The change is written to storage immediately — holding it back would
leave storage and screen disagreeing — so a reload inside the window is final.

### Offline & installing

The site is a PWA: it can be installed to a home screen or dock, and it runs
with no connection — which is the point, since the collection is most useful
in a record shop.

Bump `CACHE_VERSION` in `sw.js` whenever the shell changes. Old caches are
deleted on activate, so a bump is also how you force a refresh of anything
stuck. Add new modules and assets to `SHELL_ASSETS` in the same file — it's
hand-kept, and a module missing from it is a network request the offline shell
can't answer, which the site hides perfectly until there's no signal.
`node scripts/check-shell-assets.js` is what notices; CI runs it.

When the discs on screen didn't come from the live sheet, the page says so —
in the results bar on the grid and the wishlist, above the figures on the stats
page — naming
which copy it read (the one saved on this device, or the one published with the
site) and dating it when the worker stamped one. What it never says is that the
*sheet* is out of date: Google's published CSV can trail the spreadsheet all on
its own, and nothing on this side can see that. All any page honestly knows
is which copy it read.

The wishlist carries a second line that reads similarly and means something
else. The one above is "this copy of the sheet is old"; the one sitting with the
shop check is "these rows are" — *n* records on this list are already on the
shelf, which is the answer to "did I buy this and forget to cross it off".

Icons are committed PNGs (there's no build step) generated by
`node scripts/make-icons.js`; re-run that after changing the palette.

## Editing the collection

**You almost never need to touch the code to update the site.** The collection
is just a Google Sheet, and the live site reads from it directly — edit the
sheet, and the change shows up the next time the page is loaded (it may take a
few minutes for Google's published-CSV cache to refresh).

Edit the collection here:

**<https://docs.google.com/spreadsheets/d/18D6C4P16KTyaPtHCgJxq7Rzc0rt_09juUbIwM06Lnmc/edit>**

To add a disc, add a row. To edit one, change its cells. To remove one, delete
the row. The first row is the header and must stay as-is — the column names
below are what the site looks for.

The same spreadsheet has a second tab for the wishlist, edited the same way and
read by `wishlist.html`. Both tabs are published separately, and each one's
published-CSV URL is an entry in `CONFIG.SOURCES` in `js/collection.js`. Adding
a third tab is that block, a line in `SHELL_ASSETS`, and a page with the
matching `data-source` — `scripts/snapshot.js` walks `CONFIG.SOURCES` and picks
up the new one on its own.

### Columns

| Column         | Required? | What it does                                                                 |
|----------------|-----------|------------------------------------------------------------------------------|
| `Book`         | optional  | Which physical book/binder the disc is in (a number: 1, 2, 3…). See below.    |
| `Number`       | optional  | The page/slot **within that book**. Blank + no book shows as "Uncataloged." See multi-disc below. |
| `Artist`       | optional  | Blank falls back to "Various Artists."                                        |
| `Title`        | optional  | Blank falls back to "Self-Titled."                                            |
| `Year`         | optional  | Blank simply shows nothing.                                                   |
| `Parent Genre` | optional  | Drives the Genre filter pills and the stats card. Blank → "Uncategorized."    |
| `Tags`         | optional  | Comma-separated inside one cell, e.g. `essential, moody`. Drives Tag pills.   |
| `Art URL`      | optional  | A direct image URL. If set, it always wins. If blank, art is looked up automatically (MusicBrainz → Cover Art Archive), then a generated placeholder as a last resort. |
| `Notes`        | optional  | Free text shown in the detail view.                                          |
| `Barcode`      | optional  | The UPC/EAN off the back of the case. Pins the MusicBrainz lookup to that exact pressing instead of searching by artist + title. See below. |

Every column is optional — a completely blank row is skipped, and any single
missing cell just uses the fallback above. (To rename a column, update both the
sheet header **and** the matching entry in `CONFIG.COLUMNS` in `js/collection.js`.)

`Barcode` is optional in a second sense too: a sheet that doesn't have the
column at all parses exactly as it did before it existed.

The wishlist tab uses the same columns, minus `Book` and `Number` — nothing on
it has a shelf position yet — and reads a blank `Title` as "Any release" rather
than "Self-Titled". Leaving the two columns out needs no code: `col()` answers
`''` for a header that isn't there.

### Pinning a release with a barcode

Artist + title is a guess, and for a common title with a dozen reissues it is
sometimes the wrong one — the tracklist comes back with ten tracks instead of
eleven, or the cover is the remaster's. The barcode printed on the back of the
case isn't a guess: it names one pressing. Put it in `Barcode` and that disc
stops searching.

What changes for a disc with a barcode:

- **Cover art** comes from that release's own front image rather than from
  whichever cover the archive nominates to stand for the record as a whole.
- **The tracklist** in the detail view is that pressing's running order, with no
  scoring step deciding which pressing to take.
- **The MusicBrainz link** in the detail view goes to the release page.
- **Search** matches the digits, so scanning or typing a barcode with the case
  in your hand answers "is this one already on the shelf?"

Write it however it's printed — `0 75678 26442 9` and `075678264429` are the
same cell as far as the page is concerned. Two things to know:

- **Format the column as plain text in the sheet** (Format → Number → Plain
  text) before typing any barcodes in. Left to itself, a spreadsheet reads a
  barcode as a number, eats the leading zero, and past twelve digits starts
  writing it back as `7.5678E+11` — at which point the digits are genuinely gone
  and no amount of parsing recovers them. A cell in that state is ignored, with
  a warning in the browser console, rather than being sent to MusicBrainz as if
  it meant something. A lost leading zero *is* recovered: the lookup asks for
  the barcode both with and without one, since UPC-A and EAN-13 differ by
  exactly that.
- **A barcode can only help.** If MusicBrainz has no release carrying it — a
  typo, or simply a pressing nobody has entered — the disc falls back to the
  ordinary artist + title search and looks exactly as it did before. Nothing
  disappears because a barcode was wrong.

### Books & shelf location

`Number` is the page within a book, so on its own it isn't unique — page 3
exists in every book. The `Book` column says which book, so together they pin
the disc's physical spot.

- The card tag and detail view show the combined location, e.g. **`B2 · #42`**
  on the card and **`Book 2 · Catalog #42`** in the detail view.
- The **Sort** dropdown has a **Book** option that puts discs in physical shelf
  order — by book, then by page within the book.
- Either field can be blank: `Book` blank just drops the `B#` prefix; both blank
  reads as "Uncataloged" and the card shows no tag.

### Multi-disc releases

Some releases occupy more than one slot in the book — a two-disc greatest-hits
set, a box set, etc. Put the whole span in the one `Number` cell and it still
shows as a **single card**:

| You write in `Number` | Meaning                        | Shown as    |
|-----------------------|--------------------------------|-------------|
| `42`                  | one disc, slot 42              | `#42`       |
| `42-43`               | a two-disc set in slots 42–43  | `#42–43`    |
| `42, 43, 44`          | same as `42-44` (contiguous)   | `#42–44`    |
| `24, 26`              | non-contiguous slots           | `#24, 26`   |

A range and a comma list mean the same thing; use whichever is easier. The
detail view notes the disc count (e.g. "Catalog #42–43 (2 discs)"), searching
any single number in the span finds the release, and sorting by catalog number
places it at its first slot.

### Refreshing the offline snapshots

`data/collection.csv` and `data/wishlist.csv` are the two sheet tabs frozen
into the repo. The service worker
only has a copy of the sheet after one successful *online* fetch, so without
this file a fresh install opened for the first time with no signal has nothing
real to show — the record-shop case the offline support was built for.
`sample.csv` is no substitute; it's invented data.

Editing the sheet doesn't update it. Refresh it by hand, from a machine with a
connection:

```sh
node scripts/snapshot.js
```

The script reads the URLs out of `CONFIG.SOURCES` in `js/collection.js` and
writes every tab it finds there, so there's nothing to configure and nothing to
add when a tab is. Name one (`node scripts/snapshot.js wishlist`) to do just
that one. It refuses to write anything whose header row doesn't name
both the Artist and Title columns — a login wall or a Google error page answers
`200` with HTML, and that must never be able to overwrite a good snapshot.

Then commit the result. This is a hand-run script and not a build stage:
nothing runs it for you, and Pages serves the repo as-is, so the file has to be
in the tree to be servable (same as the icons). Re-run it whenever the sheet
has changed enough that an offline visitor would notice the difference.

One side effect worth having on purpose: because every refresh is a commit,
`git log -p data/collection.csv` becomes an acquisition log — every disc added
to the shelf, in order, dated. `data/wishlist.csv` is the other half of it:
what was wanted, and when it stopped being.

## Files

| File                    | What it is                                                        |
|-------------------------|-------------------------------------------------------------------|
| `index.html`            | The grid page — markup and the loading/empty/error states.        |
| `wishlist.html`         | The same page pointed at the wishlist tab, plus the shop check. See above. |
| `stats.html`            | The breakdowns page.                                              |
| `labels.html`           | The label generator.                                              |
| `styles.css`            | All styling for every page (construction-paper / retro-infographic). |
| `labels.css`            | The labels page only: its form UI, and the frozen printed label. See below. |
| `js/`                   | All JavaScript, as ES modules. See the table below.               |
| `sw.js`                 | Service worker — offline caching (see above).                     |
| `manifest.webmanifest`  | PWA manifest: name, colors, icons, shortcuts.                     |
| `icons/`                | App icons, generated and committed.                               |
| `data/`                 | The sheet tabs frozen into the repo (`collection.csv`, `wishlist.csv`), so a first-ever offline load has real discs. See above, and `data/README.md`. |
| `scripts/make-icons.js` | Regenerates `icons/` — Node stdlib only, run by hand.             |
| `scripts/snapshot.js`   | Regenerates the snapshots in `data/` — likewise Node stdlib, run by hand. |
| `scripts/check-shell-assets.js` | Checks `SHELL_ASSETS` in `sw.js` against the files actually in the tree. |
| `scripts/burncd/`       | **[burncd](scripts/burncd/README.md)** — CLI that burns a folder of music to an audio CD. Nothing to do with the site; see below. |
| `scripts/player/`       | **[player](scripts/player/README.md)** — CLI that plays an album from a zip, a folder, or the drive. burncd's twin; likewise nothing to do with the site. |
| `scripts/bandcamp-wishlist/` | **[bandcamp-wishlist](scripts/bandcamp-wishlist/README.md)** — bookmarklet that prices a Bandcamp wishlist, cheapest first. Likewise; see below. |
| `test/`                 | Unit tests for the pure helpers. See below.                       |
| `.github/workflows/`    | Checks every push to `main` and every pull request; publishes `main` to Pages. See below. |
| `sample.csv`            | Dummy data for local development (see below). One file, read by both tabs. |
| `vendor/`               | The one third-party dependency, committed rather than fetched: `papaparse.min.js`. |
| `CNAME`                 | Custom-domain config for GitHub Pages (`cd.iamgarrett.com`).      |
| `qr.svg` / `qr.png`     | QR code linking to the live site.                                 |

### The modules in `js/`

Native ES modules — no bundler, no build step. Each page loads exactly one
entry point with `<script type="module">` and the browser follows the imports
from there. There is no global namespace: everything crosses a module boundary
by being imported by name.

The table is roughly in dependency order, and that order is real: **the import
graph is a DAG, and `test/imports.test.mjs` fails the build if a cycle appears.**
Worth keeping, because a cycle here doesn't break at build time — there is no
build — it breaks at load time, as `Cannot access 'x' before initialization`
pointing at a line that is perfectly correct on its own. If that test ever
fails, the fix is to turn one edge around rather than work around it: move the
shared value down into a leaf both sides can read (that's what `store.js` is),
or let the lower module take a callback instead of importing the higher one
(that's what `render.js`'s `setCardOpener` is).

| Module            | What it is                                                      |
|-------------------|-----------------------------------------------------------------|
| `errors.js`       | The last-resort error reporter: global `error` and `unhandledrejection` handlers, installed by being imported first on every page. |
| `util.js`         | Tiny shared helpers — element lookup, reduced-motion check, hex test, CSS-variable read, the accent folding both sides of the search use, a focus-safe way to hide a control, and the `localStorage` wrapper. |
| `config.js`       | Grid-page tunables: timings, thresholds, sheet column names, the placeholder palette. |
| `musicbrainz.js`  | Shared MusicBrainz primitives: the site-wide 1/sec throttle, Lucene escaping, the two-step release-group lookup (identify the release, then read a tracklist off it), scoring for both steps, and duration formatting. |
| `labelDraft.js`   | The collection → labels handoff: the draft "Make label" parks in `sessionStorage`, and the one definition of what counts as a label — which the labels page's import reuses to vet a file. |
| `discs.js`        | The four things browsing a collection needs that don't need a browser: parse the search box into terms, decide whether one disc answers the filters, order a list of them, escape a CSV cell. Imports nothing, so the tests can load it. |
| `collection.js`   | Shared data layer: `CONFIG`, sheet fetch, CSV parsing, disc model, `escapeHtml`. Imported by every page. |
| `dom.js`          | The one cache of grid-page element references. |
| `store.js`        | The discs and the current filter state, as data and nothing else. Separate from `state.js` so the modules below can read them without importing the ones above back. |
| `owned.js`        | Is this record already in the books? Name and barcode matching between the wishlist and the shelf, forgiving about how two people typed the same album and strict about which album it is. Used by the stamps and by the shop check. |
| `shop.js`         | The wishlist's one box: type a barcode, artist or title and get own it / want it / neither, shelf position first. Reads what is already in memory and never the network. |
| `url.js`          | The URL as state: reading it on load, writing it on change. |
| `color.js`        | Per-artist accent colors, hex/RGB math, contrast, dominant-color sampling from cover art. |
| `art.js`          | Cover-art and tracklist resolution: MusicBrainz lookups, the Cover Art Archive, and the caches over both. |
| `cover.js`        | The generated placeholder cover — canvas, drawn per disc when no art exists. |
| `render.js`       | Everything that writes to the grid: cards, rows, pills, the tag cloud, the stats card, screen-reader announcements. |
| `controls.js`     | The other direction: pushing `state` back out to the search box, the sort select, the pills and the view toggle, after a deep link or a Back/Forward. |
| `state.js`        | Acting on the collection: filter, sort, view, shuffle, export. |
| `detail.js`       | The disc dialog — opening, populating, and closing it, and its history entry. |
| `app.js`          | **Entry point for `index.html` and `wishlist.html`.** Wiring only — reads the URL, loads the sheet, binds the event listeners, and hands off. On the wishlist it loads both tabs, letting the shelf half fail on its own. |
| `stats.js`        | **Entry point for `stats.html`.** Counts the collection three ways, draws the bar charts, and loads the wishlist for the tag cloud's second tone — failing soft to a one-tone cloud if that tab doesn't answer. |
| `labels.js`       | **Entry point for `labels.html`.** The label list, the form, the print sheet, and the JSON export/import. |

### The labels page's two layers

`labels.html` wears the same chrome as the other three pages — paper, grain,
masthead, the shared nav — and its form is built from the vocabulary in
`styles.css`. Its own stylesheet, `labels.css`, exists for two reasons:

- **The label itself is frozen.** It's measured in inches against a real
  jewel-case insert and printed as black on white, so it deliberately does
  *not* follow the site's paper palette or rem scale. Section 5 of
  `labels.css` is that artifact; treat it as fixed. The two declarations
  marked `INHERITANCE GUARD` re-state values the label used to get for free
  from a bare `<body>` — remove them and `styles.css` reflows the tracklist
  and tints the print.
- **`@page` can't be scoped.** The print sheet needs
  `size: letter portrait; margin: 0.3in`, and an `@page` rule applies to the
  whole document with no way to limit it to one page or selector. In
  `styles.css` it would silently re-margin the printed output of the list
  view and the stats page too.

## Running locally

It's a static site, so any static file server works:

```sh
python3 -m http.server 4173
```

Then open <http://localhost:4173/>.

A server is required — opening the files directly (`file://`) no longer works
at all. Module scripts are fetched with CORS, and `file://` has no origin to
satisfy it, so nothing loads. (The service worker never worked over `file://`
either; it needs `https` or `localhost`.)

If a change to a page or script doesn't seem to take effect locally, it's the
service worker serving the cached copy; unregister it in DevTools →
Application, or bump `CACHE_VERSION` in `sw.js`.

### Preview mode

Append `?sample` to any page's URL to read the bundled `sample.csv` instead of
the live sheet:

<http://localhost:4173/?sample>

The sample data deliberately includes edge cases (blank artist/title/year
rows, a missing catalog number, very long names, and multi-disc releases) so
layout and fallbacks can be exercised without touching the real collection.

### Tests

Six files, and nothing to install:

| File                     | What it pins                                                |
|--------------------------|-------------------------------------------------------------|
| `musicbrainz.test.mjs`   | Lucene escaping, release and release-group scoring, date precision, tracklist flattening, duration formatting. |
| `collection.test.mjs`    | The sheet cells the parser *reads* rather than copies — barcodes above all, since anything it lets through is sent to MusicBrainz as an identifier. Plus a check that each page's `selected` sort option matches its `DEFAULT_SORT`. |
| `discs.test.mjs`         | Search-term parsing, the filter predicate, every sort mode, and CSV escaping — including the leading `=+-@` defusal that keeps an exported cell from opening as a live formula. |
| `owned.test.mjs`         | Matching a wishlist row against the shelf: name normalization, barcode equivalence across UPC/EAN padding, and the guards that stop a blank cell matching everything. |
| `imports.test.mjs`       | That the module graph is acyclic. See the note above the module table. |
| `nav.test.mjs`           | That the site nav — copy-pasted into every page — still says the same thing on all of them: same labels, same order, same destinations, one current-page marker, no page left unlinked. |

```sh
node --test 'test/*.test.mjs'
```

Node 24 or newer, and quote the glob. The pattern has to reach Node intact
rather than be expanded by the shell, and `node --test test/` is read as a path
to a *file* and dies with `MODULE_NOT_FOUND` before a single test runs.

Node also prints a `MODULE_TYPELESS_PACKAGE_JSON` warning on stderr, because
there's no `package.json` to say the modules are ES modules. That's expected
and is not a failure — and it is not worth fixing, because a `package.json`
with `{"type":"module"}` would break all three scripts in `scripts/`
(`make-icons.js`, `snapshot.js`, `check-shell-assets.js`), which are CommonJS
by design. The last of those is the one CI itself runs, so the cure would fail
the very job it was meant to quiet.

Only what runs without a browser is tested. Anything that touches the DOM, the
network or `localStorage` isn't.

### What CI checks

Nothing here is compiled, which is exactly why something has to be checked: a
module with a syntax error is served as-is, the browser refuses the whole
import graph, and the page white-screens — no build to fail, no console anyone
is watching. So `.github/workflows/deploy.yml` runs a `check` job first, on
pushes and on pull requests both:

- `node --check` over `js/*.js`, `scripts/*.js` and `sw.js`. A service worker
  that doesn't parse fails to install and takes offline support with it.
- The unit tests above.
- `node scripts/check-shell-assets.js`, which walks the imports out of every
  `.html` in the tree — discovered rather than listed, so a new page is covered
  the day it lands — and the icons out of the manifest, and fails if
  `SHELL_ASSETS` in `sw.js` has drifted from what's in the tree. That list is hand-kept because
  there's no build step to generate it, and drift is invisible online and total
  offline.

`deploy` waits on `check`, and a pull request stops there — there's one site
and it is `main`'s. All three checks are the commands above, so any of them can
be run by hand before pushing.

[PapaParse]: https://www.papaparse.com/
[MusicBrainz]: https://musicbrainz.org/
[Cover Art Archive]: https://coverartarchive.org/
