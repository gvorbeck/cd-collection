# CD Collection

A browsable archive of my CD collection, shelved by catalog number. It's a
single static page — no build step, no framework — that reads its data live
from a published Google Sheet and renders it as a grid of album covers with
search, genre/tag filters, sorting, and a shuffle.

## How it works

- **Data** lives in a Google Sheet, published to the web as CSV. The page
  fetches and parses that CSV at load time with [PapaParse]; there is no
  server and no database.
- **Covers** use the `Art URL` column when present. Discs without art get a
  generated placeholder cover — a solid color hashed from the artist name,
  the title in bold type, and the catalog number — drawn on a `<canvas>`.
- **Card shadows** are tinted by the dominant color sampled from each cover,
  falling back to a neutral tint when a cover can't be read.

Everything you'd want to edit — the sheet URL, column names, fallbacks, and
the placeholder palette — is in the `CONFIG` block at the top of `app.js`.

## Files

| File         | What it is                                            |
|--------------|-------------------------------------------------------|
| `index.html` | Markup and the loading/empty/error states.            |
| `styles.css` | All styling (construction-paper / retro-infographic). |
| `app.js`     | Data loading, rendering, filtering, sorting, shuffle. |
| `sample.csv` | Dummy data for local development (see below).         |

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
rows, a missing catalog number, very long names) so layout and fallbacks can
be exercised without touching the real collection.

[PapaParse]: https://www.papaparse.com/
