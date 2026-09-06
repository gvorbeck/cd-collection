# CD Collection

**Live site:** <https://cd.iamgarrett.com>

A browsable archive of my CD collection, shelved by catalog number. Static site,
no build step — it reads a published Google Sheet at load time and renders a
grid of album covers with search, filters, sorting and shuffle. Installs as an
app and works offline, which is the point: it's most useful in a record shop.

| Page            | What it's for                                                               |
| --------------- | --------------------------------------------------------------------------- |
| `index.html`    | The collection — grid or list, search and filters.                          |
| `wishlist.html` | Records not on the shelf yet, plus a shop check for whether one already is. |
| `stats.html`    | Breakdowns by decade, genre, artist and shelf.                              |
| `labels.html`   | Printable jewel-case inserts. The one page that doesn't read the sheet.     |

## Editing the collection

**No code needed.** Edit the sheet; the change appears on the next page load.

**<https://docs.google.com/spreadsheets/d/18D6C4P16KTyaPtHCgJxq7Rzc0rt_09juUbIwM06Lnmc/edit>**

Row per disc. Keep the header row — those names are what the site reads. Tab 2
is the wishlist. Every column is optional; blanks fall back.

| Column         | Notes                                                                    |
| -------------- | ------------------------------------------------------------------------ |
| `Book`         | Which binder (1, 2, 3…).                                                 |
| `Number`       | Slot **within that book**. Both blank → "Uncataloged."                   |
| `Artist`       | Blank → "Various Artists."                                               |
| `Title`        | Blank → "Self-Titled" (wishlist: "Any release").                         |
| `Year`         |                                                                          |
| `Parent Genre` | Drives Genre pills. Blank → "Uncategorized."                             |
| `Tags`         | Comma-separated in one cell: `essential, moody`.                         |
| `Art URL`      | Direct image URL. Always wins over lookup.                               |
| `Notes`        | Shown in the detail view.                                                |
| `Barcode`      | UPC/EAN. Pins art + tracklist to that exact pressing, and is searchable. |

Renaming a column means editing the sheet header **and** `CONFIG.COLUMNS` in
[js/collection.js](js/collection.js).

**Barcodes:** format the column as plain text _before_ typing any in (Format →
Number → Plain text). Otherwise the sheet eats the leading zero and past twelve
digits rewrites it as `7.5678E+11`, and the digits are gone for good. A wrong or
missing barcode is harmless — the disc just falls back to artist + title search.

**Multi-disc sets** stay one card. Put the span in the one `Number` cell:

| Write        | Shows     |
| ------------ | --------- |
| `42`         | `#42`     |
| `42-43`      | `#42–43`  |
| `42, 43, 44` | `#42–44`  |
| `24, 26`     | `#24, 26` |

## How it works

- **Data** — one sheet, two tabs published as CSV, parsed with [PapaParse]. A
  page picks its tab with `data-source` on `<body>`; that attribute is nearly
  the whole difference between `index.html` and `wishlist.html`. Both are
  configured in `CONFIG.SOURCES` in [js/collection.js](js/collection.js).
- **Covers** — `Art URL`, else [MusicBrainz] → [Cover Art Archive] (lazily, on
  scroll, cached in `localStorage`), else a placeholder drawn on a `<canvas>`.
- **Offline** — `sw.js` precaches the shell, the last good sheet, and fetched
  art. It also precaches `data/collection.csv` so a first-ever offline load
  still shows real discs. Pages say when they're not reading the live sheet.
- **State lives in the URL** — `?q=coltrane&genre=Jazz&sort=year-desc&view=list`,
  and `#disc-<artist>-<title>` for one record. Every view is a link.

## Development

Static site; any file server works. `file://` will **not** work — no origin, so
CORS blocks the modules.

```bash
python3 -m http.server 4173
```

Append `?sample` to read the bundled `sample.csv` instead of the live sheet — it
has the edge cases (blank fields, long names, multi-disc) baked in.

If a change doesn't take effect, it's the service worker: unregister it in
DevTools → Application, or bump `CACHE_VERSION` in `sw.js`.

