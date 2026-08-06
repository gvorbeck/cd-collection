/* ============================================================
   cover.js — generated placeholder covers
   ------------------------------------------------------------
   A lot of discs are home-burned with no art. Rather than an empty
   box, draw a designed cover on a <canvas>: a solid hashed color
   block, the title in bold centered type (auto black/white for
   contrast), the catalog number as a small archival mark, and the
   same paper grain as everything else. Returns a data URL usable
   as an <img> src.
   ============================================================ */
import { colorForArtist, hexToRgb, readableTextOn } from './color.js';


export function generatePlaceholderCover(disc) {
  // Cache per disc — the canvas + per-pixel grain is not free, and the grid
  // re-renders on every filter change.
  if (disc._placeholderSrc) return disc._placeholderSrc;

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
    ctx.font = '700 20px "Space Mono", monospace';
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
  ctx.font = '400 18px "Space Mono", monospace';
  ctx.globalAlpha = 0.85;
  ctx.fillText(truncate(disc.artist, 28), S / 2, S - 44);
  ctx.globalAlpha = 1;

  // 6. Grain overlay so it matches the paper texture of the page.
  applyGrain(ctx, S, S);

  disc._placeholderSrc = canvas.toDataURL('image/png');
  return disc._placeholderSrc;
}

// Word-wrap a title into up to 4 centered lines around a vertical midpoint.
function drawWrappedTitle(ctx, text, cx, cy, maxWidth, lineHeight) {
  // Choose a font size that scales down for long titles.
  let fontSize = text.length > 22 ? 30 : 40;
  ctx.font = `700 ${fontSize}px "Anton", "Arial Narrow", sans-serif`;

  const words = text.split(/\s+/);
  const lines = [];
  let line = '';
  for (const word of words) {
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
  const totalHeight = shown.length * lineHeight;
  let y = cy - totalHeight / 2 + lineHeight / 2;
  for (const l of shown) {
    ctx.fillText(l, cx, y);
    y += lineHeight;
  }
}

function truncate(str, max) {
  return str.length > max ? `${str.slice(0, max - 1)}…` : str;
}

// Sprinkle faint monochrome noise over a canvas region for a printed feel.
function applyGrain(ctx, w, h) {
  const grain = ctx.getImageData(0, 0, w, h);
  const d = grain.data;
  for (let i = 0; i < d.length; i += 4) {
    // small random +/- nudge to each channel
    const n = (Math.random() - 0.5) * 26;
    d[i]     = clamp8(d[i] + n);
    d[i + 1] = clamp8(d[i + 1] + n);
    d[i + 2] = clamp8(d[i + 2] + n);
  }
  ctx.putImageData(grain, 0, 0);
}

function clamp8(n) {
  return n < 0 ? 0 : n > 255 ? 255 : n;
}
