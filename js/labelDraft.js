/* ============================================================
   labelDraft.js — the collection → labels handoff
   ------------------------------------------------------------
   "Make label" in the disc dialog sends a release over to
   labels.html with the form already filled in. The two pages are
   separate documents with no shared runtime, so the draft travels
   through sessionStorage rather than the URL: a tracklist is far
   too long to put in a query string, and sessionStorage dies with
   the tab instead of leaving a stale draft to ambush the next
   visit the way localStorage would.

   Read once and cleared on the way out — reloading the labels
   page must not re-fill the form over whatever has been typed
   since. Both halves are failure-tolerant: with storage blocked
   the handoff degrades to an empty form, which is exactly the
   page as it was before this existed.

   The coercion that guards the read lives here too, and is
   exported: the labels page's JSON import faces the same problem
   from a different direction — arbitrary parsed JSON that has to
   become a label or be refused — and two copies of "what counts
   as a label" is one copy too many.
   ============================================================ */

const DRAFT_KEY = 'cdLabelDraft';

// Anything out of storage, as the string a form field can hold.
function str(value) {
  return value == null ? '' : String(value);
}

/** Stash a draft for the labels page to pick up. */
export function saveLabelDraft(draft) {
  try {
    sessionStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
  } catch {
    // Storage blocked or full — the labels page just opens empty.
  }
}

/**
 * Anything already parsed out of JSON, as the shape the form and the print
 * sheet expect — or null when it isn't a label object at all.
 *
 * Every field is coerced rather than trusted: this runs on values that came
 * from storage or from a file someone picked, so a hand-edited or half-written
 * entry shouldn't be able to put `undefined` in a field or throw partway
 * through rendering. Null is kept distinct from "a label with blank fields" so
 * a caller reading a file can tell the two apart and refuse the file.
 */
export function coerceLabel(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return {
    artist: str(value.artist),
    title: str(value.title),
    year: str(value.year),
    tracks: Array.isArray(value.tracks) ? value.tracks.map(str).filter(Boolean) : [],
  };
}

/** Take the pending draft, if there is one, and clear it. */
export function takeLabelDraft() {
  let raw;
  try {
    raw = sessionStorage.getItem(DRAFT_KEY);
    sessionStorage.removeItem(DRAFT_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;

  try {
    return coerceLabel(JSON.parse(raw));
  } catch {
    return null;
  }
}
