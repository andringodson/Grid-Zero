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
    const v = 0.2 + broad[i] * 0.06 + fine[i] * 0.07 + stone;
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
export function grassTextures(size: number, anisotropy: number): SurfaceTextures {
  const broad = fractalNoise(size, 21, 4, 4);
  const fine = fractalNoise(size, 22, 3, Math.max(32, size / 4));
  const [c, ctx] = canvas(size);
  const img = ctx.createImageData(size, size);
  const height = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    const stripe = Math.floor((y / size) * 4) % 2 === 0 ? 1 : 0.86;
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
