import * as THREE from 'three';
import { seededRandom } from '../math.ts';
import type { Track } from '../track/Track.ts';
import type { QualitySettings } from './quality.ts';
import { grassTextures } from './textures.ts';

/** The ground sits this far below the track surface so the two never z-fight. */
export const GROUND_DROP = 0.06;
/** Height samples every this many metres. */
const CELL = 6;
/** Countryside extends this far beyond the circuit. */
const MARGIN = 900;
/** Beyond the barrier the ground stays level with the track this far, then blends into the landscape. */
const LEVEL_BEYOND_BARRIER = 8;
const BLEND = 80;
const HILL_AMPLITUDE = 7;

/** Mesh vertex spacing per tier: the heightfield is shared, only the mesh is coarser on weaker devices. */
const MESH_STEP: Record<QualitySettings['tier'], number> = { low: 18, medium: 12, high: 9, ultra: 6 };

const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/**
 * The land the circuit sits in: exactly the track's height (less a few centimetres) out to just beyond the
 * barriers, then blending into rolling countryside that follows the circuit's general elevation, so the track
 * looks cut into the landscape rather than floating over it. One heightfield serves the ground mesh and the
 * placement of everything that stands on it.
 */
export class Terrain {
  readonly mesh: THREE.Mesh;
  private readonly heights: Float32Array;
  private readonly x0: number;
  private readonly z0: number;
  private readonly nx: number;
  private readonly nz: number;
  /** Height the far countryside settles to, and the level of the plane beyond the heightfield. */
  readonly horizonHeight: number;

  constructor(track: Track, q: QualitySettings) {
    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    let meanY = 0;
    for (let i = 0; i < track.count; i++) {
      minX = Math.min(minX, track.xs[i]);
      maxX = Math.max(maxX, track.xs[i]);
      minZ = Math.min(minZ, track.zs[i]);
      maxZ = Math.max(maxZ, track.zs[i]);
      meanY += track.ys[i];
    }
    meanY /= track.count;
    this.horizonHeight = meanY - GROUND_DROP;
    this.x0 = minX - MARGIN;
    this.z0 = minZ - MARGIN;
    this.nx = Math.ceil((maxX - minX + 2 * MARGIN) / CELL) + 1;
    this.nz = Math.ceil((maxZ - minZ + 2 * MARGIN) / CELL) + 1;
    const n = this.nx * this.nz;

    // 1. Nearest track sample for cells near the circuit, by splatting each sample over its neighbourhood.
    const reach = 140;
    const r = Math.ceil(reach / CELL);
    const bestD2 = new Float32Array(n).fill(Infinity);
    const nearY = new Float32Array(n);
    const nearBarrier = new Float32Array(n);
    for (let i = 0; i < track.count; i++) {
      const cx = Math.round((track.xs[i] - this.x0) / CELL);
      const cz = Math.round((track.zs[i] - this.z0) / CELL);
      const rx = -track.tz[i];
      const rz = track.tx[i];
      for (let dz = -r; dz <= r; dz++) {
        const gz = cz + dz;
        if (gz < 0 || gz >= this.nz) continue;
        for (let dx = -r; dx <= r; dx++) {
          const gx = cx + dx;
          if (gx < 0 || gx >= this.nx) continue;
          const wx = this.x0 + gx * CELL - track.xs[i];
          const wz = this.z0 + gz * CELL - track.zs[i];
          const d2 = wx * wx + wz * wz;
          const k = gz * this.nx + gx;
          if (d2 >= bestD2[k]) continue;
          bestD2[k] = d2;
          const lateral = wx * rx + wz * rz;
          nearY[k] = track.surfaceY(i, lateral);
          nearBarrier[k] = lateral > 0 ? track.barrierRight[i] : track.barrierLeft[i];
        }
      }
    }

    // 2. Regional elevation: the circuit's heights spread smoothly over the whole map (inverse-distance weighted on
    //    a coarse grid), so countryside next to a high part of the track is high too.
    const coarse = 60;
    const cnx = Math.ceil((this.nx * CELL) / coarse) + 1;
    const cnz = Math.ceil((this.nz * CELL) / coarse) + 1;
    const regional = new Float32Array(cnx * cnz);
    for (let gz = 0; gz < cnz; gz++) {
      for (let gx = 0; gx < cnx; gx++) {
        const x = this.x0 + gx * coarse;
        const z = this.z0 + gz * coarse;
        let wSum = 0;
        let ySum = 0;
        for (let i = 0; i < track.count; i += 4) {
          const d2 = (track.xs[i] - x) ** 2 + (track.zs[i] - z) ** 2 + 200 * 200;
          const w = 1 / (d2 * d2);
          wSum += w;
          ySum += w * track.ys[i];
        }
        regional[gz * cnx + gx] = ySum / wSum;
      }
    }
    const regionalAt = (x: number, z: number) => {
      const fx = Math.min(cnx - 1.001, Math.max(0, (x - this.x0) / coarse));
      const fz = Math.min(cnz - 1.001, Math.max(0, (z - this.z0) / coarse));
      const ix = Math.floor(fx);
      const iz = Math.floor(fz);
      const tx = fx - ix;
      const tz = fz - iz;
      const a = regional[iz * cnx + ix];
      const b = regional[iz * cnx + ix + 1];
      const c = regional[(iz + 1) * cnx + ix];
      const d = regional[(iz + 1) * cnx + ix + 1];
      return a + (b - a) * tx + (c - a) * tz + (a - b - c + d) * tx * tz;
    };

    // 3. Rolling hills: smooth value noise, nothing near the track, fading out at the edge of the map.
    const rand = seededRandom(131);
    const latticeCells = Math.ceil((Math.max(this.nx, this.nz) * CELL) / 260) + 2;
    const noise = new Float32Array(latticeCells * latticeCells).map(() => rand() * 2 - 1);
    const hillAt = (x: number, z: number) => {
      const fx = (x - this.x0) / 260;
      const fz = (z - this.z0) / 260;
      const ix = Math.floor(fx);
      const iz = Math.floor(fz);
      const sx = smoothstep(0, 1, fx - ix);
      const sz = smoothstep(0, 1, fz - iz);
      const g = (a: number, b: number) => noise[Math.min(latticeCells - 1, b) * latticeCells + Math.min(latticeCells - 1, a)];
      const a = g(ix, iz);
      const b = g(ix + 1, iz);
      const c = g(ix, iz + 1);
      const d = g(ix + 1, iz + 1);
      return a + (b - a) * sx + (c - a) * sz + (a - b - c + d) * sx * sz;
    };

    this.heights = new Float32Array(n);
    const blendW = new Float32Array(n);
    const spanX = (this.nx - 1) * CELL;
    const spanZ = (this.nz - 1) * CELL;
    for (let gz = 0; gz < this.nz; gz++) {
      for (let gx = 0; gx < this.nx; gx++) {
        const k = gz * this.nx + gx;
        const x = this.x0 + gx * CELL;
        const z = this.z0 + gz * CELL;
        const d = Math.sqrt(bestD2[k]);
        const level = isFinite(d) ? nearBarrier[k] + LEVEL_BEYOND_BARRIER : 0;
        const w = isFinite(d) ? smoothstep(level, level + BLEND, d) : 1;
        // Countryside: regional height plus hills, settling to the horizon level at the map's edge.
        const edge = Math.min(gx * CELL, spanX - gx * CELL, gz * CELL, spanZ - gz * CELL);
        const settle = smoothstep(0, 300, edge);
        const land = (regionalAt(x, z) + hillAt(x, z) * HILL_AMPLITUDE) * settle + meanY * (1 - settle) - GROUND_DROP;
        const near = isFinite(d) ? nearY[k] - GROUND_DROP : land;
        this.heights[k] = near * (1 - w) + land * w;
        blendW[k] = w;
      }
    }
    // Where two parts of the circuit at different heights are close, the nearest-sample rule leaves a step
    // midway between them; soften the ground outside the barriers so it reads as a bank, not a cliff.
    for (let pass = 0; pass < 3; pass++) {
      const src = this.heights.slice();
      for (let gz = 1; gz < this.nz - 1; gz++) {
        for (let gx = 1; gx < this.nx - 1; gx++) {
          const k = gz * this.nx + gx;
          const w = Math.min(1, blendW[k] * 3);
          if (w <= 0) continue;
          const avg = (src[k - 1] + src[k + 1] + src[k - this.nx] + src[k + this.nx] + src[k] * 4) / 8;
          this.heights[k] = src[k] * (1 - w) + avg * w;
        }
      }
    }

    this.mesh = this.buildMesh(q);
  }

