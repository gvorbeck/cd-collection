# vendor/

Third-party runtime code, committed rather than linked.

## papaparse.min.js

- **Package:** [papaparse](https://www.papaparse.com/) 5.4.1
- **Source:** `https://cdn.jsdelivr.net/npm/papaparse@5.4.1/papaparse.min.js`
- **Size:** 19,469 bytes
- **SHA-384:** `D/t0ZMqQW31H3az8ktEiNb39wyKnS82iFY52QPACM+IjKW3jDUhyIgh2PApRqJZs`
- **License:** MIT

Loaded as a plain `<script>` by `index.html`, `wishlist.html` and `stats.html` —
hence a global (`window.Papa`) rather than an import. One call site: `parseCsv`
in `js/collection.js`, with `download`, `header` and `skipEmptyLines`.

**Why it's here and not on a CDN.** It used to be a `<script src>` at jsdelivr
pinned with `integrity`. That was safe against the file changing but not against
it being *gone*, and three of the four pages render no rows without it — so a
first visit on a new device with jsdelivr unreachable showed an empty collection.
Served from this repo there's no second origin that has to still exist. The
deployed site now has no third-party runtime origins at all; the only external
request left is the Google Fonts stylesheet, which falls back cleanly.

`integrity` and `crossorigin` came off with the move. SRI exists to check a file
someone else is serving; this one ships in the same commit as the page loading
it, and git already knows if it changed.

### Verifying

The hash above is the one that was in the `integrity` attributes before the
move, so this also confirms the vendored bytes match what the site already
loaded:

```sh
openssl dgst -sha384 -binary vendor/papaparse.min.js | openssl base64 -A
```

### Upgrading

No build step and no lockfile, so this is manual and deliberate:

1. Download the new build and diff the hash.
2. Update the version, size and hash above.
3. Bump `CACHE_VERSION` in `sw.js` — installed clients hold the old copy in
   `cdc-shell-*` and won't fetch a new one otherwise.
4. Load all three pages and confirm rows still parse.

Nothing checks this automatically. `scripts/check-shell-assets.js` asserts it's
precached, because it's named in `SHELL_ASSETS`, but it deliberately doesn't walk
classic scripts — so the `<script src>` in the three pages is kept by hand.
