/* ============================================================
   owned.test.mjs — "is this already in the books?"
   ------------------------------------------------------------
   Run with:  node --test 'test/*.test.mjs'
   (See the note at the top of musicbrainz.test.mjs for why the
   glob is quoted.)

   This is the one piece of logic in the repo whose output someone
   acts on while standing in a shop holding a case, and both of its
   failure directions cost money or shelf space: a false "owned"
   puts back a record that isn't there, a false "wanted" buys a
   second copy of one that is.

   Neither failure looks like a failure. matchOnShelf answers with
   the same shape of object whichever way it is wrong, so nothing
   throws, nothing logs, and the only symptom is a confident
   sentence on a phone screen. That is what these pin down.

   The fixtures are deliberately the sheet's real mess — a leading
   "The" on one side and not the other, "Vol. 2" against "Vol 2",
   a UPC that lost its zero to a spreadsheet — because the folding
   rules in matchKey and gtinKey exist for those exact rows, and a
   test built from tidy strings would pass with the folding
   removed.

   owned.js imports only util.js and collection.js, neither of
   which touches the DOM at module scope. Keep it that way — it is
   what makes this file possible.
   ============================================================ */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  matchKey,
  indexByArtist,
  matchOnShelf,
  markOwnership,
  shelfTag,
  shelfLine,
  lookUp,
} from '../js/owned.js';
import { foldText } from '../js/util.js';


/* A disc as normalizeRows() in collection.js hands it over: `title` already has
   the source's fallback applied, `rawTitle` is what the cell actually said, and
   `searchText` is the precomputed folded blob the search box matches against.
   Getting that distinction right in the fixture is the point of having one —
   matchOnShelf reads rawTitle precisely because title lies about blank cells. */
function disc({ artist, title = '', book = '', numberLabel = '', discCount = 1,
                barcode = '', fallback = 'Self-Titled', extra = '' }) {
  const d = {
    artist,
    rawTitle: title,
    title: title || fallback,
    book,
    numberLabel,
    discCount,
    barcode,
  };
  d.searchText = foldText([artist, d.title, extra].filter(Boolean).join(' '));
  return d;
}

const want = (opts) => disc({ ...opts, fallback: 'Any release' });

const SHELF = [
  disc({ artist: 'The Clash', title: 'London Calling', book: '2', numberLabel: '219' }),
  disc({ artist: 'The Clash', title: 'Sandinista!', book: '2', numberLabel: '220', discCount: 3 }),
  disc({ artist: 'MxPx', title: 'Life in General', book: '1', numberLabel: '44' }),
  disc({ artist: 'MxPx', title: 'Slowly Going the Way of the Buffalo', book: '1', numberLabel: '45' }),
  disc({ artist: 'MxPx', title: 'Pokinatcha', book: '1', numberLabel: '46' }),
  disc({ artist: 'MxPx', title: 'Teenage Politics', book: '1', numberLabel: '47' }),
  disc({ artist: 'Sublime', title: '40oz. to Freedom', book: '3', numberLabel: '7',
         barcode: '075678264429' }),
  disc({ artist: 'Ángel Parra', title: 'Vol. 2', book: '4', numberLabel: '12' }),
];


describe('matchKey', () => {
  it('agrees across the ways two people type one name', () => {
    // Every pair here is one band or album as it appears on both sheets.
    const same = [
      ['The Clash', 'clash'],
      ['MxPx', 'mxpx'],
      ['Ángel Parra', 'Angel Parra'],
      ['Vol. 2', 'Vol 2'],
      ['Where Have All the Merrymakers Gone?', 'where have all the merrymakers gone'],
      ['A Tribe Called Quest', 'tribe called quest'],
    ];
    for (const [a, b] of same) assert.equal(matchKey(a), matchKey(b), `${a} ≠ ${b}`);
  });

  it('strips the article even when punctuation is in the way', () => {
    // The ordering hazard called out in owned.js: punctuation has to flatten
    // first, or these keep an article the shelf's spelling has already lost.
    assert.equal(matchKey('(The) Clash'), matchKey('The Clash'));
    assert.equal(matchKey('The-Dandy Warhols'), matchKey('The Dandy Warhols'));
  });

  it('leaves an article that is part of the word alone', () => {
    assert.equal(matchKey('Anthrax'), 'anthrax');
    assert.equal(matchKey('Theory of a Deadman'), 'theory of a deadman');
  });

  it('keeps two different albums apart', () => {
    // The strictness half. These fold to the same shape under a sloppier rule.
    assert.notEqual(matchKey('Greatest Hits'), matchKey('Greatest Hits Vol. 2'));
    assert.notEqual(matchKey('Pokinatcha'), matchKey('Pokinatcha Punk'));
  });

  it('is an empty string for nothing at all', () => {
    // '' is load-bearing: indexByArtist skips it and matchOnShelf reads it as
    // "any release", so it must not come back as a matchable key.
    for (const blank of ['', '   ', '—', '!!!', null, undefined]) {
      assert.equal(matchKey(blank), '');
    }
  });
});