  /** Ground height at a world position (bilinear in the heightfield; the horizon level outside it). */
  heightAt(x: number, z: number): number {
    const fx = (x - this.x0) / CELL;
    const fz = (z - this.z0) / CELL;
    if (fx < 0 || fz < 0 || fx >= this.nx - 1 || fz >= this.nz - 1) return this.horizonHeight;
    const ix = Math.floor(fx);
    const iz = Math.floor(fz);
    const tx = fx - ix;
    const tz = fz - iz;
    const k = iz * this.nx + ix;
    const a = this.heights[k];
    const b = this.heights[k + 1];
    const c = this.heights[k + this.nx];
    const d = this.heights[k + this.nx + 1];
    return a + (b - a) * tx + (c - a) * tz + (a - b - c + d) * tx * tz;
  }

  private buildMesh(q: QualitySettings): THREE.Mesh {
    const step = MESH_STEP[q.tier];
    const w = (this.nx - 1) * CELL;
    const h = (this.nz - 1) * CELL;
    const cols = Math.floor(w / step) + 1;
    const rows = Math.floor(h / step) + 1;
    const positions = new Float32Array(cols * rows * 3);
    const uvs = new Float32Array(cols * rows * 2);
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const x = this.x0 + c * step;
        const z = this.z0 + r * step;
        const k = r * cols + c;
        positions[k * 3] = x;
        positions[k * 3 + 1] = this.heightAt(x, z);
        positions[k * 3 + 2] = z;
        // One grass texture repeat every 40 m.
        uvs[k * 2] = x / 40;
        uvs[k * 2 + 1] = z / 40;
      }
    }
    const indices: number[] = [];
    for (let r = 0; r < rows - 1; r++) {
      for (let c = 0; c < cols - 1; c++) {
        const a = r * cols + c;
        indices.push(a, a + cols, a + 1, a + 1, a + cols, a + cols + 1);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    geo.setIndex(indices);
    geo.computeVertexNormals();
    const grass = grassTextures(q.textureSize, q.anisotropy);
    const mesh = new THREE.Mesh(
      geo,
      new THREE.MeshStandardMaterial({
        map: grass.map,
        normalMap: grass.normalMap,
        normalScale: new THREE.Vector2(0.5, 0.5),
        roughness: 0.95,
        metalness: 0,
      }),
    );
    mesh.receiveShadow = true;
    mesh.name = 'terrain';
    return mesh;
  }
}
