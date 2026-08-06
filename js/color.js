/* ============================================================
   color.js — hashing, brightness, cover sampling
   ------------------------------------------------------------
   Every color the page derives rather than declares: the per-artist
   placeholder hue, the black-or-white text choice on top of it, the
   dominant color pulled off a loaded cover, and the paper blend the
   detail dialog tints itself with.
   ============================================================ */
import { CONFIG } from './config.js';
import { isHex6 } from './util.js';


// Deterministic string hash (djb2-ish). Same input → same number.
function hashString(str) {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash + str.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

// Pick a stable palette color for an artist name.
export function colorForArtist(artist) {
  const palette = CONFIG.PLACEHOLDER_PALETTE;
  return palette[hashString(artist) % palette.length];
}

// Parse "#rrggbb" → {r,g,b}.
export function hexToRgb(hex) {
  const h = hex.replace('#', '');
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16),
  };
}

// Perceived brightness (0–255). Used to choose black vs white text.
function brightness({ r, g, b }) {
  return (r * 299 + g * 587 + b * 114) / 1000;
}

// Given a background color, return readable text color (black or white).
export function readableTextOn(rgb) {
  return brightness(rgb) > 140 ? '#1a1a1a' : '#ffffff';
}

/**
 * Sample the dominant color from a loaded cover image.
 * We draw it small onto a hidden canvas and average the pixels, skipping
 * near-white and near-black pixels (which tend to be borders/letterboxing)
 * and weighting toward more saturated pixels so the tint stays lively.
 * Requires the image to be CORS-readable (crossOrigin="anonymous").
 * Returns an "#rrggbb" string, or null if the canvas can't be read.
 */
export function sampleDominantColor(img) {
  try {
    const size = 16; // tiny is plenty for an average
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, size, size);

    const { data } = ctx.getImageData(0, 0, size, size);
    let r = 0, g = 0, b = 0, weightTotal = 0;

    for (let i = 0; i < data.length; i += 4) {
      const pr = data[i], pg = data[i + 1], pb = data[i + 2], pa = data[i + 3];
      if (pa < 125) continue; // skip transparent pixels

      const max = Math.max(pr, pg, pb);
      const min = Math.min(pr, pg, pb);
      // Skip near-white and near-black — usually background, not the "color".
      if (max > 245 && min > 245) continue;
      if (max < 12) continue;

      // Weight by saturation so vivid pixels count more than muddy ones.
      const saturation = max === 0 ? 0 : (max - min) / max;
      const weight = 1 + saturation * 2;

      r += pr * weight;
      g += pg * weight;
      b += pb * weight;
      weightTotal += weight;
    }

    if (weightTotal === 0) return null; // nothing usable

    r = Math.round(r / weightTotal);
    g = Math.round(g / weightTotal);
    b = Math.round(b / weightTotal);
    return rgbToHex(r, g, b);
  } catch (err) {
    // Tainted canvas or any other failure → caller falls back to neutral.
    return null;
  }
}

function rgbToHex(r, g, b) {
  const h = (n) => n.toString(16).padStart(2, '0');
  return `#${h(r)}${h(g)}${h(b)}`;
}

// Guard against a non-hex color slipping into hexToRgb.
export function safeHex(hex) {
  return isHex6(hex) ? hex : CONFIG.NEUTRAL_SHADOW;
}

// Mix a color with the paper base at `amount` (0–1), returning an opaque
// "rgb(...)" string. Used for the detail dialog's solid cover-derived tint.
// Seeded from --paper (#f5edd6) and overwritten from that CSS var at startup
// (hydrateThemeConstants), so the stylesheet stays the single source of truth.
let PAPER_RGB = { r: 245, g: 237, b: 214 };
export function blendWithPaper(rgb, amount) {
  const mix = (c, p) => Math.round(c * amount + p * (1 - amount));
  return `rgb(${mix(rgb.r, PAPER_RGB.r)}, ${mix(rgb.g, PAPER_RGB.g)}, ${mix(rgb.b, PAPER_RGB.b)})`;
}

// An imported binding is read-only, so startup can't assign PAPER_RGB from the
// outside; it hands the hydrated value in here instead.
export function setPaperRgb(rgb) {
  PAPER_RGB = rgb;
}
