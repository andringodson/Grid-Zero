import * as THREE from 'three';
import { seededRandom } from '../math.ts';

/**
 * Procedural textures drawn on canvases at startup, so the game ships with no image files and no licences to track.
 */

function canvas(size: number, height = size): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = size;
  c.height = height;
  return [c, c.getContext('2d')!];
}

function finish(c: HTMLCanvasElement, anisotropy: number, srgb = true): THREE.CanvasTexture {
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = anisotropy;
  tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  return tex;
}

/** Fills a canvas with value noise summed over several octaves; returns values in 0..1. */
function fractalNoise(size: number, seed: number, octaves: number, baseCells: number): Float32Array {
  const rand = seededRandom(seed);
  const out = new Float32Array(size * size);
  let amp = 1;
  let total = 0;
  for (let o = 0; o < octaves; o++) {
    const cells = baseCells << o;
    const grid = new Float32Array((cells + 1) * (cells + 1));
    for (let i = 0; i < grid.length; i++) grid[i] = rand();
    // Wrap the lattice so the texture tiles seamlessly.
    for (let i = 0; i <= cells; i++) {
      grid[i * (cells + 1) + cells] = grid[i * (cells + 1)];
      grid[cells * (cells + 1) + i] = grid[i];
    }
    for (let y = 0; y < size; y++) {
      const fy = (y / size) * cells;
      const y0 = Math.floor(fy);
      const ty = fy - y0;
      const sy = ty * ty * (3 - 2 * ty);
      for (let x = 0; x < size; x++) {
        const fx = (x / size) * cells;
        const x0 = Math.floor(fx);
        const tx = fx - x0;
        const sx = tx * tx * (3 - 2 * tx);
        const a = grid[y0 * (cells + 1) + x0];
        const b = grid[y0 * (cells + 1) + x0 + 1];
        const c = grid[(y0 + 1) * (cells + 1) + x0];
        const d = grid[(y0 + 1) * (cells + 1) + x0 + 1];
        out[y * size + x] += amp * (a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy);
      }
    }
    total += amp;
    amp *= 0.5;
  }
  for (let i = 0; i < out.length; i++) out[i] /= total;
  return out;
}

export interface SurfaceTextures {
  map: THREE.CanvasTexture;
  roughnessMap: THREE.CanvasTexture;
  normalMap: THREE.CanvasTexture;
}

