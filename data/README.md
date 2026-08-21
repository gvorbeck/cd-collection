# data/

`collection.csv` and `wishlist.csv` are snapshots of the two published sheet
tabs — the same CSVs `js/collection.js` fetches at runtime, frozen into the tree.
One file per entry in `CONFIG.SOURCES`, written to that entry's `SNAPSHOT_URL`.

They exist because the service worker only has a sheet after one *successful,
online* fetch. Without a snapshot, a fresh install opened offline for the first
time has nothing real to show — the record-shop case offline support was built
for. The wishlist needs one too, since the shop check reads both tabs: a wishlist
without the shelf beside it can say what you wanted but not what you already own.

`sample.csv` is not a substitute — it's invented data for building layouts, and
what `?sample` reads. One file serves both tabs.

Regenerate from a machine with a connection:

```bash
node scripts/snapshot.js              # every tab
node scripts/snapshot.js wishlist     # just the one
```

The script reads the URLs out of `CONFIG.SOURCES`, so there's nothing to
configure here and nothing to add when a tab is. It refuses to write anything
whose header row doesn't name both Artist and Title — a login wall or a Google
error page answers `200` with HTML, and that must never overwrite a good
snapshot.

Generated but **committed**, like the icons: no build step, and Pages serves the
repo as-is. `sw.js` precaches both via `SHELL_ASSETS`, tolerating their absence
in a checkout where the script has never run.

Refresh whenever the sheet has changed enough that an offline visitor would
notice. Since every refresh is a commit, `git log -p` over either file doubles as
a record of the shelf filling up.
