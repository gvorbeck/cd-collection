# bandcamp-wishlist

Price your whole Bandcamp wishlist at once, sorted cheapest first. Bandcamp
shows you a wall of album art with no prices on it; this puts every item in one
list with what it costs, so "what can I grab for twenty bucks" is a question you
can actually answer.

Open <https://bandcamp.com/iamgarrett/wishlist> and click the bookmark. It walks
the whole wishlist, fills in the prices Bandcamp left out, and drops a panel in
the corner with the sorted list and a CSV link.

---

## Installing it

The bookmark's URL is the entire contents of `bandcamp-wishlist.bookmarklet.txt`
— one line, about 17,000 characters.

```bash
pbcopy < scripts/bandcamp-wishlist/bandcamp-wishlist.bookmarklet.txt
```

Then in Chrome: bookmark manager (⌥⌘B) → ⋮ → **Add new bookmark**, name it
whatever, and paste into the **URL** field.

Paste into that field specifically, not the address bar — Chrome and Safari
strip a leading `javascript:` from anything pasted into the address bar, as an
anti-phishing measure, and you get a search for your own source code.

## Editing it

`bandcamp-wishlist.js` is the readable copy. Edit that, then:

```bash
node scripts/bandcamp-wishlist/build.mjs
```

which rewrites the `.txt`. Re-paste it into the bookmark to pick up the change.
Nothing else keeps the two in sync, so don't hand-edit the `.txt`.

---

## What the numbers mean

The panel header counts every item. The line under it splits them:

```
41 priced from page data · 267 needed a lookup · 0 still unknown · + means "or more"
```

Most wishlist entries arrive with no usable price attached, so each one costs a
second request to `tralbum_details`. Items that already carried a real price are
skipped. **The two counts add up to the total** — a lookup count well below the
header is normal, not a sign that anything failed. `still unknown` is the count
that matters: that one is items whose price never resolved.

Prices show in the seller's own currency with a USD estimate beside them:

| shown | means |
|---|---|
| `11.00 AUD (~$7.88)` | converted with Bandcamp's own live rate table |
| `11.00 AUD (~$7.26?)` | live rates missing, converted with the built-in table — the `?` means the estimate is stale |
| `11.00 AUD (no FX rate)` | no rate for this currency anywhere; no estimate offered |
| `$5.00+` | name-your-price, five dollars is the floor |
| `free / name your price` | no minimum |
| `not for sale` / `price unknown` | sorted to the bottom |

The CSV carries an `fx_source` column (`usd` / `live` / `table` / `none`) so a
spreadsheet can tell a real conversion from a guess.

### The rate direction, because it bit once

`currency_data.rates` is **USD per one unit of the currency** — `rates.AUD` is
`0.716` because one Australian dollar is 78 cents. So converting to USD
*multiplies*. It reads like a rate table you'd divide by, and an earlier version
did divide, which inverted every non-USD row: A$11 came out as `$15.36` instead
of `$7.88`, and because the sort key is the USD figure, the whole cheapest-first
ordering was quietly wrong.

Nothing about the output looked broken — the prices were plausible numbers in
the right currencies. It only surfaced by comparing a line against the real
checkout page. If you touch `convert()`, check one row against what Bandcamp
actually charges before trusting the list.

---

## How it works

Two Bandcamp endpoints, both hit as you, from your own logged-in browser:

- `POST /api/fancollection/1/wishlist_items` — pages through the wishlist 40 at
  a time, seeded with the token in the page's `data-blob`. The first ~20 items
  come free from `item_cache.wishlist` in that same blob.
- `GET /api/mobile/25/tralbum_details` — the per-item price lookup, run six at a
  time.

That it runs in your session is the point: fetching these pages cold, from
outside a browser, earns a CAPTCHA. Here there's no scraping and no login
handling — you're already signed in, and it asks the same questions the page
itself asks.

The **Debug** link in the panel copies the raw JSON of up to five items whose
price never resolved, which is where to start if `still unknown` isn't zero.
