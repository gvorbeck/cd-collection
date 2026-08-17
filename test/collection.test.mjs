/* ============================================================
   collection.test.mjs — the sheet cells that get interpreted
   ------------------------------------------------------------
   Run with:  node --test 'test/*.test.mjs'
   (See the note at the top of musicbrainz.test.mjs for why the
   glob is quoted.)

   collection.js is mostly transport — fetch a CSV, hand PapaParse
   a URL, copy cells onto an object — and none of that is testable
   without a browser. What is testable is the handful of cells the
   parser doesn't merely copy but *reads*, and those are the ones
   where being wrong is silent: a cell misread here doesn't throw,
   it just produces a disc that's quietly not the one in the book.

   parseBarcode is the case that most deserves pinning. What it
   rejects matters more than what it accepts, because everything it
   lets through is sent to MusicBrainz as an identifier, and a
   half-digested cell that still looks barcode-shaped would pin a
   disc to somebody else's record with no sign that anything went
   wrong.

   collection.js imports nothing but util.js and touches no DOM at
   module scope, which is what makes it importable here at all.
   Keep it that way.
   ============================================================ */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { parseBarcode, CONFIG } from '../js/collection.js';

const repoFile = (name) =>
  readFileSync(fileURLToPath(new URL(`../${name}`, import.meta.url)), 'utf8');


describe('parseBarcode', () => {
  it('keeps a plain barcode as it stands', () => {
    assert.equal(parseBarcode('075678264429'), '075678264429');
    assert.equal(parseBarcode('4988006861336'), '4988006861336');
  });

  it('strips the way a case prints it', () => {
    // Spaces and dashes are how the digits are grouped on the packaging, not
    // part of the number, and MusicBrainz stores it without them.
    assert.equal(parseBarcode('0 75678 26442 9'), '075678264429');
    assert.equal(parseBarcode('075678-264429'), '075678264429');
    assert.equal(parseBarcode('  075678264429  '), '075678264429');
  });

  it('is blank for a blank cell', () => {
    assert.equal(parseBarcode(''), '');
    assert.equal(parseBarcode('   '), '');
    assert.equal(parseBarcode(null), '');
    assert.equal(parseBarcode(undefined), '');
  });

  it('rejects a catalog number typed into the wrong column', () => {
    // The mistake this column invites: the other number printed on the disc.
    assert.equal(parseBarcode('CDP 7 46001 2'), '');
    assert.equal(parseBarcode('WPCR-75001'), '');
  });

  it('rejects a barcode a spreadsheet turned into a number', () => {
    // The important one. Left to guess, a spreadsheet reads the cell as a
    // number and writes it back out in scientific notation — at which point the
    // digits are gone, not reformatted. Keeping the digits that survive would
    // yield 75678264411 here: eleven digits, entirely plausible, and wrong.
    assert.equal(parseBarcode('7.5678E+11'), '');
    assert.equal(parseBarcode('7.56782644E+11'), '');
  });

  it('rejects a run that is not a barcode length', () => {
    // EAN-8 at the short end, GTIN-14 at the long. Outside that it's half a
    // barcode, or two of them run together, and either way it isn't one.
    assert.equal(parseBarcode('1234567'), '');
    assert.equal(parseBarcode('12345678'), '12345678');
    assert.equal(parseBarcode('12345678901234'), '12345678901234');
    assert.equal(parseBarcode('123456789012345'), '');
  });

  it('accepts the eleven digits a stripped leading zero leaves behind', () => {
    // Not a real barcode length, but it is the shape a mangled UPC-A arrives
    // in, and barcodeQuery in musicbrainz.js is built to ask for it both ways.
    // Rejecting it here would put that recovery out of reach.
    assert.equal(parseBarcode('75678264429'), '75678264429');
  });
});


/* Two files have to agree about how a page opens: the <select> in the markup,
   and SOURCES[…].DEFAULT_SORT here. url.js leaves the sort out of the URL when
   it equals the default and readStateFromUrl puts it back on the way in, so a
   disagreement isn't a cosmetic mismatch — it silently rewrites the order of
   every link the page produces. That's how it got missed the first time: the
   wishlist shipped with `artist` selected against one shared 'random', and
   picking Random there wrote a link that reopened sorted by artist.

   Regex rather than a DOM parser because the alternative is a dependency, and
   this repo's whole premise is not having any. It's pinned to the one <select>
   whose id is `sort`, so it can't drift onto some other control. */
describe('the sort default matches the markup', () => {
  const PAGES = { collection: 'index.html', wishlist: 'wishlist.html' };

  const selectedSort = (html) => {
    const select = html.match(/<select[^>]*\bid="sort"[^>]*>([\s\S]*?)<\/select>/);
    assert.ok(select, 'no <select id="sort"> in the page');
    const options = [...select[1].matchAll(/<option\s+value="([^"]*)"([^>]*)>/g)];
    assert.ok(options.length, 'the sort <select> has no options');
    const chosen = options.filter(([, , attrs]) => /\bselected\b/.test(attrs));
    assert.equal(chosen.length, 1, 'exactly one option should be marked selected');
    return chosen[0][1];
  };

  for (const [source, page] of Object.entries(PAGES)) {
    it(`${page} opens on SOURCES.${source}.DEFAULT_SORT`, () => {
      assert.equal(selectedSort(repoFile(page)), CONFIG.SOURCES[source].DEFAULT_SORT);
    });
  }

  it('covers every source', () => {
    // Adding a tab to SOURCES without a page to read it is fine; adding one
    // with a page and forgetting this list is what this catches.
    assert.deepEqual(Object.keys(CONFIG.SOURCES).sort(), Object.keys(PAGES).sort());
  });
});
