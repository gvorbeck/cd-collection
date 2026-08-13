/* ============================================================
   musicbrainz.test.mjs — characterization tests for the tuning
   ------------------------------------------------------------
   Run with:  node --test 'test/*.test.mjs'
   (Quote the glob. A bare directory argument doesn't work in
   Node 24, and there is no package.json here to hold a script —
   this site has no build step and no dependencies, so the tests
   use node:test and node:assert and nothing else.)

   These lock in what the scoring does *today*, numbers and all.
   The weights in musicbrainz.js are the accumulated result of
   real records coming out wrong — a same-named single instead of
   the album, a ten-track regional pressing instead of the
   eleven-track original — and until now the only record of which
   comparison each weight was chosen to win was a paragraph of
   prose above it. Prose doesn't fail when someone nudges a
   number. These do, which is the point: the next tuning pass
   should be deliberate, and a broken test here is the question
   "did you mean to change which disc wins?", not an accusation.

   Only pure functions are covered. findReleaseGroup and
   tracksForReleaseGroup are one throttled fetch each, and a
   throttle is 1.1 seconds of test suite per call — they are left
   to the browser.
   ============================================================ */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  escapeLucene,
  formatDuration,
  releaseYear,
  datePrecision,
  scoreRelease,
  pickBestRelease,
  flattenTracks,
  normalizeTitle,
  scoreReleaseGroup,
  barcodeQuery,
} from '../js/musicbrainz.js';


// An official single-CD pressing, the shape scoreRelease expects from a search
// or browse result. Every case below is this with something changed, so the
// thing being measured is the only difference between two numbers.
function release(over = {}) {
  return { status: 'Official', media: [{ format: 'CD' }], country: 'US', date: '2006', ...over };
}

// n CD media — the difference between a single disc and a deluxe reissue with
// a bonus disc of demos.
function discs(n) {
  return Array.from({ length: n }, () => ({ format: 'CD' }));
}


describe('escapeLucene', () => {
  it('leaves an ordinary title alone', () => {
    assert.equal(escapeLucene('Back to Black'), 'Back to Black');
  });

  it('escapes the slash in a band name, which would otherwise open a regex', () => {
    assert.equal(escapeLucene('AC/DC'), 'AC\\/DC');
  });

  it('escapes quotes, which would otherwise close the quoted term around them', () => {
    assert.equal(escapeLucene('"Heroes"'), '\\"Heroes\\"');
  });

  it('escapes grouping and operator characters', () => {
    assert.equal(escapeLucene('Sgt. Pepper (Remastered)'), 'Sgt. Pepper \\(Remastered\\)');
    assert.equal(escapeLucene('+/-'), '\\+\\/\\-');
  });

  it('leaves an apostrophe alone — Lucene has no meaning for it', () => {
    assert.equal(escapeLucene("Guns N' Roses"), "Guns N' Roses");
  });
});


describe('formatDuration', () => {
  it('is blank for a track MusicBrainz has no timing for', () => {
    // Blank rather than "0:00" so callers can drop the column wholesale.
    assert.equal(formatDuration(0), '');
    assert.equal(formatDuration(null), '');
    assert.equal(formatDuration(undefined), '');
  });

  it('formats a normal track as m:ss with a padded second', () => {
    assert.equal(formatDuration(1000), '0:01');
    assert.equal(formatDuration(59000), '0:59');
    assert.equal(formatDuration(60000), '1:00');
    assert.equal(formatDuration(213000), '3:33');
  });

  it('rolls up to h:mm:ss past an hour, padding the minutes too', () => {
    assert.equal(formatDuration(3600000), '1:00:00');
    assert.equal(formatDuration(3723000), '1:02:03');
  });

  it('rounds to the nearest second, so 59.9s prints as a minute', () => {
    assert.equal(formatDuration(1500), '0:02');
    assert.equal(formatDuration(1400), '0:01');
    assert.equal(formatDuration(59900), '1:00');
  });
});


