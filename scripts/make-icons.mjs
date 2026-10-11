// Draws the Grid Zero app icon and writes PNGs for the web app manifest and iOS home screen.
// Run with: node scripts/make-icons.mjs
import { writeFileSync, mkdirSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const BG = [11, 13, 16];
const RED = [255, 45, 61];
const WHITE = [242, 244, 247];

/** Icon design in a 0..1 square: a tilted red "0" ring with a gap, and three speed lines trailing it. */
function shade(x, y, maskable) {
  // Maskable icons get cropped to a circle, so the artwork shrinks into the safe zone.
  const s = maskable ? 0.78 : 0.92;
  const u = (x - 0.5) / s + 0.5;
  const v = (y - 0.5) / s + 0.5;

  // Italic slant.
  const cx = 0.6;
  const cy = 0.5;
  const dx = u - cx + (v - cy) * 0.22;
  const dy = v - cy;
  const rx = 0.2;
  const ry = 0.29;
  const r = Math.hypot(dx / rx, dy / ry);
  const ring = r > 0.68 && r < 1.0;
  if (ring) return RED;

  // Speed lines to the left of the ring.
  const lines = [
    [0.36, 0.1, 0.42],
    [0.5, 0.06, 0.4],
    [0.64, 0.12, 0.42],
  ];
  for (const [ly, x0, x1] of lines) {
    const slant = (v - ly) * 0.22;
    if (Math.abs(v - ly) < 0.028 && u + slant > x0 && u + slant < x1) return WHITE;
  }
  return BG;
}

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

function png(size, maskable) {
  const SS = 4; // supersampling for smooth edges
  const raw = Buffer.alloc(size * (size * 3 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 3 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const c = shade((x + (sx + 0.5) / SS) / size, (y + (sy + 0.5) / SS) / size, maskable);
          r += c[0];
          g += c[1];
          b += c[2];
        }
      }
      const o = y * (size * 3 + 1) + 1 + x * 3;
      raw[o] = r / (SS * SS);
      raw[o + 1] = g / (SS * SS);
      raw[o + 2] = b / (SS * SS);
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

mkdirSync('public/icons', { recursive: true });
for (const [name, size, maskable] of [
  ['icon-192.png', 192, false],
  ['icon-512.png', 512, false],
  ['maskable-512.png', 512, true],
  ['apple-touch-icon.png', 180, false],
]) {
  writeFileSync(`public/icons/${name}`, png(size, maskable));
  console.log(`public/icons/${name}`);
}