describe('indexByArtist', () => {
  it('buckets every spelling of an artist together', () => {
    const idx = indexByArtist(SHELF);
    assert.equal(idx.get('clash').length, 2);
    assert.equal(idx.get('mxpx').length, 4);
    assert.equal(idx.get(matchKey('Ángel Parra')).length, 1);
  });

  it('leaves out a row with no artist rather than bucketing it under ""', () => {
    const idx = indexByArtist([...SHELF, disc({ artist: '', title: 'Orphan' })]);
    assert.equal(idx.has(''), false);
  });
});


describe('matchOnShelf', () => {
  const byArtist = indexByArtist(SHELF);
  const verdict = (w) => matchOnShelf(w, byArtist);

  it('says owned for the same record spelled differently', () => {
    const v = verdict(want({ artist: 'clash', title: 'london calling' }));
    assert.equal(v.status, 'owned');
    assert.deepEqual(v.discs.map((d) => d.numberLabel), ['219']);
  });

  it('says artist when they are on the shelf but this record is not', () => {
    const v = verdict(want({ artist: 'The Clash', title: 'Combat Rock' }));
    assert.equal(v.status, 'artist');
    assert.equal(v.discs.length, 2, 'reports what IS there, not just that something is');
  });

  it('says wanted when nothing by them is shelved', () => {
    const v = verdict(want({ artist: 'Slowdive', title: 'Souvlaki' }));
    assert.deepEqual(v, { status: 'wanted', discs: [] });
  });

  it('never says owned for a row with no title', () => {
    // "any MxPx album" can be informed, not crossed off — a judgement owned.js
    // documents and the wishlist page renders differently. Four MxPx discs on
    // the shelf and the answer is still 'artist'.
    const v = verdict(want({ artist: 'MxPx', title: '' }));
    assert.equal(v.status, 'artist');
    assert.equal(v.discs.length, 4);
  });

  it('reads rawTitle, not the fallback the page would print', () => {
    // The trap: `title` on a blank wishlist row is the literal words "Any
    // release". Matching on it would hunt for an album by that name forever.
    const blank = want({ artist: 'MxPx', title: '' });
    assert.equal(blank.title, 'Any release', 'fixture must reproduce the fallback');
    assert.equal(verdict(blank).status, 'artist');
  });

  it('does not let a title match reach across artists', () => {
    // Two bands with an album of the same name is the ordinary case, so the
    // artist bucket has to gate the title comparison rather than the reverse.
    const v = verdict(want({ artist: 'Slowdive', title: 'London Calling' }));
    assert.equal(v.status, 'wanted');
  });
});


describe('markOwnership', () => {
  it('attaches a verdict to every row and hands the list back', () => {
    const wants = [
      want({ artist: 'The Clash', title: 'London Calling' }),
      want({ artist: 'MxPx', title: '' }),
      want({ artist: 'Slowdive', title: 'Souvlaki' }),
    ];
    const out = markOwnership(wants, SHELF);
    assert.equal(out, wants, 'marks in place — render.js is holding this array');
    assert.deepEqual(wants.map((w) => w._shelf.status), ['owned', 'artist', 'wanted']);
  });
});


describe('shelfTag', () => {
  const tagFor = (w) => shelfTag(markOwnership([w], SHELF)[0]);

  it('names the slot when exactly one copy is shelved', () => {
    assert.equal(tagFor(want({ artist: 'The Clash', title: 'London Calling' })), 'B2 · #219');
  });

  it('counts instead of listing when the artist is what matched', () => {
    assert.equal(tagFor(want({ artist: 'MxPx', title: '' })), '4 on the shelf');
  });

  it('says nothing for a record that is genuinely wanted', () => {
    assert.equal(tagFor(want({ artist: 'Slowdive', title: 'Souvlaki' })), '');
  });

  it('falls back to plain words when the copy has no location', () => {
    // A shelved disc with no Book or Number yields '' from formatLocation, and
    // an empty corner tag would read as "not owned" — the wrong answer.
    const noSlot = [disc({ artist: 'Fugazi', title: 'Repeater' })];
    const w = markOwnership([want({ artist: 'Fugazi', title: 'Repeater' })], noSlot)[0];
    assert.equal(shelfTag(w), 'On the shelf');
  });

  it('says nothing at all for a disc with no verdict on it', () => {
    // Every disc on index.html. The shared renderers call this unconditionally.
    assert.equal(shelfTag(disc({ artist: 'The Clash', title: 'London Calling' })), '');
  });
});