describe('releaseYear', () => {
  it('takes the year off the front of any date precision', () => {
    assert.equal(releaseYear({ date: '2006-10-27' }), 2006);
    assert.equal(releaseYear({ date: '2006-10' }), 2006);
    assert.equal(releaseYear({ date: '2006' }), 2006);
  });

  it('is null for an undated release', () => {
    assert.equal(releaseYear({}), null);
    assert.equal(releaseYear({ date: '' }), null);
    // Year zero parses to 0, which falls through the || to null — no release is
    // from year zero, and a 0 here would score as "undated" anyway.
    assert.equal(releaseYear({ date: '0000' }), null);
  });
});


describe('datePrecision', () => {
  it('counts the parts of the date', () => {
    assert.equal(datePrecision({ date: '2006-10-27' }), 3);
    assert.equal(datePrecision({ date: '2006-10' }), 2);
    assert.equal(datePrecision({ date: '2006' }), 1);
    assert.equal(datePrecision({ date: '' }), 0);
    assert.equal(datePrecision({}), 0);
  });
});


describe('scoreRelease', () => {
  it('scores an official exact-year CD out of its parts', () => {
    // 100 official + 50 CD + 40 exact year + 10 capped tiebreak (US, 1 disc).
    assert.equal(scoreRelease(release(), 2006), 200);
  });

  it('caps the country + disc-count tiebreak at 10', () => {
    // US (6) + single disc (8) is 14 uncapped; XW (4) + single disc is 12. Both
    // land on the cap, which is what keeps either of them off the year below.
    const usSingle = scoreRelease(release({ country: 'US', media: discs(1) }), 2006);
    const xwSingle = scoreRelease(release({ country: 'XW', media: discs(1) }), 2006);
    assert.equal(usSingle, 200);
    assert.equal(xwSingle, 200);

    // Under the cap the parts still separate pressings, which is their job.
    assert.equal(scoreRelease(release({ country: 'US', media: discs(2) }), 2006), 196);
    assert.equal(scoreRelease(release({ country: 'XW', media: discs(2) }), 2006), 194);
    assert.equal(scoreRelease(release({ country: 'GB', media: discs(2) }), 2006), 190);
  });

  it('never lets the tiebreak overturn an exact year', () => {
    // The case that was wrong: an exact-year GB 2-disc scored 190 against a
    // year-off US single-disc's 193, so the tiebreakers chose the wrong year.
    const exactYear = scoreRelease(release({ country: 'GB', date: '2006', media: discs(2) }), 2006);
    const yearOff = scoreRelease(release({ country: 'US', date: '2007', media: discs(1) }), 2006);
    assert.equal(exactYear, 190);
    assert.equal(yearOff, 189);
    assert.ok(exactYear > yearOff);
  });

  it('still ties, but never loses, when MB relevance is thrown in on top', () => {
    // Relevance adds at most 1.00, which brings the best possible tiebreak to
    // exactly the 11-point exact-year cliff. A tie hands the choice to date
    // precision in pickBestRelease; it must never become a win.
    const exactYear = scoreRelease(
      release({ country: 'GB', date: '2006', media: discs(2), score: 0 }), 2006);
    const yearOff = scoreRelease(
      release({ country: 'US', date: '2007', media: discs(1), score: 100 }), 2006);
    assert.equal(exactYear, 190);
    assert.equal(yearOff, 190);
    assert.ok(!(yearOff > exactYear));
  });

  it('holds that invariant for every country and disc count', () => {
    // The exact-year pressing here is the worst one imaginable — a country that
    // scores nothing, three discs, no relevance — and the year-off pressing is
    // the best: US, single disc, top relevance. The year still wins or ties.
    const best = scoreRelease(
      release({ country: 'US', date: '2007', media: discs(1), score: 100 }), 2006);
    for (const country of ['US', 'XW', 'GB', 'XE', '']) {
      for (const count of [1, 2, 3]) {
        const exact = scoreRelease(
          release({ country, date: '2006', media: discs(count), score: 0 }), 2006);
        assert.ok(exact >= best, `${country || 'no country'} / ${count} disc(s): ${exact} < ${best}`);
      }
    }
  });

  it('never lets the tiebreak overturn the format', () => {
    // A US single-disc vinyl is still vinyl; this is a collection of CDs.
    const cd = scoreRelease(release({ country: 'GB', media: discs(2), date: '' }), 2006);
    const vinyl = scoreRelease(
      release({ country: 'US', media: [{ format: '12" Vinyl' }], date: '' }), 2006);
    assert.equal(cd, 150);
    assert.equal(vinyl, 110);
  });

  it('never lets the tiebreak overturn official status', () => {
    const official = scoreRelease(release({ status: 'Official', country: 'GB', media: discs(2) }), 2006);
    const promo = scoreRelease(release({ status: 'Promotion', country: 'US', media: discs(1) }), 2006);
    assert.equal(official, 190);
    assert.equal(promo, 100);
  });

  it('prefers earlier pressings when there is no year to match', () => {
    // No target year at all: 30 - (year - 1900) / 10, so the original beats the
    // reissue by a couple of points rather than by the year cliff.
    assert.equal(scoreRelease(release({ date: '1990' }), null), 181);
    assert.equal(scoreRelease(release({ date: '2010' }), null), 179);
  });

  it('scores an empty release object at zero', () => {
    assert.equal(scoreRelease({}, 2006), 0);
  });
});


