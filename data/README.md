# data/

`collection.csv` is a snapshot of the published Google Sheet — the same CSV
`js/collection.js` fetches at runtime, frozen into the tree.

It exists because the service worker only has the sheet after one *successful,
online* fetch. Without a snapshot, a fresh install opened for the first time
with no signal has nothing real to show, which is the record-shop case the
offline support was built for in the first place. `sample.csv` is no substitute:
it is invented data (Cake, Miles Davis, placeholder cover art) for building out
layouts, and it is what `?sample` reads.

Regenerate it from a machine with a network connection:

    node scripts/snapshot.js

The script reads the sheet's URL out of `js/collection.js`, so there is nothing
to configure here, and it refuses to write anything whose header row doesn't
name both the Artist and Title columns — a login wall or a Google error page
answers `200` with HTML, and that must never be able to overwrite a good
snapshot.

The file is generated but **committed**, like the icons: there is no build step
and GitHub Pages serves the repo as-is, so a file has to be in the tree to be
servable. `sw.js` precaches it (`SHELL_ASSETS`), tolerating its absence in a
checkout where the script has never been run.

Refresh it whenever the sheet has changed enough that an offline visitor would
notice the difference.
