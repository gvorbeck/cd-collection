/* ============================================================
   util.js — tiny shared helpers
   ------------------------------------------------------------
   The odds and ends every other module reaches for: an element
   lookup, a media query, a hex test, a CSS-variable read, and the
   localStorage wrapper the two caches share. Nothing here knows
   anything about discs.
   ============================================================ */

// Whether the user prefers reduced motion (checked live, not cached).
export function reducedMotion() {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

// Grab an element by id (short alias).
export const $ = (id) => document.getElementById(id);

// True for a "#rrggbb" string (the only color form we store/blend).
export function isHex6(str) {
  return /^#[0-9a-f]{6}$/i.test(str);
}

// Read a CSS custom property off :root (trimmed). Lets the stylesheet stay the
// single source of truth for shared colors instead of duplicating hexes in JS.
export function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

// Lowercase and strip diacritics, so typing plain ASCII finds accented text:
// "andre" matches "André Messager", "bjork" matches "Björk". NFD splits an
// accented letter into base + combining mark, and the range below drops the
// marks. Applied to both sides of a search comparison — the precomputed
// searchText blob and the query — so the two always agree.
export function foldText(str) {
  return str.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

/* ============================================================
   Persistent caches: localStorage, read and written as JSON
   ============================================================
   Two caches live here — cover art and tracklists — and both want the same
   thing: read a JSON blob at startup, write it back on every update, and never
   let a failure matter. localStorage can be disabled outright (private mode,
   a locked-down profile), full, or holding something a previous version wrote
   that no longer parses. In all three cases the right answer is the same: fall
   back to an in-memory object and carry on with a slower session, not a broken
   one. That's why nothing below rethrows.
*/

/** Parse a stored JSON object, or `{}` if it's missing, corrupt, or blocked. */
export function readStore(key) {
  try {
    const raw = localStorage.getItem(key);
    const parsed = raw ? JSON.parse(raw) : null;
    // A stored array or scalar would break every `cache[k]` read below, so only
    // a real object counts as a hit.
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (err) {
    return {};
  }
}

/** Write a JSON object back. Silent on failure — see the note above. */
export function writeStore(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (err) {
    // Out of quota or unavailable — keep going with the in-memory copy.
  }
}
