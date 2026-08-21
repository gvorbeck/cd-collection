# bandcamp-artist

Price a whole discography at once, cheapest first. A Bandcamp artist page is a
wall of album art with no prices on it; this puts every release in one sorted
list with what it costs, so a 174-album back catalogue becomes shoppable.

Open any artist or label page — the front page or the Music tab, either works —
and click the bookmark. It reads the grid, looks up every release, and drops a
panel in the corner with the sorted list and a CSV link. Each line links back to
its release page.

It is [bandcamp-wishlist](../bandcamp-wishlist/README.md) pointed at someone
else's catalogue instead of your own saved list, and the two share their price,
currency and sorting logic almost line for line.

## Installing

The bookmark's URL is the entire contents of the `.txt` — one line, ~26,000
characters.

```bash
pbcopy < scripts/bandcamp-artist/bandcamp-artist.bookmarklet.txt
```

Chrome: bookmark manager (⌥⌘B) → ⋮ → **Add new bookmark**, paste into the **URL**
field. That field specifically — Chrome and Safari strip a leading `javascript:`
from anything pasted into the address bar, and you get a search for your own
source code.

## Editing

`bandcamp-artist.js` is the readable copy. Edit it, then rebuild and re-paste:

```bash
node scripts/bandcamp-artist/build.mjs
```

Nothing else keeps the two in sync, so don't hand-edit the `.txt`.

## What the numbers mean

```
173 for sale · ~$1299.40 for all of them · 0 price unknown · + means "or more"
```

That total is what the whole discography would cost at the listed minimums, and
it's the reason the tool exists. `price unknown` is the count to watch: it
should be zero.

| Shown | Means |
|---|---|
| `500.00 JPY+ (~$3.14)` | converted with Bandcamp's own live rate table |
| `500.00 JPY+ (~$3.20?)` | live rates missing; built-in table used, `?` means stale |
| `500.00 JPY+ (no FX rate)` | no rate anywhere; no estimate offered |
| `$5.00+` | name-your-price, five dollars is the floor |
| `free / name your price` | no minimum |
| `not for sale` / `price unknown` | sorted to the bottom |
| `rate-limited — re-run` | Bandcamp cut the lookup off; click again, see below |

The CSV has an `fx_source` column (`usd` / `live` / `table` / `none`) so a
spreadsheet can tell a real conversion from a guess, plus a `released` date.

The price is the **digital** one — the number on the release's own Buy button.
Vinyl and CD editions are packages hanging off that release and aren't priced
here, so a `2000.00 JPY+` row may still have a physical edition costing more.

**If you touch `convert()`, check one row against Bandcamp's actual checkout.**
`CurrencyData.rates` is **USD per one unit of the currency** — `rates.JPY` is
`0.0063` because a yen is well under a cent — so converting to USD *multiplies*.
It reads like a table you'd divide by, and an earlier version of the wishlist
script did exactly that, which inverted every non-USD row and, since the sort
key is the USD figure, quietly broke the whole cheapest-first ordering. Nothing
looked wrong: the prices were plausible numbers in the right currencies.

## How it works

The grid first, in two halves, because neither is reliably the whole list:
Bandcamp server-renders the first screenful as `<li data-item-id="album-…">`
and hands the rest to the page's own script in `#music-grid[data-client-items]`.
Both get read and merged by id.

Then one `GET /api/mobile/25/tralbum_details` per release — the same request the
album page makes for its own Buy button. The grid carries no prices at all, so
unlike the wishlist there is no shortcut here: 174 releases means 174 lookups.
A clean run of Celer's 174 takes about 65 seconds.

## The rate limit, which is the whole reason for the pacing

`tralbum_details` allows a burst of roughly thirty requests and then answers
`429` with `Retry-After: 3` until you back off. Four workers going flat out hit
that wall on anything over ~40 releases:

```
6 concurrent, unpaced:              200 × 29, 429 × 31
1 at a time, 500ms apart, after 5s idle:  200 × 12, no 429s at all
```

A 429 carries no price, so the first version of this script filed the entire
tail of a discography under `price unknown` — a rate limit misreported as
missing data, and the sort silently truncated to whatever arrived before the
wall.

So the four workers share one clock rather than racing: each request starts
`pace` ms after the previous one started, whoever it belongs to. A 429 stops
*every* worker for the `Retry-After` the response asks for — pausing only the
worker that got it leaves the other three keeping the limiter hot — and widens
the pace; a clean streak decays it back geometrically. Nothing is dropped on a
429, it's retried up to eight times.

Driven deliberately into the wall (45 unpaced requests first, then the real
lookup layer) it priced 10 of 10 with 24 backoffs, at the 2500ms ceiling: much
slower, nothing lost. Only after eight failed attempts does a release come back
`rate-limited — re-run`, which is a different word from `price unknown` on
purpose.

Prices already fetched are kept on `window.__bcaPrices`, so clicking the
bookmark again pays only for the releases that didn't make it. A page reload
clears it.

Live exchange rates come from `window.CurrencyData.rates`, which artist pages
load from `bandcamp.com/api/currency_data`. The wishlist script finds the same
table in its page blob instead.

Everything runs as you, from your own logged-in browser. Fetching these cold
from outside a browser earns a CAPTCHA; there's no scraping and no login
handling, it just asks the same questions the page itself asks.

On a label page the artist name varies per release, so it's shown on every line;
on a single artist's page it's dropped unless collaborations make it differ.

The **Debug** link copies the raw JSON of up to five releases whose price never
resolved, which is where to start if `price unknown` isn't zero.
