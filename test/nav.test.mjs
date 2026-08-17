/* ============================================================
   nav.test.mjs — the four navs still say the same thing
   ------------------------------------------------------------
   Run with:  node --test 'test/*.test.mjs'
   (See the note at the top of musicbrainz.test.mjs for why the
   glob is quoted.)

   The site nav is one line of markup copy-pasted into every page,
   each with the same five destinations and the same hardcoded
   spreadsheet URL, differing only in which entry is the current
   page — a <span aria-current="page"> where the others have an <a>.

   That duplication is deliberate and stays. Rendering the nav from
   JS would take the site's only landmark out of the initial HTML,
   which costs first paint and no-JS loads both, and would be the
   first move away from static markup on a site whose whole
   durability argument is that it is static markup.

   What is not fine is the drift. Adding the Wishlist link meant
   editing four files, and nothing would have said a word if one had
   been missed: the page renders, the nav just quietly has four items
   where the others have five, and the only way to notice is to visit
   that page and look. So the duplication keeps its cost and loses
   its risk — checked here, the same answer this repo already gave
   for SHELL_ASSETS in scripts/check-shell-assets.js.

   It asserts that across every *.html in the tree:

     - the nav exists, once, with exactly one current-page entry
     - the labels are the same, in the same order
     - each label points at the same href — where a page's own entry
       is read as pointing at itself
     - the current entry is the one the other pages use to link here
     - every internal href is a file that exists
     - every page in the tree is in the nav

   ============================================================ */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));

const PAGES = readdirSync(ROOT).filter((f) => f.endsWith('.html')).sort();

/**
 * The nav as an ordered list of { label, href } — the current page's entry
 * given the href the other pages use to reach it, so all four normalize to the
 * same list and any difference is real.
 *
 * A regex over the markup rather than a DOM parse, for the same reason the rest
 * of this repo's checks are: there is no dependency to add one, and the nav is
 * a single line with a fixed shape. If that shape ever changes the match fails
 * loudly here rather than going quiet, which is the failure mode to want.
 */
function navItems(page) {
  const html = readFileSync(ROOT + page, 'utf8');
  const nav = html.match(/<nav class="eyebrow"[^>]*>([\s\S]*?)<\/nav>/g) || [];
  assert.equal(nav.length, 1, `${page}: expected exactly one <nav class="eyebrow">, found ${nav.length}`);

  const inner = nav[0].replace(/^<nav[^>]*>/, '').replace(/<\/nav>$/, '');
  const items = [];
  // Either a link or the current-page span. Separators between them are '·'.
  const re = /<a\s+href="([^"]+)"[^>]*>([^<]+)<\/a>|<span\s+aria-current="page"\s*>([^<]+)<\/span>/g;
  let m;
  while ((m = re.exec(inner)) !== null) {
    items.push(m[3] !== undefined
      ? { label: m[3].trim(), href: page, current: true }   // self-href, so pages compare equal
      : { label: m[2].trim(), href: m[1], current: false });
  }
  assert.ok(items.length >= 2, `${page}: parsed ${items.length} nav items — has the markup changed shape?`);
  return items;
}

const NAVS = new Map(PAGES.map((page) => [page, navItems(page)]));
// Whichever page sorts first is the reference; the point is that they agree,
// not which one is right.
const [REFERENCE, REFERENCE_NAV] = [...NAVS][0];

const render = (items) => items.map((i) => `${i.label} → ${i.href}`).join('\n    ');


describe('the site nav', () => {
  it('is on every page in the tree', () => {
    assert.ok(PAGES.length >= 2, `found ${PAGES.length} pages — this check needs at least two to compare`);
    assert.deepEqual([...NAVS.keys()], PAGES);
  });

  for (const page of PAGES) {
    it(`${page} marks exactly one entry as the current page`, () => {
      const current = NAVS.get(page).filter((i) => i.current);
      assert.equal(current.length, 1,
        `${page} has ${current.length} entries with aria-current="page"`);
    });
  }

  for (const page of PAGES) {
    if (page === REFERENCE) continue;
    it(`${page} matches ${REFERENCE}, label for label and href for href`, () => {
      assert.equal(
        render(NAVS.get(page)),
        render(REFERENCE_NAV),
        `the nav in ${page} has drifted from ${REFERENCE}.\n` +
        '  Both are hand-copied; edit every page or none.',
      );
    });
  }

  for (const page of PAGES) {
    it(`${page}'s own entry is the one other pages link here by`, () => {
      const own = NAVS.get(page).find((i) => i.current);
      for (const [other, items] of NAVS) {
        if (other === page) continue;
        const link = items.find((i) => i.href === page);
        assert.ok(link, `${other} has no link to ${page}`);
        assert.equal(link.label, own.label,
          `${other} calls ${page} "${link.label}", but ${page} calls itself "${own.label}"`);
      }
    });
  }

  it('links only to files that exist', () => {
    for (const [page, items] of NAVS) {
      for (const { href, label } of items) {
        if (/^(https?:|mailto:|#)/i.test(href)) continue;
        assert.ok(existsSync(ROOT + href.split(/[?#]/)[0]),
          `${page}: "${label}" points at ${href}, which is not in the tree`);
      }
    }
  });

  // The reverse drift, and the one that actually happened: a new page added and
  // linked from nowhere. A page nobody can reach is not a page.
  it('reaches every page in the tree', () => {
    const linked = new Set(REFERENCE_NAV.map((i) => i.href));
    const orphans = PAGES.filter((p) => !linked.has(p));
    assert.deepEqual(orphans, [],
      `not linked from the nav: ${orphans.join(', ')} — add it to the nav on every page`);
  });
});
