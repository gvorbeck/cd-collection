/* ============================================================
   errors.js — the last-resort error reporter
   ------------------------------------------------------------
   Every page here has the same worst failure: it stops halfway
   through starting up and says nothing. The grid pages sit on
   "Loading the collection…" forever, the console has a stack
   nobody is watching, and the deploy that shipped it was green —
   `node --check` parses each file and the tests cover the pure
   helpers, but neither can see a null dereference or a temporal-
   dead-zone ReferenceError at load.

   So: catch what escapes, and turn it into the error state the
   pages already have markup and styling for.

   WHY THIS MODULE INSTALLS ITSELF ON IMPORT
   -----------------------------------------
   A module's imports are evaluated before its own body runs. An
   entry point that called an install() from its body would
   therefore register these handlers *after* every module it
   imports had already been evaluated — which is a whole class of
   failure gone unwatched: anything a module does as it evaluates,
   from a missing element to a bad constant, throws inside exactly
   that window and would leave a page blank with nothing said.

   Hence the side-effect import. Put

       import './errors.js';

   first in an entry point and this file evaluates before anything
   else in the graph, because it depends only on util.js, which
   depends on nothing.

   WHAT IT CANNOT SEE
   ------------------
   A module that 404s or fails to parse never evaluates the graph
   at all, so these handlers are never installed and the capture
   listener below never gets to fire for it. Those two cases are
   the ones CI already owns: scripts/check-shell-assets.js fails
   on a specifier that resolves to a missing file, and `node
   --check` fails on a syntax error. This file covers the class
   neither of them can — the ones that only exist at runtime.
   ============================================================ */
import { $ } from './util.js';


/* One report per page load.

   A page that has broken once tends to break repeatedly: a failed startup
   leaves half-wired handlers behind, and every click into one throws again.
   The first failure is the one with the useful stack and the honest message,
   and rewriting the notice on each subsequent throw only buries it. Later
   errors still reach the console — they are just not allowed to take the
   megaphone. */
let reported = false;

/* Resource errors this reporter has an opinion about.

   A failed <script> or <link> is a page missing a piece of itself. A failed
   <img> is business as usual — cover art comes from a third-party service that
   404s routinely, and render.js and detail.js both listen for exactly that and
   swap in a generated placeholder. Reporting those would turn the normal case
   into an error banner. */
const FATAL_TAGS = new Set(['SCRIPT', 'LINK']);

const MESSAGE = 'Something went wrong while starting this page. Reloading may help.';


/**
 * Where to put the bad news.
 *
 * index.html, wishlist.html and stats.html each ship a #state-msg — the same
 * element that carries "Loading the collection…" and, on a failed load,
 * app.js's own catch message. Reusing it means one error style, one place to
 * look, and no new markup on three of the four pages.
 *
 * labels.html has no such element, because it has nothing to load: the form is
 * in the HTML and the page is usable the moment it parses. There is no loading
 * line to replace, so one is made — an error there still has to be visible, and
 * the class it borrows is already in styles.css, which every page loads.
 */
function noticeBox() {
  const existing = $('state-msg');
  if (existing) return existing;
  const box = document.createElement('div');
  box.id = 'state-msg';
  box.className = 'state-msg';
  // Ahead of the page's own content: an error about startup belongs above the
  // thing that failed to start, not below it where it can be scrolled past.
  const host = document.querySelector('main') || document.body;
  if (host) host.prepend(box);
  return host ? box : null;
}

/**
 * Say it out loud too, where there is somewhere to say it.
 *
 * Written straight into the element rather than going through render.js's
 * announce(). That import would pull the whole render → detail → url → state
 * graph in behind it, and those modules would then evaluate *before* this one —
 * which is the exact ordering this file exists to get in front of. A reporter
 * that can only work once the code it is reporting on has already run is not a
 * reporter.
 *
 * stats.html needs nothing here: its #state-msg is itself a live region, so
 * writing the message into the box has already announced it.
 */
function announceFailure(box, message) {
  const live = $('live-region');
  if (live && live !== box) live.textContent = message;
}

/**
 * Put the page into its error state.
 *
 * Exported because a caller that has caught something itself and knows the page
 * cannot continue should be able to reach the same state without rethrowing
 * into the global handler.
 */
export function reportFatal(message = MESSAGE) {
  if (reported) return;
  reported = true;

  const box = noticeBox();
  if (!box) return;

  /* A page that finished loading keeps what it rendered.

     #state-msg hidden means the entry point got far enough to hide it, which on
     every page that has one is the last thing done on the success path. The
     discs are on screen and usable; a later throw from some click handler is
     real but it is not a reason to replace a working page with an error, and
     the honest report for it is the console entry the caller has already made.

     This is also why `reported` is set above regardless: the decision has been
     taken for this page load either way. */
  if (box.hidden) return;

  box.hidden = false;
  box.classList.add('is-error');
  box.textContent = message;
  announceFailure(box, message);
}

function onErrorEvent(event) {
  // Resource failures arrive here from the capture phase, with the element as
  // the target and no message. Script errors arrive with a message and window
  // as the target.
  const target = event.target;
  const isResource = target && target !== window && target.tagName;
  if (isResource && !FATAL_TAGS.has(target.tagName)) return;

  if (isResource) {
    console.error('Failed to load a page asset:', target.src || target.href || target);
  } else {
    console.error('Uncaught error:', event.error || event.message);
  }
  reportFatal();
}

function onRejection(event) {
  /* The one that would otherwise be completely silent.

     init() in app.js is async and nobody awaits it, so a throw that escapes it
     is an unhandled rejection and nothing else. Same for every .then() in the
     art pipeline and the document.fonts.ready callback. Without this listener
     those fail with no console error at all in some browsers, and no visible
     change in any of them. */
  console.error('Unhandled promise rejection:', event.reason);
  reportFatal();
}

/* Capture phase, so resource errors are seen at all: an <img>, <script> or
   <link> that fails to load fires `error` at the element and the event does not
   bubble, so a listener on window in the bubble phase never runs for it.
   Uncaught exceptions fire at window directly and are caught either way. */
window.addEventListener('error', onErrorEvent, true);
window.addEventListener('unhandledrejection', onRejection);