describe('pickBestRelease', () => {
  it('is null for nothing to pick from', () => {
    assert.equal(pickBestRelease([], 2006), null);
    assert.equal(pickBestRelease(null, 2006), null);
    assert.equal(pickBestRelease(undefined, 2006), null);
  });

  it('picks the original CD out of a real release group', () => {
    // Every pressing MusicBrainz returns for "Back to Black" in miniature: the
    // original, a later US issue, an undated European one, the deluxe reissue
    // with a bonus disc, the vinyl, and a promo. Browse results carry no
    // relevance score at all, which is why the rest of the scoring has to work.
    const releases = [
      { id: 'us-2007', status: 'Official', country: 'US', date: '2007-03-13', media: discs(1) },
      { id: 'deluxe', status: 'Official', country: 'US', date: '2007-11-05', media: discs(2) },
      { id: 'gb-orig', status: 'Official', country: 'GB', date: '2006-10-27', media: discs(1) },
      { id: 'eu-nodate', status: 'Official', country: 'XE', date: '', media: discs(1) },
      { id: 'vinyl', status: 'Official', country: 'GB', date: '2006-10-27', media: [{ format: '12" Vinyl' }] },
      { id: 'promo', status: 'Promotion', country: 'US', date: '2006', media: discs(1) },
    ];
    assert.equal(pickBestRelease(releases, 2006).id, 'gb-orig');
    // And it chooses rather than reorders: the caller's array is untouched.
    assert.equal(releases[0].id, 'us-2007');
  });

  it('breaks a tied score on how precisely MB knows the date', () => {
    // Identical pressings but for the date's precision. A full date is the
    // documented original; a bare year is usually a reissue catalogued later.
    const releases = [
      { id: 'bare', status: 'Official', country: 'GB', date: '2006', media: discs(1) },
      { id: 'full', status: 'Official', country: 'GB', date: '2006-10-27', media: discs(1) },
    ];
    assert.equal(scoreRelease(releases[0], 2006), scoreRelease(releases[1], 2006));
    assert.equal(pickBestRelease(releases, 2006).id, 'full');
  });

  it('breaks a remaining tie on the earliest date', () => {
    const releases = [
      { id: 'later', status: 'Official', country: 'GB', date: '2006-11-01', media: discs(1) },
      { id: 'earlier', status: 'Official', country: 'GB', date: '2006-03-01', media: discs(1) },
    ];
    assert.equal(pickBestRelease(releases, 2006).id, 'earlier');
  });
});


