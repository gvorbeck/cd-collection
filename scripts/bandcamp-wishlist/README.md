# bandcamp-wishlist

Price your whole Bandcamp wishlist at once, cheapest first. Bandcamp shows a
wall of album art with no prices on it; this puts every item in one list with
what it costs, so "what can I grab for twenty bucks" becomes answerable.

Open your wishlist and click the bookmark. It walks the whole list, fills in the
missing prices, and drops a panel in the corner with the sorted list and a CSV
link.

## Installing

The bookmark's URL is the entire contents of the `.txt` — one line, ~17,000
characters.

```bash
pbcopy < scripts/bandcamp-wishlist/bandcamp-wishlist.bookmarklet.txt
```

Chrome: bookmark manager (⌥⌘B) → ⋮ → **Add new bookmark**, paste into the **URL**
field. That field specifically — Chrome and Safari strip a leading `javascript:`
from anything pasted into the address bar, and you get a search for your own
source code.

## Editing

`bandcamp-wishlist.js` is the readable copy. Edit it, then rebuild and re-paste:

```bash
node scripts/bandcamp-wishlist/build.mjs
```

Nothing else keeps the two in sync, so don't hand-edit the `.txt`.

## What the numbers mean

```
41 priced from page data · 267 needed a lookup · 0 still unknown
```

Most entries arrive with no usable price, so each costs a request to
`tralbum_details`; items that already had one are skipped. **The two counts add
up to the total** — a low lookup count is normal, not a failure. `still unknown`
is the one that matters.

| Shown | Means |
|---|---|
| `11.00 AUD (~$7.88)` | converted with Bandcamp's own live rate table |
| `11.00 AUD (~$7.26?)` | live rates missing; built-in table used, `?` means stale |
| `11.00 AUD (no FX rate)` | no rate anywhere; no estimate offered |
| `$5.00+` | name-your-price, five dollars is the floor |
| `free / name your price` | no minimum |
| `not for sale` / `price unknown` | sorted to the bottom |

The CSV has an `fx_source` column (`usd` / `live` / `table` / `none`) so a
spreadsheet can tell a real conversion from a guess.

**If you touch `convert()`, check one row against Bandcamp's actual checkout.**
`currency_data.rates` is **USD per one unit of the currency** — `rates.AUD` is
`0.716` because one Australian dollar is 78 cents — so converting to USD
*multiplies*. It reads like a table you'd divide by, and an earlier version did,
which inverted every non-USD row and, since the sort key is the USD figure,
quietly broke the whole cheapest-first ordering. Nothing looked wrong: the
prices were plausible numbers in the right currencies.

## How it works

Two Bandcamp endpoints, both hit as you, from your own logged-in browser:

- `POST /api/fancollection/1/wishlist_items` — pages through 40 at a time,
  seeded with the token in the page's `data-blob`. The first ~20 items come free
  from `item_cache.wishlist` in that same blob.
- `GET /api/mobile/25/tralbum_details` — the per-item price lookup, six at a time.

Running in your session is the point: fetching these cold from outside a browser
earns a CAPTCHA. There's no scraping and no login handling — you're already
signed in, and it asks the same questions the page itself asks.

The **Debug** link copies the raw JSON of up to five items whose price never
resolved, which is where to start if `still unknown` isn't zero.
