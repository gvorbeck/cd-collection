#!/usr/bin/env node
/* ============================================================
   snapshot.js — freeze the published sheets into data/
   ------------------------------------------------------------
   The collection lives in exactly one place: the Google Sheet
   named by CONFIG.SOURCES in js/collection.js. Nothing in this
   repo has ever held a copy of it, and the service worker only
   has one after a successful *online* fetch — so a fresh install
   opened for the first time with no signal shows "Could not load
   the collection", in the record shop the offline support exists
   for. sample.csv doesn't help: it is fiction (Cake, Miles Davis,
   placeholder art) and always was.

   This writes the live sheets into the tree:

       node scripts/snapshot.js                       # every source
       node scripts/snapshot.js collection            # just the one
       node scripts/snapshot.js wishlist <url-or-path>  # override its source

   One sheet, two published tabs, one entry in CONFIG.SOURCES each;
   this walks them and writes each one's SNAPSHOT_URL. Naming a
   source is how you refresh only the tab you edited, and how you
   point the override at the right file — with no name, a lone
   argument would be ambiguous about which snapshot it overwrites,
   so the override form requires both.

   The snapshots ARE committed, for the same reason the icons are:
   there is no build step and GitHub Pages serves the repo as-is,
   so a file has to be in the tree to be servable. This script is
   how you refresh them, not a build stage. Re-run it when a sheet
   has changed enough that an offline visitor would notice.

   Node's standard library only, and CommonJS, to match
   make-icons.js — the site has no package.json, and adding one
   with {"type":"module"} would break both scripts.
   ============================================================ */

const fs = require('fs');
const path = require('path');
const { fileURLToPath } = require('url');

const ROOT = path.join(__dirname, '..');
const COLLECTION_JS = path.join(ROOT, 'js', 'collection.js');

/* ---------- Where the sheet is, and what its columns are called ---------- */

/**
 * Read the sources and the two identity columns out of js/collection.js.
 *
 * The pages read them from CONFIG; so does this. A second copy of a URL here
 * would work perfectly right up until a tab is republished at a new one and
 * only one of the two is edited — at which point the snapshot silently freezes
 * a sheet nobody is editing any more.
 *
 * Read with regexes rather than by importing: js/collection.js is an ES module
 * that imports ./util.js and expects PapaParse on `window`, and this script is
 * CommonJS with no package.json to change that. Parsing the source is the
 * cheaper half of that trade — the shapes it looks for are the ones CONFIG has
 * had all along, and every one of them throws by name if CONFIG is reshaped.
 */
function readConfig() {
  const src = fs.readFileSync(COLLECTION_JS, 'utf8');

  // Scope the column lookup to the COLUMNS block. FALLBACKS declares `artist`
  // as well, and picking that up would leave the guard below checking the
  // header row for "Various Artists".
  const columns = src.match(/COLUMNS:\s*\{([^}]*)\}/);
  if (!columns) throw new Error('Could not find CONFIG.COLUMNS in js/collection.js — has CONFIG been reshaped?');

  return {
    sources: readSources(src),
    artist: matchString(columns[1], 'artist', 'CONFIG.COLUMNS'),
    title:  matchString(columns[1], 'title',  'CONFIG.COLUMNS'),
  };
}

/**
 * The entries of CONFIG.SOURCES, in the order they are declared.
 *
 * Order matters only for the output: with no arguments this writes them all,
 * and the collection going first keeps the familiar line at the top of the log.
 */
function readSources(src) {
  const block = src.match(/SOURCES:\s*\{([\s\S]*?)\n  \},/);
  if (!block) throw new Error('Could not find CONFIG.SOURCES in js/collection.js — has CONFIG been reshaped?');

  const sources = new Map();
  const entry = /(\w+):\s*\{([\s\S]*?)\n    \},/g;
  let match;
  while ((match = entry.exec(block[1]))) {
    const [, name, body] = match;
    sources.set(name, {
      name,
      csvUrl: matchString(body, 'CSV_URL', `CONFIG.SOURCES.${name}`),
      out: matchString(body, 'SNAPSHOT_URL', `CONFIG.SOURCES.${name}`),
    });
  }
  if (!sources.size) throw new Error('CONFIG.SOURCES is empty in js/collection.js — nothing to snapshot.');
  return sources;
}

