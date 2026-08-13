/* ============================================================
   cover.js — generated placeholder covers
   ------------------------------------------------------------
   A lot of discs are home-burned with no art. Rather than an empty
   box, draw a designed cover on a <canvas>: a solid hashed color
   block, the title in bold centered type (auto black/white for
   contrast), and the catalog number as a small archival mark.
   Returns a data URL usable as an <img> src.

   The paper grain these used to carry is a CSS ::after tile on
   .card-cover-wrap and .detail-cover now, not pixels on the canvas.
   Per-pixel random noise is the worst input DEFLATE can be handed:
   the identical 400px cover encoded to 147,418 bytes with the grain
   baked in against 1,435 bytes without it, at roughly 17ms of
   synchronous encode per disc, all of it during the first render
   pass. A repeating tile over the top reads the same. Don't put it
   back — and if you touch the CSS, the dialog needs its own tile:
   the page-wide .grain overlay is position: fixed and never reaches
   inside a modal <dialog>'s top layer, so .detail-cover is not
   covered by it.
   ============================================================ */
import { colorForArtist, hexToRgb, readableTextOn } from './color.js';


/* The exact font shorthands the canvas draws with, hoisted so that fontsReady()
   asks about the same strings the drawing uses. A readiness check naming a face
   the canvas doesn't name is one that always agrees with itself and never with
   the picture. */
const NUMBER_FONT = '700 20px "Space Mono", monospace';
const ARTIST_FONT = '400 18px "Space Mono", monospace';
// Anton at 400, not 700. Every page loads it as
// fonts.googleapis.com/css2?family=Anton&… — no weight axis — and Anton ships a
// single 400 face, so asking for 700 here gets a canvas-synthesized faux-bold
// that no real heading on the page has, and the placeholder came out heavier
// than the type around it. The 400 is deliberate; it is not a missing bold.
const titleFont = (px) => `400 ${px}px "Anton", "Arial Narrow", sans-serif`;
const TITLE_PX = 40;
const TITLE_PX_LONG = 30; // long titles step down so four lines still fit
// The floor for the measured step-down in drawWrappedTitle. Below this the title
// is set smaller than the artist credit under it and the cover stops reading as
// a cover, so a word that still doesn't fit here gets broken instead of shrunk.
const TITLE_PX_MIN = 18;
// The two webfont families named above, spelled as the @font-face rules that
// the Google stylesheet installs spell them.
const WEB_FAMILIES = ['Anton', 'Space Mono'];


export function generatePlaceholderCover(disc) {
  // Cache per disc — a canvas draw plus a PNG encode is not free, and the grid
  // re-renders on every filter change. Keyed on font readiness as well as on
  // having drawn once: a cover laid out in the fallback faces is not the cover
  // being asked for once the real ones have landed, so it gets redrawn rather
  // than handed back. repaintPlaceholders is what makes that happen on screen.
  const ready = fontsReady();
  if (disc._placeholderSrc && disc._placeholderFontsReady === ready) return disc._placeholderSrc;

  const S = 400; // render at 400px square, scaled by CSS
  const canvas = document.createElement('canvas');
  canvas.width = S;
  canvas.height = S;
  const ctx = canvas.getContext('2d');

  // 1. Solid color block, stable per-artist.
  const bgHex = colorForArtist(disc.artist);
  const bgRgb = hexToRgb(bgHex);
  ctx.fillStyle = bgHex;
  ctx.fillRect(0, 0, S, S);

  const textColor = readableTextOn(bgRgb);

  // 2. A thin inner rule frame, archival-card style.
  ctx.strokeStyle = textColor;
  ctx.globalAlpha = 0.5;
  ctx.lineWidth = 2;
  ctx.strokeRect(18, 18, S - 36, S - 36);
  ctx.globalAlpha = 1;

  // 3. Catalog number as a small mark, top-left inside the frame.
  if (disc.numberLabel) {
    ctx.fillStyle = textColor;
    ctx.font = NUMBER_FONT;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText(`#${disc.numberLabel}`, 34, 34);
  }

  // 4. Title, bold and centered, wrapped to fit.
  ctx.fillStyle = textColor;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  drawWrappedTitle(ctx, disc.title.toUpperCase(), S / 2, S / 2, S - 80, 44);

  // 5. Artist, small, under the title area toward the bottom.
  ctx.font = ARTIST_FONT;
  ctx.globalAlpha = 0.85;
  ctx.fillText(truncate(disc.artist, 28), S / 2, S - 44);
  ctx.globalAlpha = 1;

  disc._placeholderSrc = canvas.toDataURL('image/png');
  disc._placeholderFontsReady = ready;
  return disc._placeholderSrc;
}

/**
 * Redraw the placeholders that were drawn before the webfonts arrived, and
 * repoint the images already showing them.
 *
 * Called once from app.js when document.fonts.ready settles — that is the last
 * word on the subject, since by then the stylesheet has either applied or
 * failed for good. Discs already drawn in the right faces are skipped, so the
 * warm-cache case (fonts served from the service worker before the first cover
 * is drawn) does nothing at all rather than re-encoding a few hundred PNGs to
 * produce the identical bytes.
 *
 * The swap matches on the stale data URL instead of walking cards, so every
 * placeholder on the page — grid, list, and the dialog's cover — is repointed
 * without any of them having to know that fonts exist.
 *
 * "On the page" is the limit of it, though: document.images is the document,
 * and render.js keeps a card per disc per view in a reuse map whose off-screen
 * ones aren't in it. A disc filtered out at the instant the fonts landed would
 * otherwise keep its Arial Narrow cover and come back wearing it. So the map is
 * returned rather than applied and forgotten, and app.js hands it to render.js
 * to finish the job on the nodes only that module can reach.
 */