describe('shelfLine', () => {
  const lineFor = (w, shelf = SHELF) => shelfLine(markOwnership([w], shelf)[0]);

  it('spells out where an owned copy is', () => {
    assert.equal(
      lineFor(want({ artist: 'The Clash', title: 'London Calling' })),
      'Already on the shelf — Book 2 · Catalog #219',
    );
  });

  it('mentions the disc count on a box set', () => {
    assert.equal(
      lineFor(want({ artist: 'The Clash', title: 'Sandinista!' })),
      'Already on the shelf — Book 2 · Catalog #220 (3 discs)',
    );
  });

  it('names the other records when there are few enough to read', () => {
    assert.equal(
      lineFor(want({ artist: 'The Clash', title: 'Combat Rock' })),
      'Not on the shelf — but The Clash is: London Calling, Sandinista!',
    );
  });

  it('counts them once naming them stops being readable', () => {
    // Four MxPx discs, over the threshold of three.
    assert.equal(
      lineFor(want({ artist: 'MxPx', title: 'Before Everything & After' })),
      'Not on the shelf — but 4 other discs by MxPx are',
    );
  });

  it('says discs, not the wishlist page\'s noun', () => {
    // The reason owned.js has its own noun(): collection.js's answers for the
    // page, which is "records" here — about things that are on the shelf.
    const one = [disc({ artist: 'Fugazi', title: 'Repeater', book: '5', numberLabel: '1' })];
    const line = lineFor(want({ artist: 'Fugazi', title: '13 Songs' }), one);
    assert.equal(line, 'Not on the shelf — but Fugazi is: Repeater');
    assert.match(lineFor(want({ artist: 'MxPx', title: 'Panic' })), /discs/);
  });

  it('is plain about a record nothing matches', () => {
    assert.equal(
      lineFor(want({ artist: 'Slowdive', title: 'Souvlaki' })),
      'Not on the shelf — nothing by Slowdive is',
    );
  });
});


describe('lookUp', () => {
  const WANTS = [
    want({ artist: 'Slowdive', title: 'Souvlaki', barcode: '5016025670291' }),
    want({ artist: 'Sublime', title: 'Sublime' }),
  ];
  const ask = (q) => lookUp(q, SHELF, WANTS);

  it('finds a disc by the digits off the back of the case', () => {
    const { shelf, wants } = ask('075678264429');
    assert.deepEqual(shelf.map((d) => d.title), ['40oz. to Freedom']);
    assert.deepEqual(wants, []);
  });

  it('matches the same pressing however wide the scan wrote it', () => {
    // UPC-A, EAN-13 and the eleven digits a spreadsheet leaves behind are one
    // number with different padding. Compared as strings they are three
    // records, and the shop check says "not on the shelf" about book three.
    for (const scan of ['075678264429', '0075678264429', '00075678264429', '75678264429']) {
      assert.deepEqual(ask(scan).shelf.map((d) => d.title), ['40oz. to Freedom'], scan);
    }
  });

  it('reads a barcode through the spacing a scanner or a case adds', () => {
    assert.equal(ask('0 75678 26442 9').shelf.length, 1);
    assert.equal(ask('075678-264429').shelf.length, 1);
  });

  it('asks the wishlist the same question', () => {
    const { shelf, wants } = ask('5016025670291');
    assert.deepEqual(shelf, []);
    assert.deepEqual(wants.map((d) => d.title), ['Souvlaki']);
  });

  it('comes back empty on a scan that simply is not there', () => {
    const { shelf, wants } = ask('9999999999999');
    assert.deepEqual(shelf, []);
    assert.deepEqual(wants, []);
  });

  it('does not let an all-zero scan match every unbarcoded row', () => {
    // gtinKey strips leading zeros, so this query reduces to '' — and so does
    // every empty Barcode cell, which is most of the sheet. Only the explicit
    // `!!d.barcode` guard keeps '' === '' from returning the whole collection
    // as an exact barcode match. A misread scan is exactly how you'd get here.
    const { shelf, wants } = ask('00000000');
    assert.deepEqual(shelf, []);
    assert.deepEqual(wants, []);
  });

  it('never falls through from a failed scan to a text search', () => {
    // A run of digits is only ever a barcode. The fixture's title IS the digits
    // scanned, so a fall-through would find it — which is the point: in a shop
    // a confident wrong answer is worse than "not found".
    const numericTitle = [disc({ artist: 'Adele', title: '12345678', barcode: '' })];
    assert.equal(numericTitle[0].searchText.includes('12345678'), true, 'fixture is findable by text');
    assert.deepEqual(lookUp('12345678', numericTitle, []).shelf, []);
  });

  it('finds a record by name, folded and in any order', () => {
    assert.deepEqual(ask('bouncing').shelf, []);
    assert.deepEqual(ask('clash london').shelf.map((d) => d.title), ['London Calling']);
    assert.deepEqual(ask('LONDON  clash').shelf.map((d) => d.title), ['London Calling']);
    assert.deepEqual(ask('angel parra').shelf.map((d) => d.artist), ['Ángel Parra']);
  });

  it('requires every term, not any of them', () => {
    assert.deepEqual(ask('clash sandinista').shelf.map((d) => d.numberLabel), ['220']);
    assert.deepEqual(ask('clash souvlaki').shelf, []);
  });

  it('answers both halves at once', () => {
    // "You own it" and "you wanted it" are not exclusive, and the pair is the
    // actual answer — a wishlist row nobody crossed off after buying the disc.
    const both = lookUp('sublime', SHELF, WANTS);
    assert.equal(both.shelf.length, 1);
    assert.equal(both.wants.length, 1);
  });

  it('has nothing to say about an empty box', () => {
    for (const blank of ['', '   ', null, undefined]) {
      assert.deepEqual(lookUp(blank, SHELF, WANTS), { shelf: [], wants: [] });
    }
  });
});
