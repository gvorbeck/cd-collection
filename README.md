# CD Collection

**Live site:** <https://cd.iamgarrett.com>

A browsable archive of my CD collection, shelved by catalog number. It's a
single static page — no build step, no framework — that reads its data live
from a published Google Sheet and renders it as a grid of album covers with
search, genre/tag filters, sorting, and a shuffle.

## How it works

- **Data** lives in a Google Sheet, published to the web as CSV. The page
  fetches and parses that CSV at load time with [PapaParse]; there is no
  server and no database.
- **Covers** use the `Art URL` column when present (an explicit URL always
  wins). For discs with a blank `Art URL`, the page looks up cover art
  automatically via [MusicBrainz] → the [Cover Art Archive] — chosen for its
  deep coverage of non-mainstream and obscure releases. Lookups happen only
  when a card scrolls on-screen and are cached in `localStorage`, so usage
  stays well under MusicBrainz's rate limit and no disc is looked up twice.
  Anything still without art falls back to a generated placeholder cover — a
  solid color hashed from the artist name, the title in bold type, and the
  catalog number — drawn on a `<canvas>`.
- **Card shadows** are tinted by the dominant color sampled from each cover,
  falling back to a neutral tint when a cover can't be read.

Everything you'd want to configure — the sheet URL, column names, fallbacks,
and the placeholder palette — is in the `CONFIG` block at the top of `app.js`.

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

### Columns

| Column         | Required? | What it does                                                                 |
|----------------|-----------|------------------------------------------------------------------------------|
| `Number`       | optional  | Catalog / shelf number. Blank shows as "Uncataloged." See multi-disc below.  |
| `Artist`       | optional  | Blank falls back to "Various Artists."                                        |
| `Title`        | optional  | Blank falls back to "Self-Titled."                                            |
| `Year`         | optional  | Blank simply shows nothing.                                                   |
| `Parent Genre` | optional  | Drives the Genre filter pills and the stats card. Blank → "Uncategorized."    |
| `Tags`         | optional  | Comma-separated inside one cell, e.g. `essential, moody`. Drives Tag pills.   |
| `Art URL`      | optional  | A direct image URL. If set, it always wins. If blank, art is looked up automatically (MusicBrainz → Cover Art Archive), then a generated placeholder as a last resort. |
| `Notes`        | optional  | Free text shown in the detail view.                                          |

Every column is optional — a completely blank row is skipped, and any single
missing cell just uses the fallback above. (To rename a column, update both the
sheet header **and** the matching entry in `CONFIG.COLUMNS` in `app.js`.)

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

## Files

| File         | What it is                                            |
|--------------|-------------------------------------------------------|
| `index.html` | Markup and the loading/empty/error states.            |
| `styles.css` | All styling (construction-paper / retro-infographic). |
| `app.js`     | Data loading, rendering, filtering, sorting, shuffle. |
| `sample.csv` | Dummy data for local development (see below).         |
| `CNAME`      | Custom-domain config for GitHub Pages (`cd.iamgarrett.com`). |
| `qr.svg` / `qr.png` | QR code linking to the live site.              |

## Running locally

It's a static site, so any static file server works:

```sh
python3 -m http.server 4173
```

Then open <http://localhost:4173/>.

### Preview mode

Append `?sample` to the URL to read the bundled `sample.csv` instead of the
live sheet:

<http://localhost:4173/?sample>

The sample data deliberately includes edge cases (blank artist/title/year
rows, a missing catalog number, very long names, and multi-disc releases) so
layout and fallbacks can be exercised without touching the real collection.

[PapaParse]: https://www.papaparse.com/
[MusicBrainz]: https://musicbrainz.org/
[Cover Art Archive]: https://coverartarchive.org/