// Pull `key: 'value'` out of a chunk of source. Single quotes only, which is
// the house style everywhere in js/.
function matchString(src, key, where) {
  const match = src.match(new RegExp(`\\b${key}\\s*:\\s*'([^']*)'`));
  if (!match) throw new Error(`Could not find ${key} in ${where} — has CONFIG been reshaped?`);
  return match[1];
}

/* ---------- Reading the source ---------- */

/**
 * Fetch the sheet — or read a local file, if that's what was handed in.
 *
 * fetch() refuses file: URLs, and pointing this at a saved CSV (or at a
 * deliberately broken one) is how you exercise the guard below without a
 * network, so anything that isn't http(s) is read off disk.
 */
async function readSource(source) {
  if (/^https?:/i.test(source)) {
    // The published-sheet URL redirects before it serves anything, so follow.
    const response = await fetch(source, { redirect: 'follow' });
    if (!response.ok) {
      throw new Error(`responded ${response.status} ${response.statusText}`);
    }
    return response.text();
  }
  return fs.readFileSync(source.startsWith('file:') ? fileURLToPath(source) : source, 'utf8');
}

/* ---------- Write it ---------- */

async function main() {
  const config = readConfig();
  const [name, override] = process.argv.slice(2);

  if (name && !config.sources.has(name)) {
    console.error(`unknown source "${name}".`);
    console.error(`  known sources: ${[...config.sources.keys()].join(', ')}`);
    console.error('  nothing was written.');
    process.exitCode = 1;
    return;
  }

  const targets = name ? [config.sources.get(name)] : [...config.sources.values()];

  // Each target reports its own failure and sets the exit code, and the loop
  // carries on: a wishlist tab that has been unpublished is no reason to skip
  // refreshing the collection, which is the snapshot that actually matters in
  // a shop. The exit code still tells CI something went wrong.
  for (const target of targets) {
    await snapshot(target, override || target.csvUrl, config);
  }
}

async function snapshot(target, source, config) {
  const outFile = path.join(ROOT, target.out);

  let text;
  try {
    text = await readSource(source);
  } catch (err) {
    console.error(`could not read ${source}`);
    console.error(`  ${err.message}`);
    console.error(`  nothing was written; any existing ${target.out} was left alone.`);
    process.exitCode = 1;
    return;
  }

  const header = text.split(/\r?\n/, 1)[0];

  /* ---- The most important line in this script. --------------------------
     A sheet that has been unpublished, or a URL that has picked up a login
     redirect, answers 200 with a page of HTML. Writing that over the snapshot
     would replace the entire collection with an error page — and the service
     worker would then dutifully precache the error page as the offline copy.
     So the header row has to name the two columns a disc's identity is made
     of before a single byte is written.

     assertExpectedHeaders() in js/collection.js throws when *neither* Artist
     nor Title is present; this demands *both*. It can afford to be stricter:
     that guard runs on every page load and only has to notice a misconfigured
     sheet, while this one gets a single shot at not destroying the only copy
     of the collection in the repo. ------------------------------------- */
  if (!header.includes(config.artist) || !header.includes(config.title)) {
    console.error(`refusing to write ${target.out}: ${source} did not return the sheet.`);
    console.error(`  expected the header row to name both "${config.artist}" and "${config.title}".`);
    console.error(`  first line was: ${header.trim().slice(0, 120) || '(empty)'}`);
    console.error(fs.existsSync(outFile)
      ? '  the existing snapshot was left untouched.'
      : '  nothing was written.');
    process.exitCode = 1;
    return;
  }

  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, text);

  // Lines, not discs: a quoted Notes cell is allowed to contain a newline, so
  // this over-counts on a chatty sheet. It's a sanity check ("did I just write
  // three rows?"), not a statistic.
  const lines = text.trim().split(/\r?\n/).length - 1;
  console.log(`wrote ${target.out} (${Buffer.byteLength(text)} bytes, ${lines} lines after the header)`);
  console.log(`  source: ${source}`);
  console.log('  commit it — the offline shell precaches this file (see SHELL_ASSETS in sw.js).');
}

main().catch((err) => {
  console.error(err.message);
  process.exitCode = 1;
});
