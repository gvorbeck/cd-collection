/* ============================================================
   imports.test.mjs — the module graph has no cycles in it
   ------------------------------------------------------------
   Run with:  node --test 'test/*.test.mjs'
   (See the note at the top of musicbrainz.test.mjs for why the
   glob is quoted.)

   There is no bundler here and no type checker, so nothing on the
   way to production ever looks at the shape of this graph. It used
   to have a four-module knot in it — state.js, render.js, detail.js
   and url.js, twelve distinct cycles over nine edges — and it
   worked, in the way that a circular import does: ES modules resolve
   circular references fine as long as every cross-reference happens
   at call time, after all the modules have finished evaluating.

   Which is a condition nobody can see while editing. Hoist one call
   into a top-level `const`, in any of the four, and the page dies at
   load with `Cannot access 'x' before initialization` — a
   temporal-dead-zone error, pointing at a line that is perfectly
   correct in isolation, thrown before a single character renders. No
   warning, no partial page, and nothing in the file you were editing
   to suggest why.

   So the graph being acyclic is not tidiness; it's the property that
   makes that class of failure impossible rather than merely absent.
   This test is what holds it, because it is the only thing that
   will. If it fails, the fix is a direction, not a workaround: find
   the one edge in the reported cycle that points the wrong way and
   invert it — move a shared value down into a leaf both sides can
   read (store.js), or let the lower module register a callback
   instead of importing the higher one (render.js's setCardOpener).
   ============================================================ */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const JS_DIR = fileURLToPath(new URL('../js/', import.meta.url));

/**
 * Every relative specifier a file imports, as bare filenames.
 *
 * Deliberately a regex rather than a real parse: this repo has no parser
 * dependency and adding one to police the graph would be its own kind of
 * fragility. The pattern covers every import form the codebase actually uses —
 * `import x from`, `import {a, b} from` over several lines, `import './x.js'`
 * for side effects, `export ... from` — plus `import('./x.js')` for the dynamic
 * case. Anything it misses shows up as a missing edge, and a missing edge fails
 * open: the risk is a cycle slipping through unseen, not a false alarm. Which
 * is why the last test in this file pins which modules have no imports at all.
 */
function importsOf(source) {
  const found = new Set();
  // Static import/export, with the from-clause optional so a bare side-effect
  // import is caught too. The clause is [^;'"]* rather than [\s\S]*: it may run
  // over newlines, since a braced import list usually does, but it must not
  // cross a statement terminator or a string. An earlier version used [\s\S]*?
  // and quietly mis-parsed `import './errors.js';` — with no `from` of its own
  // to stop at, the match ran on into the NEXT import's, so stats.js and
  // labels.js came back showing an edge they don't have and missing the one
  // they do.
  const re = /(?:^|[\s;}])(?:import|export)\b\s*(?:[^;'"]*\bfrom\s*)?['"]([^'"]+)['"]|(?:^|[^.\w$])import\s*\(\s*['"]([^'"]+)['"]/g;
  let m;
  while ((m = re.exec(stripComments(source))) !== null) {
    const spec = m[1] || m[2];
    if (spec.startsWith('./')) found.add(spec.slice(2));
  }
  return [...found];
}

// Comments are stripped first, or the prose in these files defeats the point:
// several module headers quote an import line while explaining why it is no
// longer there, and render.js's does exactly that for the edge this test
// exists to keep out.
function stripComments(source) {
  // Block comments, line comments, and — so neither eats a quote mark — string
  // and template literals, which are matched and put back unchanged.
  return source.replace(
    /\/\*[\s\S]*?\*\/|\/\/[^\n]*|'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`/g,
    (match) => (match.startsWith('/') ? ' ' : match),
  );
}

// filename → [filenames it imports]
const GRAPH = new Map(
  readdirSync(JS_DIR)
    .filter((f) => f.endsWith('.js'))
    .sort()
    .map((f) => [f, importsOf(readFileSync(JS_DIR + f, 'utf8'))]),
);

/**
 * Find one cycle, if there is one, as the path that closes it.
 * Plain depth-first search with a colouring: an edge back into the current
 * stack is a cycle, an edge into a finished node is not.
 */
function findCycle(graph) {
  const state = new Map();   // file → 'open' while on the stack, 'done' after
  const stack = [];

  const walk = (file) => {
    state.set(file, 'open');
    stack.push(file);
    for (const next of graph.get(file) || []) {
      if (state.get(next) === 'open') {
        // Report from where the cycle actually closes, not from where the
        // search happened to start, so the message names only real edges.
        return [...stack.slice(stack.indexOf(next)), next];
      }
      if (!state.has(next)) {
        const cycle = walk(next);
        if (cycle) return cycle;
      }
    }
    stack.pop();
    state.set(file, 'done');
    return null;
  };

  // From every node, because the graph has several roots (one entry point per
  // page) and a cycle can hide in a component none of them reach.
  for (const file of graph.keys()) {
    if (!state.has(file)) {
      const cycle = walk(file);
      if (cycle) return cycle;
    }
  }
  return null;
}


describe('the module graph', () => {
  it('has no import cycles', () => {
    const cycle = findCycle(GRAPH);
    assert.equal(
      cycle && cycle.join(' → '),
      null,
      cycle
        ? `import cycle: ${cycle.join(' → ')}\n` +
          '  One of those edges points the wrong way. See the header of this file.'
        : '',
    );
  });

  it('imports only files that exist', () => {
    for (const [file, deps] of GRAPH) {
      for (const dep of deps) {
        assert.ok(GRAPH.has(dep), `${file} imports ./${dep}, which is not in js/`);
      }
    }
  });

  // The cycle check above fails open: a file whose imports the regex can't see
  // has no edges, and a node with no edges is never part of a cycle. So pin the
  // shape of what was parsed. If this fails after an ordinary edit, read the
  // number — a module gaining or losing an import is expected and the fix is to
  // update the count; a module dropping to zero edges when it plainly has some
  // means importsOf() has stopped seeing a form this codebase now uses.
  it('parsed an import out of every module that has one', () => {
    const leaves = [...GRAPH].filter(([, deps]) => deps.length === 0).map(([f]) => f).sort();
    assert.deepEqual(leaves, [
      'config.js',    // presentation constants, and nothing else
      'discs.js',     // pure functions over discs — see its header
      'labelDraft.js',// the labels-page handoff, via sessionStorage
      'musicbrainz.js',
      'util.js',
    ], 'the set of modules importing nothing changed');
  });

  // store.js exists to be importable from anywhere without dragging the page in
  // with it, which only holds while it stays a near-leaf. If this fails, the
  // question isn't whether the new import is reasonable — it's whether whatever
  // needed it belongs in store.js at all.
  it('keeps store.js free of everything but the sheet config', () => {
    assert.deepEqual(GRAPH.get('store.js'), ['collection.js']);
  });
});