/** Normal map from a height field via central differences. */
function normalFromHeight(height: Float32Array, size: number, strength: number, anisotropy: number): THREE.CanvasTexture {
  const [c, ctx] = canvas(size);
  const img = ctx.createImageData(size, size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const l = height[y * size + ((x - 1 + size) % size)];
      const r = height[y * size + ((x + 1) % size)];
      const u = height[((y - 1 + size) % size) * size + x];
      const d = height[((y + 1) % size) * size + x];
      let nx = (l - r) * strength;
      let ny = (u - d) * strength;
      let nz = 1;
      const len = Math.hypot(nx, ny, nz);
      nx /= len;
      ny /= len;
      nz /= len;
      const i = (y * size + x) * 4;
      img.data[i] = (nx * 0.5 + 0.5) * 255;
      img.data[i + 1] = (ny * 0.5 + 0.5) * 255;
      img.data[i + 2] = (nz * 0.5 + 0.5) * 255;
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return finish(c, anisotropy, false);
}

/** Track asphalt: dark aggregate with lighter stones, slight patching, and a grippy matte finish. */
export function asphaltTextures(size: number, anisotropy: number): SurfaceTextures {
  const rand = seededRandom(7);
  const broad = fractalNoise(size, 11, 4, 4);
  const fine = fractalNoise(size, 12, 3, Math.max(32, size / 8));
  const height = new Float32Array(size * size);

  const [c, ctx] = canvas(size);
  const img = ctx.createImageData(size, size);
  const [rc, rctx] = canvas(size);
  const rough = rctx.createImageData(size, size);
  for (let i = 0; i < size * size; i++) {
    const stone = rand() < 0.05 ? 0.12 * rand() : 0;
    // Weathered, sun-bleached aggregate: light enough that the rubbered racing line reads darker against it.
    const v = 0.26 + broad[i] * 0.06 + fine[i] * 0.07 + stone;
    const g = Math.min(1, v) * 255;
    img.data[i * 4] = g;
    img.data[i * 4 + 1] = g * 1.01;
    img.data[i * 4 + 2] = g * 1.04;
    img.data[i * 4 + 3] = 255;
    height[i] = fine[i] + stone * 2;
    const r = (0.78 + fine[i] * 0.15 - stone * 0.3) * 255;
    rough.data[i * 4] = rough.data[i * 4 + 1] = rough.data[i * 4 + 2] = r;
    rough.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  rctx.putImageData(rough, 0, 0);
  return {
    map: finish(c, anisotropy),
    roughnessMap: finish(rc, anisotropy, false),
    normalMap: normalFromHeight(height, size, 3, anisotropy),
  };
}

/** Mown grass with the light and dark stripes a groundskeeper leaves. */
export function grassTextures(size: number, anisotropy: number, mown = true): SurfaceTextures {
  const broad = fractalNoise(size, 21, 4, 4);
  const fine = fractalNoise(size, 22, 3, Math.max(32, size / 4));
  const [c, ctx] = canvas(size);
  const img = ctx.createImageData(size, size);
  const height = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    const stripe = !mown || Math.floor((y / size) * 4) % 2 === 0 ? 1 : 0.86;
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const v = (0.75 + broad[i] * 0.35 + fine[i] * 0.25) * stripe;
      img.data[i * 4] = 52 * v;
      img.data[i * 4 + 1] = 96 * v;
      img.data[i * 4 + 2] = 38 * v;
      img.data[i * 4 + 3] = 255;
      height[i] = fine[i];
    }
  }
  ctx.putImageData(img, 0, 0);
  const [rc, rctx] = canvas(4);
  rctx.fillStyle = '#f0f0f0';
  rctx.fillRect(0, 0, 4, 4);
  return { map: finish(c, anisotropy), roughnessMap: finish(rc, 1, false), normalMap: normalFromHeight(height, size, 2, anisotropy) };
}

/** Red and white kerb blocks; one texture repeat is two blocks along the track. */
export function kerbTexture(anisotropy: number): THREE.CanvasTexture {
  const [c, ctx] = canvas(64, 256);
  ctx.fillStyle = '#d8d8d4';
  ctx.fillRect(0, 0, 64, 128);
  ctx.fillStyle = '#c8202a';
  ctx.fillRect(0, 128, 64, 128);
  // Worn edges and tyre rubber.
  const rand = seededRandom(31);
  for (let i = 0; i < 900; i++) {
    ctx.fillStyle = `rgba(20,20,20,${rand() * 0.18})`;
    ctx.fillRect(rand() * 64, rand() * 256, 2, 2);
  }
  return finish(c, anisotropy);
}

/** Concrete barrier with painted bands and panel joints; one repeat is one 4 m panel. */
export function barrierTexture(anisotropy: number): THREE.CanvasTexture {
  const [c, ctx] = canvas(256, 64);
  const rand = seededRandom(41);
  ctx.fillStyle = '#9a9c9e';
  ctx.fillRect(0, 0, 256, 64);
  for (let i = 0; i < 1400; i++) {
    const g = 130 + rand() * 50;
    ctx.fillStyle = `rgba(${g},${g},${g + 4},0.35)`;
    ctx.fillRect(rand() * 256, rand() * 64, 2, 2);
  }
  ctx.fillStyle = '#e8e8e6';
  ctx.fillRect(0, 0, 256, 12);
  ctx.fillStyle = '#c4242c';
  ctx.fillRect(0, 12, 128, 6);
  ctx.fillStyle = '#e8e8e6';
  ctx.fillRect(128, 12, 128, 6);
  ctx.fillStyle = 'rgba(40,40,40,0.6)';
  ctx.fillRect(254, 0, 2, 64);
  return finish(c, anisotropy);
}