describe('flattenTracks', () => {
  it('runs every medium together in playing order', () => {
    // A two-disc set is one continuous list: the detail view prints one
    // tracklist and the labels page one numbered column.
    const release2 = {
      media: [
        { tracks: [{ title: 'Rehab', length: 214000 }, { title: 'You Know I\'m No Good', length: 258000 }] },
        { tracks: [{ title: 'Valerie', length: 233000 }] },
      ],
    };
    assert.deepEqual(flattenTracks(release2), [
      { title: 'Rehab', length: 214000 },
      { title: 'You Know I\'m No Good', length: 258000 },
      { title: 'Valerie', length: 233000 },
    ]);
  });

  it('falls back to the recording for a title or length the track lacks', () => {
    const rel = {
      media: [{
        tracks: [
          { title: '', recording: { title: 'Wake Up Alone', length: 251000 } },
          { title: 'Some Unholy War', recording: { title: 'Some Unholy War (album)', length: 142000 } },
        ],
      }],
    };
    assert.deepEqual(flattenTracks(rel), [
      { title: 'Wake Up Alone', length: 251000 },
      // The track's own title wins over the recording's; the length falls back.
      { title: 'Some Unholy War', length: 142000 },
    ]);
  });

  it('drops untitled tracks rather than rendering a blank row', () => {
    const rel = { media: [{ tracks: [{ length: 1000 }, { title: 'Addicted', length: 167000 }] }] };
    assert.deepEqual(flattenTracks(rel), [{ title: 'Addicted', length: 167000 }]);
  });

  it('keeps a track MusicBrainz has no timing for, with a zero length', () => {
    const rel = { media: [{ tracks: [{ title: 'Hidden Track' }] }] };
    assert.deepEqual(flattenTracks(rel), [{ title: 'Hidden Track', length: 0 }]);
  });

  it('is an empty list for anything without media', () => {
    assert.deepEqual(flattenTracks(null), []);
    assert.deepEqual(flattenTracks(undefined), []);
    assert.deepEqual(flattenTracks({}), []);
    assert.deepEqual(flattenTracks({ media: [{}] }), []);
  });

  /* ---------- Per-track artist credits ----------
     The rule is MusicBrainz's own: name the artist on a track only when it
     isn't the one the release is credited to. Every deepEqual above is part of
     this — none of them mention `artist`, so they only pass while an ordinary
     album stays exactly as clean as it was. */

  it('names the band on each track of a Various Artists compilation', () => {
    const rel = {
      'artist-credit': [{ name: 'Various Artists' }],
      media: [{ tracks: [
        { title: 'Le Freak', length: 212000, 'artist-credit': [{ name: 'Chic' }] },
        { title: 'Good Times', length: 494000, 'artist-credit': [{ name: 'Chic' }] },
      ] }],
    };
    assert.deepEqual(flattenTracks(rel), [
      { title: 'Le Freak', length: 212000, artist: 'Chic' },
      { title: 'Good Times', length: 494000, artist: 'Chic' },
    ]);
  });

  it('says nothing on an album whose tracks are by the album artist', () => {
    // The case that has to stay silent, and the reason the test above is worth
    // having: artist-credits comes back on every request now, so without this
    // rule every line of every ordinary album would repeat the artist already
    // printed at the top of the dialog.
    const rel = {
      'artist-credit': [{ name: 'Amy Winehouse' }],
      media: [{ tracks: [
        { title: 'Rehab', length: 214000, 'artist-credit': [{ name: 'Amy Winehouse' }] },
      ] }],
    };
    assert.deepEqual(flattenTracks(rel), [{ title: 'Rehab', length: 214000 }]);
  });

  it('names a guest, because a featured credit is a different credit', () => {
    const rel = {
      'artist-credit': [{ name: 'Gorillaz' }],
      media: [{ tracks: [
        { title: 'Feel Good Inc.', length: 222000, 'artist-credit': [
          { name: 'Gorillaz', joinphrase: ' feat. ' },
          { name: 'De La Soul' },
        ] },
        { title: 'Dare', length: 244000, 'artist-credit': [{ name: 'Gorillaz' }] },
      ] }],
    };
    assert.deepEqual(flattenTracks(rel), [
      // Join phrases carry their own spacing — nothing is inserted between parts.
      { title: 'Feel Good Inc.', length: 222000, artist: 'Gorillaz feat. De La Soul' },
      { title: 'Dare', length: 244000 },
    ]);
  });

  it('credits the sleeve name, not the database name', () => {
    // `name` is how this record credits the artist; `artist.name` is what
    // MusicBrainz files them under. They differ on a pseudonym, and the sleeve
    // is what someone holding the disc is reading.
    const rel = {
      'artist-credit': [{ name: 'Various Artists' }],
      media: [{ tracks: [
        { title: 'Windowlicker', length: 366000, 'artist-credit': [
          { name: 'AFX', artist: { name: 'Aphex Twin' } },
        ] },
      ] }],
    };
    assert.deepEqual(flattenTracks(rel), [
      { title: 'Windowlicker', length: 366000, artist: 'AFX' },
    ]);
  });

  it('falls back to the recording when the track carries no credit of its own', () => {
    const rel = {
      'artist-credit': [{ name: 'Various Artists' }],
      media: [{ tracks: [
        { title: 'Teenage Riot', recording: { 'artist-credit': [{ name: 'Sonic Youth' }] } },
      ] }],
    };
    assert.deepEqual(flattenTracks(rel), [
      { title: 'Teenage Riot', length: 0, artist: 'Sonic Youth' },
    ]);
  });

  it('says nothing when there is no credit to be had', () => {
    // A release fetched without artist-credits, which is every entry written to
    // the tracklist cache before this shipped. It has to degrade to the old
    // shape rather than to `artist: ''`, so a caller can test `if (t.artist)`
    // and a v3 cache entry read back by mistake still renders as a plain list.
    const rel = { media: [{ tracks: [{ title: 'Untitled 3', length: 100000 }] }] };
    assert.deepEqual(flattenTracks(rel), [{ title: 'Untitled 3', length: 100000 }]);
  });
});


