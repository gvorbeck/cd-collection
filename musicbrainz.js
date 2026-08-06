/* ============================================================
   musicbrainz.js — shared MusicBrainz helpers
   ------------------------------------------------------------
   Loaded as a classic <script> BEFORE app.js and the labels page,
   so it publishes a single global `MB`. Both pages talk to the
   MusicBrainz web service — app.js for cover art (release-group +
   Cover Art Archive), labels.html for track listings (release +
   recordings) — and share these primitives. No build step; the
   site is static.
   ============================================================ */
window.MB = (function () {
  // MusicBrainz asks every client to identify itself with a descriptive
  // User-Agent (app name/version + contact). Browsers can't set User-Agent on
  // fetch, so MB reads this from an `app=` query param instead.
  const APP_IDENTITY = 'CDCollection/1.0 ( https://github.com/gvorbeck/cd-collection )';

  // Web-service base. Append '/release' or '/release-group'.
  const WS_BASE = 'https://musicbrainz.org/ws/2';

  function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // Escape characters that are special to MusicBrainz's Lucene query syntax.
  function escapeLucene(str) {
    return str.replace(/[+\-&|!(){}\[\]^"~*?:\\/]/g, '\\$&');
  }

  /* ---------- Rate limiting ----------
     MusicBrainz asks for no more than one request per second per client, and
     "client" means the whole page, not one feature of it. This lives here
     rather than in either caller because both pages hit the same service and
     a throttle each is not a throttle: two independent queues at 1/sec is
     2/sec at the server. Anything that talks to MB goes through this. */

  // Minimum gap between calls (ms). The rule is 1/sec; the extra 100ms is
  // headroom for clock jitter between here and their rate limiter.
  const THROTTLE_MS = 1100;

  let chain = Promise.resolve();
  let lastCall = 0;

  function nowMs() {
    return typeof performance !== 'undefined' ? performance.now() : Date.now();
  }

  /**
   * fetch() a MusicBrainz URL, serialized behind every other MB call with at
   * least THROTTLE_MS between them. Returns the raw Response — callers decide
   * what a non-ok status means to them.
   */
  function throttledFetch(url) {
    const run = async () => {
      const gap = THROTTLE_MS - (nowMs() - lastCall);
      if (gap > 0) await delay(gap);
      lastCall = nowMs();
      return fetch(url, { headers: { Accept: 'application/json' } });
    };
    // Chain so calls run one-at-a-time. A failure in one must not break the
    // chain for the next, so errors are swallowed on the chaining link only —
    // the returned promise still rejects for the caller that made the call.
    const result = chain.then(run, run);
    chain = result.then(() => {}, () => {});
    return result;
  }

  /**
   * Milliseconds → "m:ss", or "h:mm:ss" once it runs past an hour. Blank for a
   * track MusicBrainz has no timing for, so callers can drop it wholesale.
   */
  function formatDuration(ms) {
    if (!ms) return '';
    const total = Math.round(ms / 1000);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const ss = String(total % 60).padStart(2, '0');
    return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
  }

  return {
    APP_IDENTITY, WS_BASE, THROTTLE_MS,
    delay, escapeLucene, throttledFetch, formatDuration,
  };
})();
