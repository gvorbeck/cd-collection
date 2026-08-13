/* ============================================================
   util.js — tiny shared helpers
   ------------------------------------------------------------
   The odds and ends every other module reaches for: an element
   lookup, a media query, a hex test, a CSS-variable read, the text
   folding both searches use, a focus-safe way to hide something, and
   the localStorage wrapper the two caches share. Nothing here knows
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

/**
 * Hide an element without dropping keyboard focus on the floor.
 *
 * The UA stylesheet's [hidden] rule is `display: none`, and hiding the element
 * that currently holds focus hands focus back to <body>: the next Tab starts
 * over at the top of the document, so a keyboard user who pressed a control
 * halfway down the page is stranded there with no way back short of tabbing
 * through everything above it. A control that hides itself the moment it works
 * ("Clear filters") does this every single time it's used.
 *
 * So: if the element (or anything inside it) is what's focused, move focus to
 * `fallback` first. preventScroll because the fallback is a nearby readout, not
 * somewhere the page should jump to — the point is where focus lands, not where
 * the viewport does.
 *
 * Returns true only when focus actually moved, so a caller that also announces
 * something can tell whether the fallback is about to be read out anyway (a
 * focused tabindex="-1" element is announced by most screen readers) and skip
 * saying the same thing twice. Checked against activeElement rather than
 * assumed: an element that isn't focusable — a <p> that lost its tabindex="-1"
 * in some future markup edit — swallows focus() without complaining, and a
 * caller that stayed quiet on our say-so would then say nothing at all.
 */
export function hideWithoutLosingFocus(elem, fallback) {
  if (!elem) return false;
  const held = !!fallback && elem.contains(document.activeElement);
  if (held) fallback.focus({ preventScroll: true });
  elem.hidden = true;
  return held && document.activeElement === fallback;
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
