# vendor/

Third-party runtime code, committed rather than linked.

## papaparse.min.js

- **Package:** [papaparse](https://www.papaparse.com/) 5.4.1
- **Source:** `https://cdn.jsdelivr.net/npm/papaparse@5.4.1/papaparse.min.js`
- **Size:** 19,469 bytes
- **SHA-384:** `D/t0ZMqQW31H3az8ktEiNb39wyKnS82iFY52QPACM+IjKW3jDUhyIgh2PApRqJZs`
- **License:** MIT

Loaded as a plain `<script>` by `index.html`, `wishlist.html` and `stats.html`,
which is why it is a global (`window.Papa`) rather than an import. It is used at
exactly one call site — `parseCsv` in `js/collection.js` — with three options:
`download`, `header`, and `skipEmptyLines`.

### Why it is here and not on a CDN

It used to be a `<script src>` pointing at jsdelivr, pinned with an `integrity`
attribute. That was safe against the file changing, but not against it being
gone: three of the four pages render no rows at all without it, so a first visit
on a new device with jsdelivr unreachable showed an empty collection. Served
from this repo there is no second origin that has to still exist — clone it,
serve the directory, and the site works with no network at all, which is the
whole premise of the offline shell.

It also means the deployed site has no third-party runtime origins left. The
only remaining external request is the Google Fonts stylesheet, and the type
falls back cleanly when that does not answer.

The `integrity` and `crossorigin` attributes came off with the move. Subresource
Integrity exists to check a file someone else is serving; this one ships in the
same commit as the page that loads it, and git already knows if it changed.

### Verifying this copy

The hash above is the one that was in the pages' `integrity` attributes before
the move, so this check also confirms the vendored bytes are identical to what
the site was already loading:

```sh
openssl dgst -sha384 -binary vendor/papaparse.min.js | openssl base64 -A
```

### Upgrading

There is no build step and no lockfile, so this is a manual, deliberate act:

1. Download the new build and diff the hash so you know what changed.
2. Update the version, size, and hash above.
3. Bump `CACHE_VERSION` in `sw.js` — installed clients hold the old copy in
   `cdc-shell-*` and will not fetch a new one otherwise.
4. Load all three pages and confirm rows still parse.

Nothing checks this file automatically. `scripts/check-shell-assets.js` asserts
it is precached, because it is named in `SHELL_ASSETS`, but it deliberately does
not walk classic scripts, so the `<script src>` in the three pages is still kept
by hand.