export function repaintPlaceholders(discs) {
  const ready = fontsReady();

  // Stale src → fresh src. The old value has to be read before the redraw,
  // because generatePlaceholderCover overwrites _placeholderSrc in place.
  const swaps = new Map();
  for (const disc of discs) {
    if (!disc._placeholderSrc || disc._placeholderFontsReady === ready) continue;
    const stale = disc._placeholderSrc;
    swaps.set(stale, generatePlaceholderCover(disc));
  }
  if (swaps.size === 0) return swaps;

  for (const img of document.images) {
    const fresh = swaps.get(img.getAttribute('src'));
    if (fresh) img.src = fresh;
  }
  return swaps;
}

/**
 * Whether the covers can be drawn in the type they are designed in.
 *
 * Every text pass above names a webfont, and the CSV can win the race against
 * fonts.gstatic.com: draw too early and a whole session's covers are laid out
 * — measureText-wrapped and all — in Arial Narrow and Courier, then memoized in
 * that state permanently. So the memo is gated on this rather than on having
 * drawn once.
 *
 * Two answers that need care:
 *
 * - No FontFaceSet at all (an old browser) counts as ready. There is nothing to
 *   wait on and nothing that will ever say otherwise, and a cover that never
 *   draws is worse than one in the wrong face.
 * - check() answers "available" for a family it has simply never heard of,
 *   which is exactly what it says in the window before the Google Fonts <link>
 *   has been parsed — long enough for a service-worker-cached CSV to render a
 *   full grid inside it. So the families have to be registered before their
 *   check() means anything. Offline with no cached stylesheet they never are,
 *   which reads as not-ready and stays there: the covers draw immediately in
 *   the fallbacks and keep their memo, since nothing is coming to repaint them.
 */
function fontsReady() {
  if (!document.fonts) return true;

  const registered = new Set();
  // Family names come back quoted in some engines and bare in others.
  document.fonts.forEach((face) => registered.add(face.family.replace(/["']/g, '')));
  if (!WEB_FAMILIES.every((family) => registered.has(family))) return false;

  // Size doesn't enter into whether a face is available, so the title only
  // needs asking about at one of the two sizes it draws at.
  return document.fonts.check(titleFont(TITLE_PX)) &&
    document.fonts.check(NUMBER_FONT) &&
    document.fonts.check(ARTIST_FONT);
}

// Word-wrap a title into up to 4 centered lines around a vertical midpoint.
function drawWrappedTitle(ctx, text, cx, cy, maxWidth, lineHeight) {
  // Choose a font size that scales down for long titles.
  let fontSize = text.length > 22 ? TITLE_PX_LONG : TITLE_PX;
  ctx.font = titleFont(fontSize);

  const words = text.split(/\s+/);

  // Character count is only a proxy for width, and it is wrong for exactly the
  // case that broke this: "BOOGADABOOGADABOOGADA" is 21 characters, one under
  // the threshold above, so it was set at the full 40px — where 21 characters of
  // Anton run about half again as wide as the frame. Wrapping cannot save it
  // either, since the loop below can only break at a space and there isn't one,
  // so the title was drawn straight out through both edges of the canvas.
  // Measure instead of counting, and step down until the longest single word
  // fits the line box. Only titles that would have overflowed move; a step of 1
  // so a word that needs 39px doesn't get set at 30.
  while (fontSize > TITLE_PX_MIN && widestWord(ctx, words) > maxWidth) {
    fontSize -= 1;
    ctx.font = titleFont(fontSize);
  }

  const lines = [];
  let line = '';
  for (const word of words) {
    // Still wider than the box at the floor — a 40-plus-character run with no
    // spaces in it. Break it mid-word rather than reinstate the overflow.
    if (ctx.measureText(word).width > maxWidth) {
      if (line) { lines.push(line); line = ''; }
      lines.push(...breakWord(ctx, word, maxWidth));
      continue;
    }
    const test = line ? `${line} ${word}` : word;
    if (ctx.measureText(test).width > maxWidth && line) {
      lines.push(line);
      line = word;
    } else {
      line = test;
    }
  }
  if (line) lines.push(line);

  const shown = lines.slice(0, 4);
  // Four lines is what fits between the catalog number and the artist credit at
  // the sizes above. A title longer than that is cut without a mark, which is
  // the behaviour this has always had.
  const totalHeight = shown.length * lineHeight;
  let y = cy - totalHeight / 2 + lineHeight / 2;
  for (const l of shown) {
    ctx.fillText(l, cx, y);
    y += lineHeight;
  }
}

/* The width of the longest word, which is the width the title cannot go under.
   Measured at whatever size ctx.font is currently set to, so the caller has to
   set it before asking and again after changing it. */
function widestWord(ctx, words) {
  let widest = 0;
  for (const word of words) widest = Math.max(widest, ctx.measureText(word).width);
  return widest;
}

/* Split a word too wide for the line box into pieces that fit, greedily.
   Character-level, because that is all a canvas offers — fillText has no
   hyphenation and no soft-hyphen handling, so there is nowhere better to break.
   Iterated by code point rather than by index so that an accented title like
   VÉRONIQUE cannot be cut through the middle of a character. */
function breakWord(ctx, word, maxWidth) {
  const pieces = [];
  let piece = '';
  for (const ch of word) {
    if (piece && ctx.measureText(piece + ch).width > maxWidth) {
      pieces.push(piece);
      piece = ch;
    } else {
      piece += ch;
    }
  }
  if (piece) pieces.push(piece);
  return pieces;
}

function truncate(str, max) {
  return str.length > max ? `${str.slice(0, max - 1)}…` : str;
}
