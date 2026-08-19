# data/

`collection.csv` and `wishlist.csv` are snapshots of the two published tabs of
the Google Sheet — the same CSVs `js/collection.js` fetches at runtime, frozen
into the tree. One file per entry in `CONFIG.SOURCES`, each written to that
entry's `SNAPSHOT_URL`.

They exist because the service worker only has a sheet after one *successful,
online* fetch. Without a snapshot, a fresh install opened for the first time
with no signal has nothing real to show, which is the record-shop case the
offline support was built for in the first place. That case is the whole reason
the wishlist has one too: the shop check reads both tabs, so a wishlist without
the shelf beside it can still tell you what you wanted but not what you already
own — which is the half of the answer that costs money to get wrong.

`sample.csv` is no substitute: it is invented data (Cake, Miles Davis,
placeholder cover art) for building out layouts, and it is what `?sample` reads.
One sample file serves both tabs, since they share every column.

Regenerate them from a machine with a network connection:

    node scripts/snapshot.js              # every tab
    node scripts/snapshot.js wishlist     # just the one

The script reads the URLs out of `CONFIG.SOURCES` in `js/collection.js`, so
there is nothing to configure here and nothing to add when a tab is. It refuses
to write anything whose header row doesn't name both the Artist and Title
columns — a login wall or a Google error page answers `200` with HTML, and that
must never be able to overwrite a good snapshot.

The files are generated but **committed**, like the icons: there is no build
step and GitHub Pages serves the repo as-is, so a file has to be in the tree to
be servable. `sw.js` precaches both (`SHELL_ASSETS`), tolerating their absence
in a checkout where the script has never been run.

Refresh them whenever the sheet has changed enough that an offline visitor would
notice the difference. Because every refresh is a commit, `git log -p` over
either file doubles as a record of the shelf filling up — and of things moving
off the wishlist onto it.
