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
 * Take the pending draft, if there is one, and clear it.
 * Everything is coerced to the shape the form expects: this is read back out
 * of storage, so a hand-edited or half-written value shouldn't be able to put
 * `undefined` in a field or throw before the page finishes rendering.
 */
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
    const draft = JSON.parse(raw);
    if (!draft || typeof draft !== 'object' || Array.isArray(draft)) return null;
    return {
      artist: str(draft.artist),
      title: str(draft.title),
      year: str(draft.year),
      tracks: Array.isArray(draft.tracks) ? draft.tracks.map(str).filter(Boolean) : [],
    };
  } catch {
    return null;
  }
}