### Tests

```bash
node --test 'test/*.test.mjs'
```

Node 24+. Quote the glob — `node --test test/` dies before running anything. The
`MODULE_TYPELESS_PACKAGE_JSON` warning is expected; adding a `package.json`
would break the CommonJS scripts in `scripts/`. Only browser-free code is
tested. `imports.test.mjs` fails if the module graph develops a cycle;
`nav.test.mjs` checks the hand-copied nav still matches across pages.

### CI

`.github/workflows/deploy.yml` runs on every push and PR, then deploys `main` to
Pages: `node --check` over all JS, the tests, and
`node scripts/check-shell-assets.js` — which catches `SHELL_ASSETS` in `sw.js`
drifting from the tree. Nothing is compiled here, so a syntax error would
otherwise ship and white-screen the page.

### Hand-run scripts

Not build steps — nothing runs them for you, and their output must be committed.

| Script                               | When                                                                                                                      |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| `node scripts/snapshot.js`           | Sheet changed enough that an offline visitor would notice. Writes every tab in `CONFIG.SOURCES`; add a name for just one. |
| `node scripts/make-icons.js`         | Palette changed.                                                                                                          |
| `node scripts/check-shell-assets.js` | Added a module or asset. Same check CI runs.                                                                              |

### Code

ES modules, no bundler. One entry point per page. **The import graph must stay
acyclic** — a cycle breaks at load time as `Cannot access 'x' before
initialization`, not at build time, because there is no build. Fix by turning an
edge around, never by working around it.

| Layer        | Modules                                                                   |
| ------------ | ------------------------------------------------------------------------- |
| Entry points | `app.js` (index + wishlist), `stats.js`, `labels.js`                      |
| Data         | `collection.js`, `musicbrainz.js`, `art.js`, `owned.js`                   |
| State        | `store.js`, `state.js`, `url.js`, `discs.js` (pure)                       |
| View         | `render.js`, `controls.js`, `detail.js`, `cover.js`, `color.js`, `dom.js` |
| Wishlist     | `shop.js`                                                                 |
| Shared       | `util.js`, `config.js`, `errors.js`, `labelDraft.js`                      |

`styles.css` covers every page; `labels.css` is separate because the printed
label is measured in inches and `@page` rules can't be scoped.

See also [`data/`](data/README.md) and [`vendor/`](vendor/README.md).

## Also in this repo

Six tools, none part of the site — the rest of the hobby, in order:

- **[bandcamp-wishlist](scripts/bandcamp-wishlist/README.md)** — bookmarklet
  that prices a Bandcamp wishlist, cheapest first.
- **[bandcamp-artist](scripts/bandcamp-artist/README.md)** — the same, pointed
  at an artist or label page: a whole discography, cheapest first.
- **[burncd](scripts/burncd/README.md)** — `burncd ~/Music/Album` burns a folder
  to CD-R. Gapless, CD-Text, track order from tags.
- **[player](scripts/player/README.md)** — `player album.zip` plays a zip,
  folder, or the disc in the drive. burncd's twin.
- **[ripper](scripts/ripper/README.md)** — `ripper` reads the disc in the drive
  into a folder of tagged FLAC. The third side of burncd and player.
- **[aiff2flac](scripts/aiff2flac/README.md)** — `aiff2flac` repacks the AIFF
  zips in `~/Downloads` as FLAC. Half the bytes, same audio.

burncd, player and ripper draw the same panel out of the same
[`scripts/lib/panel.sh`](scripts/lib/panel.sh), and ripper and player ask the
same [`scripts/lib/disc.sh`](scripts/lib/disc.sh) what album is in the drive — so
none of the three is a single file you can copy off on its own. Between them they
go round: ripper reads a disc to a folder, burncd writes a folder to a disc, and
player plays either.

[PapaParse]: https://www.papaparse.com/
[MusicBrainz]: https://musicbrainz.org/
[Cover Art Archive]: https://coverartarchive.org/

`wget -r -np -nH --cut-dirs=1 -R "index.html*" https://example.com/some-directory/`