/** Chequered start/finish strip. */
export function chequerTexture(): THREE.CanvasTexture {
  const [c, ctx] = canvas(128, 16);
  for (let x = 0; x < 16; x++) {
    for (let y = 0; y < 2; y++) {
      ctx.fillStyle = (x + y) % 2 === 0 ? '#f4f4f4' : '#111';
      ctx.fillRect(x * 8, y * 8, 8, 8);
    }
  }
  const tex = finish(c, 4);
  tex.magFilter = THREE.NearestFilter;
  return tex;
}

/** A packed crowd seen from a distance: a mosaic of shirt colours. */
export function crowdTexture(): THREE.CanvasTexture {
  const [c, ctx] = canvas(256, 64);
  const rand = seededRandom(51);
  const colours = ['#d9d9d9', '#2d4f8a', '#c23a32', '#f2c94c', '#1f1f1f', '#e07b39', '#4a8a4a', '#7a5ca8', '#ffffff'];
  ctx.fillStyle = '#3a3a3a';
  ctx.fillRect(0, 0, 256, 64);
  for (let y = 0; y < 64; y += 4) {
    for (let x = 0; x < 256; x += 3) {
      if (rand() < 0.12) continue;
      ctx.fillStyle = colours[Math.floor(rand() * colours.length)];
      ctx.fillRect(x, y + 1, 2, 3);
      ctx.fillStyle = '#e0b48c';
      ctx.fillRect(x, y, 2, 1);
    }
  }
  return finish(c, 4);
}

