/* ============================================================
   shop.js — the check you run with a case in your hand
   ------------------------------------------------------------
   One box on the wishlist page, and one question: is this thing
   already mine, did I want it, or neither?

   The rest of the site is for browsing; this is for standing in a
   shop with bad signal and thirty seconds before someone else picks
   the record up. So it answers in that order — own it, want it,
   neither — with the shelf position first when there is one, because
   "Book 2, slot 219" is the only part of the answer that saves you
   from buying it twice.

   Everything it needs is already in memory by the time it is wired
   up: the wishlist because this is the wishlist page, and the shelf
   because the ownership stamps needed it anyway. The check itself
   never touches the network, which is the point — see sw.js.
   ============================================================ */
import { el, formatLocation } from './collection.js';
import { lookUp } from './owned.js';


// Nothing here is worth a hit past this many; the answer is meant to be read at
// a glance, and a query loose enough to match twelve records is a query to
// narrow rather than a list to print.
const MAX_SHOWN = 6;

/**
 * Wire the shop check up. No-op on a page without the markup, so index.html and
 * the others can import their way here through app.js without caring.
 *
 * Submit-only, deliberately. Everything else on the site filters as you type,
 * and this one does not: a barcode scanner types thirteen digits one at a time,
 * and a box that answered on every keystroke would spend twelve of them saying
 * "nothing found" — which is the wrong answer, arriving confidently, right up
 * until it isn't. The trailing Enter a scanner sends is what submits the form.
 */
export function wireShopCheck({ shelf, wants }) {
  const form = document.getElementById('shop-form');
  const input = document.getElementById('shop-input');
  const answer = document.getElementById('shop-answer');
  if (!form || !input || !answer) return;

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const query = input.value.trim();
    if (!query) {
      answer.replaceChildren();
      return;
    }
    const result = lookUp(query, shelf, wants);
    answer.replaceChildren(...renderAnswer(query, result));
    // The box keeps its text and its selection so the next scan overwrites it
    // rather than appending to it — a scanner types, it doesn't clear.
    input.select();
  });

  // Clearing the box (the search input's × , or Esc) should clear the verdict
  // with it. A stale answer sitting under an empty field is the one way this
  // control can lie.
  input.addEventListener('input', () => {
    if (!input.value.trim()) answer.replaceChildren();
  });
}

/**
 * The verdict, as nodes.
 *
 * Owning it wins over wanting it — if both are true you already bought it and
 * never crossed it off, and "you own this" is the actionable half. The wishlist
 * hits still come along underneath in that case, because a row that needs
 * deleting is worth being told about while you are looking at the record.
 */
function renderAnswer(query, { shelf, wants }) {
  const out = [];

  if (shelf.length) {
    out.push(verdict('own', `On the shelf${shelf.length > 1 ? ` — ${shelf.length} matches` : ''}`));
    out.push(hitList(shelf, true));
    if (wants.length) {
      out.push(note('Still on the wishlist — worth deleting the row.'));
      out.push(hitList(wants, false));
    }
  } else if (wants.length) {
    out.push(verdict('want', `On the wishlist${wants.length > 1 ? ` — ${wants.length} matches` : ''}`));
    out.push(hitList(wants, false));
  } else {
    out.push(verdict('neither', 'Not on the shelf, not on the list'));
    out.push(note(`Nothing matches “${query}”.`));
  }

  return out;
}

function verdict(kind, text) {
  const p = el('p', 'shop-verdict', text);
  p.dataset.verdict = kind;
  return p;
}

function note(text) {
  return el('p', 'shop-note', text);
}

/**
 * The matching records, one line each.
 *
 * Plain text, not buttons. A shelf hit is a disc from the collection sheet and
 * this page's dialog is wired to the wishlist — opening one would push a
 * `#disc-` hash that this page cannot resolve, and land the visitor on a broken
 * link at the exact moment they need a straight answer. The line carries the
 * shelf position instead, which is all the dialog would have added.
 */
function hitList(discs, withLocation) {
  const ul = el('ul', 'shop-hits');
  ul.setAttribute('role', 'list');
  for (const disc of discs.slice(0, MAX_SHOWN)) {
    const li = el('li');
    if (withLocation) {
      li.append(el('span', 'shop-hit-loc', formatLocation(disc) || 'Uncataloged'));
    }
    li.append(el('span', 'shop-hit-name', `${disc.artist} — ${disc.title}`));
    if (disc.year) li.append(el('span', 'shop-hit-year', disc.year));
    ul.append(li);
  }
  if (discs.length > MAX_SHOWN) {
    ul.append(el('li', 'shop-hit-more', `…and ${discs.length - MAX_SHOWN} more`));
  }
  return ul;
}

/**
 * The wishlist's own stale rows, as one line.
 *
 * The stamps on the cards say this too, but they say it a screen at a time and
 * only to whoever scrolls that far. This is the count — the thing worth knowing
 * on arrival, and the whole of "did I already buy this and forget to cross it
 * off?". Returned rather than announced because app.js joins it into the single
 * string the page's one live region holds; a second announce() would overwrite
 * the first mid-sentence.
 */
export function staleWishlistNote(wants) {
  const owned = wants.filter((w) => w._shelf && w._shelf.status === 'owned');
  if (!owned.length) return '';
  return owned.length === 1
    ? `1 record on this list is already on the shelf: ${owned[0].artist} — ${owned[0].title}.`
    : `${owned.length} records on this list are already on the shelf.`;
}
