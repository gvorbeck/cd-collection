/* ============================================================
   discs.test.mjs — ordering, searching, and getting back out
   ------------------------------------------------------------
   Run with:  node --test 'test/*.test.mjs'
   (See the note at the top of musicbrainz.test.mjs for why the
   glob is quoted.)

   These four functions are what the search box, the sort control
   and the Export button actually do, minus the page. All four fail
   quietly by nature: a comparator with the wrong tiebreak gives a
   shelf in a plausible-but-wrong order, a search that drops a term
   finds too much rather than erroring, and a CSV cell escaped
   wrongly opens fine in the spreadsheet that will then run it.

   The fixtures below are shaped like normalizeRows() in
   collection.js leaves a disc — sortArtist/sortTitle already
   stripped of a leading article, `numbers` already parsed to ints,
   `searchText` already folded. That is deliberate: testing against
   raw sheet cells would be testing the wrong module.
   ============================================================ */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { searchTerms, matchesFilters, sortDiscs, csvCell } from '../js/discs.js';
import { foldText } from '../js/util.js';


/* A disc as state.js sees one. `_rand` is assigned per page load in the real
   thing; here it is explicit so the random order is a fact a test can assert. */
let seq = 0;
function disc({ artist, title, year = '', genre = 'Rock', tags = [],
                book = '', numbers = [], notes = '', rand = ++seq }) {
  const strip = (s) => s.replace(/^(the|a|an)\s+/i, '').trim();
  return {
    artist,
    title,
    sortArtist: strip(artist),
    sortTitle: strip(title),
    year: String(year),
    genre,
    tags,
    book,
    bookNum: book === '' ? Infinity : parseInt(book, 10),
    numbers,
    notes,
    searchText: foldText([book, numbers.join(' '), artist, title, year, genre,
                          tags.join(' '), notes].filter(Boolean).join(' ')),
    _rand: rand,
  };
}

const names = (discs) => discs.map((d) => d.title);


describe('searchTerms', () => {
  it('splits on whitespace', () => {
    assert.deepEqual(searchTerms('miles kind of blue'), ['miles', 'kind', 'of', 'blue']);
  });

  it('collapses any amount of space', () => {
    assert.deepEqual(searchTerms('  miles   davis \t '), ['miles', 'davis']);
  });

  it('holds a quoted run together', () => {
    assert.deepEqual(searchTerms('"kind of blue" davis'), ['kind of blue', 'davis']);
    assert.deepEqual(searchTerms('davis "kind of blue"'), ['davis', 'kind of blue']);
  });

  it('runs an unclosed quote to the end of the query', () => {
    // Which is every quoted search halfway through being typed. Matching the
    // quote character literally instead would find nothing, so the results
    // would blank out mid-keystroke and come back on the closing quote.
    assert.deepEqual(searchTerms('"kind of blue'), ['kind of blue']);
    assert.deepEqual(searchTerms('davis "kind of'), ['davis', 'kind of']);
  });

  it('drops a quote pair with nothing in it', () => {
    // Also mid-typing: the moment after the opening quote. An empty term would
    // be `''`, which every searchText contains, so it is a no-op either way —
    // but returning it means an empty query is no longer detectably empty.
    assert.deepEqual(searchTerms('""'), []);
    assert.deepEqual(searchTerms('" "'), []);
    assert.deepEqual(searchTerms('davis ""'), ['davis']);
  });

  it('has no terms for an empty query', () => {
    for (const blank of ['', '   ', null, undefined]) {
      assert.deepEqual(searchTerms(blank), []);
    }
  });

  it('terminates on input built to make a regex spin', () => {
    // Both alternatives of the pattern consume at least one character, which is
    // what keeps the exec loop finite. A zero-width match would hang the page,
    // not throw — worth one test that would time out rather than fail.
    assert.deepEqual(searchTerms('""""'), []);
    assert.deepEqual(searchTerms('"a""b"'), ['a', 'b']);
    assert.deepEqual(searchTerms('"'.repeat(50)), []);
  });
});


