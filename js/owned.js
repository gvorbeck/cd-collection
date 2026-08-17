/* ============================================================
   owned.js — matching a wanted record against the shelf
   ------------------------------------------------------------
   One question, asked in two places: is this already in the books?

   The wishlist page asks it of every row it renders, so a record
   bought months ago and never crossed off says so instead of sitting
   there looking wanted. The shop check (see wishlist.html) asks it of
   whatever gets typed into the box, which is the same question with
   the answer read out loud.

   Everything here is string matching against a spreadsheet two people
   typed into at different times, so it is deliberately forgiving in
   the ways that don't change the answer — case, accents, punctuation,
   a leading "The" — and deliberately strict in the one that does: two
   different albums by one artist are two different records.
   ============================================================ */
import { foldText } from './util.js';
import { formatLocation } from './collection.js';


/**
 * Reduce a name to what two people typing it on different days would agree on:
 * folded to lowercase without accents, stripped of a leading article, with
 * every run of punctuation and whitespace flattened to a single space.
 *
 * The article goes because the sheet has "The Clash" and the wishlist had
 * "clash"; the punctuation goes because "Where Have All the Merrymakers Gone?"
 * is the same album with or without the question mark, and because a sheet
 * written over years is not consistent about "Vol. 2" versus "Vol 2".
 *
 * Punctuation first, article second, and the order is load-bearing: foldText
 * only handles case and accents, so stripping the article off the raw fold
 * needs the article to be followed by a literal space. "(The) Clash" and
 * "The-Dandy Warhols" aren't, and they would keep their article while the
 * shelf's spelling of the same band lost it — two keys, no match, and a record
 * you own showing up as one you want.
 */
export function matchKey(str) {
  const flat = foldText(String(str == null ? '' : str))
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  return flat.replace(/^(the|a|an)\s+/, '');
}

/**
 * Index a set of discs by artist for repeated lookups.
 * Built once per page load and handed to every match() call, rather than
 * re-scanning a few hundred discs for each of them.
 */
export function indexByArtist(discs) {
  const byArtist = new Map();
  for (const disc of discs) {
    const key = matchKey(disc.artist);
    if (!key) continue;
    const bucket = byArtist.get(key);
    if (bucket) bucket.push(disc);
    else byArtist.set(key, [disc]);
  }
  return byArtist;
}

/**
 * What the shelf has to say about one wanted record.
 *
 *   { status: 'owned',   discs: [...] }  this exact release is in the books
 *   { status: 'artist',  discs: [...] }  the artist is, but not this release
 *   { status: 'wanted',  discs: [] }     nothing by them on the shelf
 *
 * The three are genuinely different answers in a record shop and are worth
 * keeping apart. "owned" means put it back. "artist" is the interesting one:
 * a row with no title at all ("any MxPx album") can only ever reach it, and so
 * can a row naming an album whose artist is already represented — in both cases
 * the honest report is *what* is already there, so the discs come back with it.
 *
 * A wishlist row with no Title is never 'owned', however many of that artist's
 * records are shelved: "any album by X" is not a thing that can be crossed off,
 * only informed. That is a judgement, not a bug — see the wishlist page, which
 * renders the two states differently for exactly this reason.
 */
export function matchOnShelf(want, byArtist) {
  const artistKey = matchKey(want.artist);
  const shelved = (artistKey && byArtist.get(artistKey)) || [];
  if (!shelved.length) return { status: 'wanted', discs: [] };

  // rawTitle, not title: `title` has already had the source's fallback applied,
  // so a blank cell on the wishlist reads as the literal words "Any release" —
  // which would then go looking for an album by that name and never find one.
  const titleKey = matchKey(want.rawTitle);
  if (!titleKey) return { status: 'artist', discs: shelved };

  const exact = shelved.filter((disc) => matchKey(disc.title) === titleKey);
  return exact.length
    ? { status: 'owned', discs: exact }
    : { status: 'artist', discs: shelved };
}

/**
 * Attach the shelf's answer to every wanted record, in place.
 *
 * On the disc object rather than in a side table because that is where every
 * consumer already is: render.js is handed a disc and builds a card, state.js
 * is handed a disc and filters it, and neither has any way to reach a map
 * living in this module. `_shelf` is underscored to match `_resolvedArt` and
 * `_cardEl` — derived at runtime, never exported, never written back to a
 * sheet.
 */
export function markOwnership(wants, shelfDiscs) {
  const byArtist = indexByArtist(shelfDiscs);
  for (const want of wants) {
    want._shelf = matchOnShelf(want, byArtist);
  }
  return wants;
}

/* ----------------------------------------------------------
   Saying it out loud
   ----------------------------------------------------------
   Three states, three vocabularies, one set of words for each — so
   the card, the row and the dialog can't drift into describing the
   same record differently. Every one of these returns '' for a disc
   with no verdict attached (i.e. anything on the shelf page), which
   is what lets the shared renderers call them unconditionally. */