describe('normalizeTitle', () => {
  it('reduces a title to its words', () => {
    assert.equal(normalizeTitle('Back to Black'), 'back to black');
    assert.equal(normalizeTitle('  Sgt. Pepper’s   Lonely Hearts Club Band '),
      'sgt pepper s lonely hearts club band');
    assert.equal(normalizeTitle('4\'33"'), '4 33');
  });

  it('keeps a subtitle distinct — it is a different record', () => {
    assert.notEqual(normalizeTitle('Back to Black: B-Sides'), normalizeTitle('Back to Black'));
    assert.equal(normalizeTitle('Back to Black: B-Sides'), 'back to black b sides');
  });

  it('keeps accented letters, which are letters', () => {
    assert.equal(normalizeTitle('Björk'), 'björk');
  });

  it('is an empty string for nothing at all', () => {
    assert.equal(normalizeTitle(null), '');
    assert.equal(normalizeTitle(undefined), '');
    assert.equal(normalizeTitle(''), '');
  });
});


describe('scoreReleaseGroup', () => {
  // The four things MusicBrainz hands back for Amy Winehouse + "Back to Black",
  // all with top relevance, because relevance is exactly what couldn't tell
  // them apart: it picked whichever sorted first and the detail view showed
  // three tracks for an eleven-track record.
  const album = { title: 'Back to Black', 'primary-type': 'Album', 'first-release-date': '2006-10-27', score: 100 };
  const remixEp = { title: 'Back to Black', 'primary-type': 'EP', 'first-release-date': '2006-12-04', 'secondary-types': ['Remix'], score: 100 };
  const single = { title: 'Back to Black', 'primary-type': 'Single', 'first-release-date': '2007-04-30', score: 100 };
  const bsides = { title: 'Back to Black: B-Sides', 'primary-type': 'EP', 'first-release-date': '2008', 'secondary-types': ['Compilation'], score: 100 };
  const want = normalizeTitle('Back to Black');

  it('picks the album out of the four same-named groups', () => {
    const scores = [album, remixEp, single, bsides].map((rg) => scoreReleaseGroup(rg, want, 2006));
    assert.deepEqual(scores, [251, 156, 130, 39]);
    assert.ok(scores[0] > Math.max(...scores.slice(1)));
  });

  it('still picks the album when the sheet has no year', () => {
    // The year is a tiebreaker, not the decision. This is the case the labels
    // page used to get wrong: with the year left blank it searched releases
    // directly and could fill in the single's three tracks.
    assert.equal(scoreReleaseGroup(album, want, null), 191);
    assert.equal(scoreReleaseGroup(remixEp, want, null), 96);
    assert.equal(scoreReleaseGroup(single, want, null), 91);
    assert.ok(scoreReleaseGroup(album, want, null) > scoreReleaseGroup(single, want, null));
  });

  it('lets a disc that really is an EP win on its title matching exactly', () => {
    // Holding "Back to Black: B-Sides", the album's title no longer matches and
    // the EP's does, which is worth more than the album's type bonus.
    const ep = { title: 'Back to Black: B-Sides', 'primary-type': 'EP', score: 100 };
    const wantEp = normalizeTitle('Back to Black: B-Sides');
    assert.equal(scoreReleaseGroup(album, wantEp, null), 101);
    assert.equal(scoreReleaseGroup(ep, wantEp, null), 121);
  });

  it('prefers the studio record over a live or compilation namesake', () => {
    const live = { ...album, 'secondary-types': ['Live'] };
    assert.equal(scoreReleaseGroup(album, want, 2006) - scoreReleaseGroup(live, want, 2006), 25);
  });

  it('stops counting a year more than seven off', () => {
    // A 2014 group against a 2006 disc contributes nothing either way, rather
    // than going negative and pushing the right record below a wrong one.
    const reissue = { ...album, 'first-release-date': '2014', score: 0 };
    assert.equal(scoreReleaseGroup(reissue, want, 2006), 190);
    assert.equal(scoreReleaseGroup(reissue, want, null), 190);
  });

  it('scores an empty release group at zero', () => {
    assert.equal(scoreReleaseGroup({}, '', null), 0);
  });
});


describe('barcodeQuery', () => {
  it('asks for the barcode with and without a leading zero', () => {
    // A UPC-A and the EAN-13 for the same product differ by that zero, and
    // which one MusicBrainz holds is down to whoever entered it. Both, always,
    // in one request.
    assert.equal(
      barcodeQuery('075678264429'),
      'barcode:075678264429 OR barcode:0075678264429 OR barcode:75678264429'
    );
  });

  it('pads a barcode a spreadsheet has already eaten the zero off', () => {
    // 11 digits is not a barcode length that exists. It's a 12-digit UPC that
    // was read as a number somewhere upstream, which is the single most likely
    // thing to go wrong with this column.
    assert.equal(
      barcodeQuery('75678264429'),
      'barcode:75678264429 OR barcode:075678264429'
    );
  });

  it('never emits a term with nothing after the colon', () => {
    // Stripping the leading zero off "0" leaves an empty string, and a bare
    // `barcode:` doesn't search badly — it fails to parse and takes the request
    // with it. Unreachable through parseBarcode, which is exactly why it's
    // pinned here rather than left to the caller to keep true.
    assert.equal(barcodeQuery('0'), 'barcode:0 OR barcode:00');
  });
});