describe('matchesFilters', () => {
  const kindOfBlue = disc({
    artist: 'Miles Davis', title: 'Kind of Blue', year: 1959,
    genre: 'Jazz', tags: ['modal', 'classic'], notes: 'mono pressing',
  });
  const terms = (q) => searchTerms(foldText(q));

  it('matches a term found anywhere on the record', () => {
    for (const q of ['miles', 'blue', '1959', 'jazz', 'modal', 'mono']) {
      assert.equal(matchesFilters(kindOfBlue, { terms: terms(q) }), true, q);
    }
  });

  it('requires every term, in any order and not adjacent', () => {
    // The reason the blob is AND-ed term by term rather than substring-matched:
    // the blob's order is the shelf's, which nobody types.
    assert.equal(matchesFilters(kindOfBlue, { terms: terms('miles kind of blue') }), true);
    assert.equal(matchesFilters(kindOfBlue, { terms: terms('1959 miles') }), true);
    assert.equal(matchesFilters(kindOfBlue, { terms: terms('miles coltrane') }), false);
  });

  it('matches an unaccented query against accented text, and back', () => {
    const parra = disc({ artist: 'Ángel Parra', title: 'Vol. 2' });
    assert.equal(matchesFilters(parra, { terms: terms('angel') }), true);
    assert.equal(matchesFilters(parra, { terms: terms('Ángel') }), true);
  });

  it('takes a quoted phrase as one contiguous string', () => {
    assert.equal(matchesFilters(kindOfBlue, { terms: terms('"kind of blue"') }), true);
    assert.equal(matchesFilters(kindOfBlue, { terms: terms('"blue of kind"') }), false);
  });

  it('matches everything when there is no filter at all', () => {
    assert.equal(matchesFilters(kindOfBlue, {}), true);
    assert.equal(matchesFilters(kindOfBlue), true);
    assert.equal(matchesFilters(kindOfBlue, { terms: [], genres: new Set(), tags: new Set() }), true);
  });

  it('ORs the genre pills, because a disc has only one genre', () => {
    // Two genres selected means "either", or selecting a second one would
    // always empty the grid.
    assert.equal(matchesFilters(kindOfBlue, { genres: new Set(['Jazz']) }), true);
    assert.equal(matchesFilters(kindOfBlue, { genres: new Set(['Rock']) }), false);
    assert.equal(matchesFilters(kindOfBlue, { genres: new Set(['Rock', 'Jazz']) }), true);
  });

  it('ANDs the tag pills, because a disc has several tags', () => {
    assert.equal(matchesFilters(kindOfBlue, { tags: new Set(['modal']) }), true);
    assert.equal(matchesFilters(kindOfBlue, { tags: new Set(['modal', 'classic']) }), true);
    assert.equal(matchesFilters(kindOfBlue, { tags: new Set(['modal', 'live']) }), false);
  });

  it('ANDs search, genre and tags with each other', () => {
    assert.equal(matchesFilters(kindOfBlue, {
      terms: terms('miles'), genres: new Set(['Jazz']), tags: new Set(['modal']),
    }), true);
    assert.equal(matchesFilters(kindOfBlue, {
      terms: terms('miles'), genres: new Set(['Jazz']), tags: new Set(['live']),
    }), false);
  });
});


