#!/usr/bin/env node
/* ============================================================
   make-icons.js — generate the PWA icon PNGs
   ------------------------------------------------------------
   Draws the same flat compact disc the site uses as its logo and
   writes it out at the sizes a manifest wants.

   Run it only when the icon design changes:

       node scripts/make-icons.js

   The generated PNGs ARE committed — the site has no build step
   and GitHub Pages serves the repo as-is, so the files have to be
   in the tree. This script is how you regenerate them, not a
   build stage.

   It writes PNGs by hand (zlib + a CRC table, both from Node's
   standard library) rather than pulling in an image dependency,
   because a static site with zero dependencies is worth keeping.
   ============================================================ */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// Palette, mirroring :root in styles.css.
const PAPER  = [0xf5, 0xed, 0xd6];
const INK    = [0x24, 0x1c, 0x16];
const BRICK  = [0xc8, 0x45, 0x2f];
const MUSTARD= [0xe0, 0xa5, 0x1f];

const OUT_DIR = path.join(__dirname, '..', 'icons');

/**
 * Icon artwork as a function of position.
 * Everything is expressed in fractions of the canvas so one description works
 * at every size. `pad` is the fraction of the canvas kept clear around the
 * disc — a maskable icon needs a generous margin because the platform is
 * allowed to crop it to a circle, a squircle, or anything in between.
 */
function drawIcon(size, { pad = 0.06, background = true } = {}) {
  const px = new Uint8Array(size * size * 4);
  const c = size / 2;
  const rOuter = (size / 2) * (1 - pad * 2);
  const rLabel = rOuter * 0.36;   // the printed label area
  const rHole  = rOuter * 0.13;   // the spindle hole
  const rRing  = rOuter * 0.72;   // a single mustard band across the data area

  // 3x3 supersampling per pixel: cheap, and enough to keep the circles from
  // looking like staircases at 192px.
  const S = 3;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < S; sy++) {
        for (let sx = 0; sx < S; sx++) {
          const px0 = x + (sx + 0.5) / S;
          const py0 = y + (sy + 0.5) / S;
          const d = Math.hypot(px0 - c, py0 - c);
          const sample = colorAt(d, { rOuter, rLabel, rHole, rRing, background });
          r += sample[0]; g += sample[1]; b += sample[2]; a += sample[3];
        }
      }
      const n = S * S;
      const i = (y * size + x) * 4;
      px[i]     = Math.round(r / n);
      px[i + 1] = Math.round(g / n);
      px[i + 2] = Math.round(b / n);
      px[i + 3] = Math.round(a / n);
    }
  }
  return px;
}

// The icon, as a single radial function: what color sits `d` px from center.
function colorAt(d, { rOuter, rLabel, rHole, rRing, background }) {
  const bg = background ? [...PAPER, 255] : [0, 0, 0, 0];
  if (d > rOuter) return bg;
  if (d < rHole) return bg;                                   // spindle hole
  if (d < rLabel) return [...BRICK, 255];                     // brick label
  if (d > rRing - rOuter * 0.06 && d < rRing) return [...MUSTARD, 255]; // band
  return [...INK, 255];                                       // data surface
}

/* ---------- Minimal PNG encoder ---------- */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crc]);
}

function encodePng(pixels, size) {
  // Each scanline is prefixed with a filter-type byte; 0 means "no filter",
  // which costs a little size and saves a lot of code.
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0;
    Buffer.from(pixels.buffer, y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // color type: RGBA
  ihdr[10] = 0;  // deflate
  ihdr[11] = 0;  // adaptive filtering
  ihdr[12] = 0;  // no interlace

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), // signature
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ---------- The scalable version ---------- */

// The same artwork as SVG, for browsers that would rather scale than sample.
function svgIcon() {
  const hex = (c) => `#${c.map((n) => n.toString(16).padStart(2, '0')).join('')}`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" role="img" aria-label="CD Collection">
  <rect width="100" height="100" fill="${hex(PAPER)}"/>
  <circle cx="50" cy="50" r="44" fill="${hex(INK)}"/>
  <circle cx="50" cy="50" r="31.7" fill="none" stroke="${hex(MUSTARD)}" stroke-width="2.6"/>
  <circle cx="50" cy="50" r="15.8" fill="${hex(BRICK)}"/>
  <circle cx="50" cy="50" r="5.7" fill="${hex(PAPER)}"/>
</svg>
`;
}

/* ---------- Write everything ---------- */

const TARGETS = [
  // Standard icons: a small margin, since these are shown as-drawn.
  { file: 'icon-192.png', size: 192, opts: { pad: 0.06 } },
  { file: 'icon-512.png', size: 512, opts: { pad: 0.06 } },
  // Apple's home-screen icon has no transparency and gets rounded by iOS.
  { file: 'icon-180.png', size: 180, opts: { pad: 0.08 } },
  // Maskable: the platform may crop up to 20% off each edge, so the disc has
  // to sit well inside the safe zone.
  { file: 'icon-maskable-512.png', size: 512, opts: { pad: 0.2 } },
];

fs.mkdirSync(OUT_DIR, { recursive: true });

for (const { file, size, opts } of TARGETS) {
  const png = encodePng(drawIcon(size, opts), size);
  fs.writeFileSync(path.join(OUT_DIR, file), png);
  console.log(`wrote icons/${file} (${size}×${size}, ${png.length} bytes)`);
}

fs.writeFileSync(path.join(OUT_DIR, 'icon.svg'), svgIcon());
console.log('wrote icons/icon.svg');