/** Terse, for a card's corner tag: "On the shelf" / "B2 · #219" / "". */
export function shelfTag(disc) {
  const shelf = disc._shelf;
  if (!shelf) return '';
  if (shelf.status === 'owned') {
    // One copy names its slot, several just say so — a card corner is not the
    // place for a list, and the dialog spells it out for anyone who wants it.
    const loc = shelf.discs.length === 1 ? formatLocation(shelf.discs[0]) : '';
    return loc || 'On the shelf';
  }
  if (shelf.status === 'artist') {
    return `${shelf.discs.length} on the shelf`;
  }
  return '';
}

/** Verbose, for the dialog's location slot. */
export function shelfLine(disc) {
  const shelf = disc._shelf;
  if (!shelf) return '';

  if (shelf.status === 'owned') {
    const where = shelf.discs
      .map((d) => formatLocation(d, { verbose: true }))
      .filter(Boolean)
      .join(' · ');
    return where ? `Already on the shelf — ${where}` : 'Already on the shelf';
  }

  if (shelf.status === 'artist') {
    const n = shelf.discs.length;
    // Named rather than counted when there are few enough to read, because in a
    // shop the useful form of "you have 2 of these" is which 2.
    const titles = n <= 3 ? shelf.discs.map((d) => d.title).join(', ') : '';
    return titles
      ? `Not on the shelf — but ${disc.artist} is: ${titles}`
      : `Not on the shelf — but ${n} other ${noun(n)} by ${disc.artist} ${n === 1 ? 'is' : 'are'}`;
  }

  return `Not on the shelf — nothing by ${disc.artist} is`;
}

// Local, because owned.js is about the shelf and the shelf's word is "disc"
// regardless of which page is asking. collection.js's noun() answers for the
// page, which is the wishlist's word here and would read "2 other records by
// MxPx are on the shelf" about discs that are, in fact, on the shelf.
function noun(count) {
  return count === 1 ? 'disc' : 'discs';
}

/**
 * Answer the shop question for a typed query: a barcode, or an artist/title.
 *
 * Barcodes first and exactly, because that is the one input with no ambiguity
 * in it — the digits off the back of the case name a single pressing, and the
 * whole reason the Barcode column exists is that "Greatest Hits" does not. A
 * query that is all digits is only ever tried as a barcode; falling through to
 * a text search on a failed scan would answer a question nobody asked, and in
 * a shop a confident wrong answer is worse than "not found".
 *
 * Everything else is folded-substring matched against the same precomputed
 * blob the search box uses, so it finds a record by artist, title, tag, note or
 * catalog number, and all the terms have to be in there somewhere.
 *
 * Returns { shelf: [...], wants: [...] } — both lists, because "you own it" and
 * "you wanted it" are not exclusive and the pair of them is the actual answer.
 */
export function lookUp(query, shelfDiscs, wantDiscs) {
  const text = String(query == null ? '' : query).trim();
  if (!text) return { shelf: [], wants: [] };

  const digits = text.replace(/[\s\-–—]/g, '');
  if (/^\d{8,14}$/.test(digits)) {
    const key = gtinKey(digits);
    const sameCode = (d) => !!d.barcode && gtinKey(d.barcode) === key;
    return {
      shelf: shelfDiscs.filter(sameCode),
      // The wishlist can carry barcodes too — a pressing seen once and noted
      // down — so it is asked the same question rather than skipped.
      wants: wantDiscs.filter(sameCode),
    };
  }

  const terms = foldText(text).split(/\s+/).filter(Boolean);
  const hit = (d) => terms.every((term) => d.searchText.includes(term));
  return { shelf: shelfDiscs.filter(hit), wants: wantDiscs.filter(hit) };
}

/**
 * A barcode reduced to what two scans of the same disc agree on.
 *
 * UPC-A and EAN-13 are the same number written with a different amount of
 * padding: a US CD stamped 075678264429 comes back off a phone scanner as
 * 0075678264429 and out of MusicBrainz as either. Compared as strings those are
 * two different records, and the shop check says "not on the shelf" about a
 * disc that is sitting in book two — the one wrong answer this whole feature
 * exists to prevent. GS1 reconciles them by padding everything to a 14-digit
 * GTIN; dropping the padding instead reaches the same comparison without having
 * to know how wide the field is meant to be.
 *
 * '' for a blank cell, and the caller checks for that before comparing — the
 * sheet's Barcode column is mostly empty, and a rule that let '' equal '' would
 * have one unbarcoded scan match every unbarcoded row on the shelf.
 */
function gtinKey(digits) {
  return String(digits == null ? '' : digits).replace(/^0+/, '');
}