describe('sortDiscs', () => {
  const SHELF = [
    disc({ artist: 'The Clash', title: 'Sandinista!', year: 1980, book: '2', numbers: [220, 221, 222], rand: 5 }),
    disc({ artist: 'Ángel Parra', title: 'Vol. 2',     year: 1966, book: '1', numbers: [3],   rand: 2 }),
    disc({ artist: 'MxPx',       title: 'Pokinatcha',  year: 1994, book: '1', numbers: [44],  rand: 4 }),
    disc({ artist: 'Zebra',      title: 'Aardvark',    year: '',   book: '',  numbers: [],    rand: 1 }),
    disc({ artist: 'The Clash',  title: 'London Calling', year: 1979, book: '2', numbers: [219], rand: 3 }),
  ];

  it('leaves the array it was given alone', () => {
    const before = names(SHELF);
    sortDiscs(SHELF, 'artist');
    assert.deepEqual(names(SHELF), before, 'display order must never touch DISCS');
  });

  it('files artists the way a record shelf does, ignoring a leading article', () => {
    // "The Clash" under C, and "Ángel" with the A's rather than after Z.
    assert.deepEqual(names(sortDiscs(SHELF, 'artist')), [
      'Vol. 2',            // Ángel Parra
      'London Calling',    // Clash — title breaks the tie
      'Sandinista!',       // Clash
      'Pokinatcha',        // MxPx
      'Aardvark',          // Zebra
    ]);
  });

  it('breaks an artist tie on title, not on input order', () => {
    const clash = sortDiscs(SHELF, 'artist').filter((d) => d.artist === 'The Clash');
    assert.deepEqual(names(clash), ['London Calling', 'Sandinista!']);
  });

  it('sorts by title, article stripped there too', () => {
    assert.deepEqual(names(sortDiscs(SHELF, 'title')), [
      'Aardvark', 'London Calling', 'Pokinatcha', 'Sandinista!', 'Vol. 2',
    ]);
  });

  it('puts a multi-disc set where it starts on the shelf', () => {
    // Sandinista! occupies 220-222; it belongs after 219, not after 222.
    assert.deepEqual(names(sortDiscs(SHELF, 'number')), [
      'Vol. 2',          // 3
      'Pokinatcha',      // 44
      'London Calling',  // 219
      'Sandinista!',     // 220-222
      'Aardvark',        // uncataloged — last
    ]);
  });

  it('sorts by book, then by page inside it', () => {
    assert.deepEqual(names(sortDiscs(SHELF, 'book')), [
      'Vol. 2', 'Pokinatcha',        // book 1, pages 3 and 44
      'London Calling', 'Sandinista!', // book 2, pages 219 and 220
      'Aardvark',                     // no book — last
    ]);
  });

  it('sinks a blank year to the bottom of BOTH year sorts', () => {
    // The one that a single blankTo value gets wrong: a missing year has to
    // sort last whichever way the arrow points, so it can't just be 0 or
    // Infinity. 'Aardvark' has no year and belongs at the end of each.
    assert.deepEqual(names(sortDiscs(SHELF, 'year-desc')), [
      'Pokinatcha', 'Sandinista!', 'London Calling', 'Vol. 2', 'Aardvark',
    ]);
    assert.deepEqual(names(sortDiscs(SHELF, 'year-asc')), [
      'Vol. 2', 'London Calling', 'Sandinista!', 'Pokinatcha', 'Aardvark',
    ]);
  });

  it('shuffles by the stable per-load key', () => {
    assert.deepEqual(names(sortDiscs(SHELF, 'random')), [
      'Aardvark', 'Vol. 2', 'London Calling', 'Pokinatcha', 'Sandinista!',
    ]);
  });

  it('falls through to random for a mode the UI cannot produce', () => {
    // ?sort= is validated against the <select> before it reaches here, but a
    // renamed option would arrive as something unhandled, and a shuffled shelf
    // beats a blank page or a throw.
    for (const mode of ['chaos', '', undefined, null]) {
      assert.deepEqual(names(sortDiscs(SHELF, mode)), names(sortDiscs(SHELF, 'random')), String(mode));
    }
  });

  it('has nothing to say about an empty shelf', () => {
    for (const mode of ['artist', 'number', 'book', 'year-asc', 'random']) {
      assert.deepEqual(sortDiscs([], mode), []);
    }
  });
});


describe('csvCell', () => {
  it('leaves an ordinary cell bare', () => {
    assert.equal(csvCell('London Calling'), 'London Calling');
    assert.equal(csvCell('1979'), '1979');
    assert.equal(csvCell(1979), '1979');
  });

  it('quotes what RFC 4180 says to quote', () => {
    assert.equal(csvCell('Davis, Miles'), '"Davis, Miles"');
    assert.equal(csvCell('a\r\nb'), '"a\r\nb"');
    assert.equal(csvCell('a\nb'), '"a\nb"');
  });

  it('doubles an embedded quote', () => {
    assert.equal(csvCell('the "lost" tapes'), '"the ""lost"" tapes"');
  });

  it('defuses a cell a spreadsheet would run', () => {
    // The one that matters. Any of = + - @ leading a cell makes the next
    // spreadsheet treat it as a live formula — no macro warning, no opt-in.
    // A tab inside the quotes can't start one, so the cell stays text.
    assert.equal(csvCell('=1+1'), '"\t=1+1"');
    assert.equal(csvCell('+41 sleeve note'), '"\t+41 sleeve note"');
    assert.equal(csvCell('- see sleeve'), '"\t- see sleeve"');
    assert.equal(csvCell('@artist'), '"\t@artist"');
  });

  it('defuses the real-world version, which also has a comma in it', () => {
    // =HYPERLINK is the exfiltration-shaped one, and it is never NOT quoted
    // anyway — the point is that the tab goes inside the quotes, ahead of the
    // = , not that quoting happens.
    assert.equal(
      csvCell('=HYPERLINK("http://x.example","click")'),
      '"\t=HYPERLINK(""http://x.example"",""click"")"',
    );
  });

  it('is an empty cell for an empty value', () => {
    assert.equal(csvCell(''), '');
    assert.equal(csvCell(null), '');
    assert.equal(csvCell(undefined), '');
  });

  it('leaves a formula character that is not first alone', () => {
    // Only the leading position is dangerous, and tabbing every cell with a
    // hyphen in it would put one in front of half the sheet.
    assert.equal(csvCell('Sunn O)))-ish'), 'Sunn O)))-ish');
    assert.equal(csvCell('4 + 4'), '4 + 4');
  });
});
