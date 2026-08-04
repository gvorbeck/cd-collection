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

  return { APP_IDENTITY, WS_BASE, delay, escapeLucene };
})();
