/* ============================================================
   build.mjs — regenerate the pasteable bookmarklet from the source
   ------------------------------------------------------------
   Run with:  node scripts/bandcamp-artist/build.mjs

   Two files here hold the same program: bandcamp-artist.js is the
   one a person reads and edits, and bandcamp-artist.bookmarklet.txt
   is the percent-encoded `javascript:` URL that actually lives in the
   bookmark. Nothing but this script keeps them in step, so edit the
   .js and run this — never hand-edit the .txt.

   Encoding rather than minifying is deliberate: encodeURIComponent
   preserves newlines as %0A, so the comments survive into the bookmark
   and the source stays diffable. The source uses block comments for the
   same reason — a bookmark manager that strips newlines would turn
   line comments into one long commented-out program.
   ============================================================ */

import {readFileSync, writeFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, 'bandcamp-artist.js'), 'utf8');
const out = join(here, 'bandcamp-artist.bookmarklet.txt');

writeFileSync(out, 'javascript:' + encodeURIComponent(src));
console.log(`wrote ${out} (${('javascript:' + encodeURIComponent(src)).length} chars)`);