/** A soft, lumpy puff for smoke and dust particles: white, with the shape in the alpha channel. */
export function puffTexture(): THREE.CanvasTexture {
  const size = 64;
  const noise = fractalNoise(size, 71, 3, 4);
  const [c, ctx] = canvas(size);
  const img = ctx.createImageData(size, size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const r = Math.hypot(x + 0.5 - size / 2, y + 0.5 - size / 2) / (size / 2);
      const t = Math.min(1, Math.max(0, (r - 0.25) / 0.75));
      const falloff = 1 - t * t * (3 - 2 * t);
      img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = 255;
      img.data[i * 4 + 3] = falloff * (0.45 + 0.55 * noise[i]) * 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = finish(c, 1, false);
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  return tex;
}

/** Trackside board with a number, for the 300/200/100 m braking markers. */
export function boardTexture(text: string): THREE.CanvasTexture {
  const [c, ctx] = canvas(128, 128);
  ctx.fillStyle = '#f5f5f5';
  ctx.fillRect(0, 0, 128, 128);
  ctx.strokeStyle = '#111';
  ctx.lineWidth = 8;
  ctx.strokeRect(4, 4, 120, 120);
  ctx.fillStyle = '#111';
  ctx.font = 'bold 64px Arial, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 64, 68);
  return finish(c, 4);
}

/** Gravel trap: pale, uneven stones with darker gaps between them. */
export function gravelTextures(size: number, anisotropy: number): SurfaceTextures {
  const rand = seededRandom(81);
  const broad = fractalNoise(size, 82, 3, 4);
  const fine = fractalNoise(size, 83, 2, Math.max(32, size / 6));
  const [c, ctx] = canvas(size);
  const img = ctx.createImageData(size, size);
  const height = new Float32Array(size * size);
  for (let i = 0; i < size * size; i++) {
    const pebble = fine[i] > 0.55 ? 1 : 0.8;
    const tone = (0.62 + broad[i] * 0.25) * pebble * (0.9 + rand() * 0.2);
    img.data[i * 4] = 196 * tone;
    img.data[i * 4 + 1] = 176 * tone;
    img.data[i * 4 + 2] = 142 * tone;
    img.data[i * 4 + 3] = 255;
    height[i] = fine[i] * pebble;
  }
  ctx.putImageData(img, 0, 0);
  const [rc, rctx] = canvas(4);
  rctx.fillStyle = '#ececec';
  rctx.fillRect(0, 0, 4, 4);
  return { map: finish(c, anisotropy), roughnessMap: finish(rc, 1, false), normalMap: normalFromHeight(height, size, 4, anisotropy) };
}

/**
 * Asphalt run-off: older and dustier than the track, with a painted band beside the kerb. The texture spans the
 * run-off's width once (u) and repeats along the track (v).
 */
export function runoffTexture(size: number, anisotropy: number): THREE.CanvasTexture {
  const broad = fractalNoise(size, 91, 4, 4);
  const fine = fractalNoise(size, 92, 3, Math.max(32, size / 8));
  const [c, ctx] = canvas(size);
  const img = ctx.createImageData(size, size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const v = 0.3 + broad[i] * 0.08 + fine[i] * 0.06;
      let r = v;
      let g = v;
      let b = v * 1.02;
      // A green painted band nearest the track, then blue, as on modern circuits' run-off areas.
      const u = x / size;
      if (u < 0.12) [r, g, b] = [0.12 + fine[i] * 0.05, 0.42 + fine[i] * 0.06, 0.25];
      else if (u < 0.2) [r, g, b] = [0.16, 0.3 + fine[i] * 0.05, 0.55];
      img.data[i * 4] = r * 255;
      img.data[i * 4 + 1] = g * 255;
      img.data[i * 4 + 2] = b * 255;
      img.data[i * 4 + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return finish(c, anisotropy);
}

/** Diamond wire mesh for catch fencing, with the shape in the alpha channel for alpha testing. */
export function wireMeshTexture(): THREE.CanvasTexture {
  const [c, ctx] = canvas(64);
  ctx.clearRect(0, 0, 64, 64);
  ctx.strokeStyle = 'rgba(180,186,192,1)';
  ctx.lineWidth = 3;
  ctx.beginPath();
  for (let k = -64; k <= 128; k += 32) {
    ctx.moveTo(k, 0);
    ctx.lineTo(k + 64, 64);
    ctx.moveTo(k + 64, 0);
    ctx.lineTo(k, 64);
  }
  ctx.stroke();
  const tex = finish(c, 4);
  return tex;
}

/** The conveyor belt strapped across a tyre wall: red and white panels with bolt heads. */
export function beltTexture(): THREE.CanvasTexture {
  const [c, ctx] = canvas(128, 32);
  ctx.fillStyle = '#d32630';
  ctx.fillRect(0, 0, 64, 32);
  ctx.fillStyle = '#ededea';
  ctx.fillRect(64, 0, 64, 32);
  ctx.fillStyle = 'rgba(30,30,30,0.6)';
  for (let x = 6; x < 128; x += 16) {
    ctx.fillRect(x, 4, 3, 3);
    ctx.fillRect(x, 25, 3, 3);
  }
  ctx.fillStyle = 'rgba(0,0,0,0.25)';
  ctx.fillRect(0, 0, 128, 2);
  ctx.fillRect(0, 30, 128, 2);
  return finish(c, 4);
}

/** Tyre stack side: rubber with the gaps between three stacked tyres. */
export function tyreStackTexture(): THREE.CanvasTexture {
  const [c, ctx] = canvas(32, 96);
  ctx.fillStyle = '#1c1c1d';
  ctx.fillRect(0, 0, 32, 96);
  ctx.fillStyle = '#0a0a0a';
  for (const y of [0, 31, 63, 94]) ctx.fillRect(0, y, 32, 3);
  ctx.fillStyle = 'rgba(255,255,255,0.05)';
  for (const y of [8, 40, 72]) ctx.fillRect(0, y, 32, 2);
  return finish(c, 2);
}

/** Fictional trackside sponsors. No real brands: every name here is invented. */
export const AD_BRANDS: readonly { name: string; bg: string; fg: string }[] = [
  { name: 'HALVARD OIL', bg: '#0f2a5c', fg: '#f2c400' },
  { name: 'VEXOR TIMING', bg: '#111111', fg: '#ffffff' },
  { name: 'NORTHWEND ENERGY', bg: '#0b6b3a', fg: '#ffffff' },
  { name: 'KESTRA AIRWAYS', bg: '#c4161c', fg: '#ffffff' },
  { name: 'LUMIQ TELECOM', bg: '#5b2a86', fg: '#f2f2f2' },
  { name: 'CIRRA BANK', bg: '#f2f2f2', fg: '#1a3f8f' },
  { name: 'TORRIK TOOLS', bg: '#f47a20', fg: '#111111' },
  { name: 'OKAVI WATCHES', bg: '#1d1d1d', fg: '#c9a54a' },
];

/** All the sponsor boards in one atlas: board k occupies rows k/n..(k+1)/n. */
export function adAtlasTexture(anisotropy: number): THREE.CanvasTexture {
  const w = 512;
  const h = 64;
  const [c, ctx] = canvas(w, h * AD_BRANDS.length);
  AD_BRANDS.forEach((b, k) => {
    const y = k * h;
    ctx.fillStyle = b.bg;
    ctx.fillRect(0, y, w, h);
    ctx.fillStyle = b.fg;
    ctx.font = 'bold 38px Arial, Helvetica, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(b.name, w / 2, y + h / 2 + 2);
  });
  const tex = finish(c, anisotropy);
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  return tex;
}

/** 2x2 twill carbon weave as a brightness pattern: tows over-under, each with a soft sheen across it. */
export function carbonWeaveTexture(): THREE.CanvasTexture {
  const size = 64;
  const [c, ctx] = canvas(size);
  const img = ctx.createImageData(size, size);
  const cell = size / 4;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const cx = Math.floor(x / cell);
      const cy = Math.floor(y / cell);
      // Twill: the weave steps one tow per row.
      const warp = (cx + cy) % 4 < 2;
      const along = warp ? (y % cell) / cell : (x % cell) / cell;
      const across = warp ? (x % cell) / cell : (y % cell) / cell;
      const sheen = Math.sin(across * Math.PI) * (0.75 + 0.25 * Math.sin(along * Math.PI));
      const v = (warp ? 0.55 : 0.35) + sheen * 0.45;
      const i = (y * size + x) * 4;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = Math.min(255, v * 255);
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return finish(c, 4, false);
}

/** A race number, white with a dark outline on a transparent background, for decals. */
export function raceNumberTexture(num: number): THREE.CanvasTexture {
  const [c, ctx] = canvas(128);
  ctx.clearRect(0, 0, 128, 128);
  ctx.font = 'italic 900 84px Arial, Helvetica, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineWidth = 10;
  ctx.strokeStyle = 'rgba(10,10,12,0.9)';
  ctx.strokeText(String(num), 64, 68);
  ctx.fillStyle = '#ffffff';
  ctx.fillText(String(num), 64, 68);
  const tex = finish(c, 4);
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  return tex;
}

/**
 * Sidewall lettering laid out round a circle, for a RingGeometry whose planar UVs span [-outer, outer]. The tyre
 * brand is invented.
 */
export function sidewallTexture(outer: number, textRadius: number): THREE.CanvasTexture {
  const size = 256;
  const [c, ctx] = canvas(size);
  ctx.clearRect(0, 0, size, size);
  ctx.translate(size / 2, size / 2);
  const r = (textRadius / outer) * (size / 2);
  ctx.font = 'bold 15px Arial, Helvetica, sans-serif';
  ctx.fillStyle = 'rgba(236,236,236,0.95)';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (const [text, start] of [
    ['KORVEX', 0],
    ['RACE SLICK', Math.PI * 0.5],
    ['KORVEX', Math.PI],
    ['RACE SLICK', Math.PI * 1.5],
  ] as const) {
    const step = 0.085;
    const span = (text.length - 1) * step;
    for (let k = 0; k < text.length; k++) {
      const ang = start - span / 2 + k * step;
      ctx.save();
      ctx.rotate(ang);
      ctx.translate(0, -r);
      ctx.fillText(text[k], 0, 0);
      ctx.restore();
    }
  }
  const tex = finish(c, 4);
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  return tex;
}
