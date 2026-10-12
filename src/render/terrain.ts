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
/** Hills are gentle beside the circuit and grow into rolling countryside further out. */
const HILL_NEAR = 6;
const HILL_FAR = 30;
const HILL_FAR_DISTANCE = 600;

/** Mesh vertex spacing per tier: the heightfield is shared, only the mesh is coarser on weaker devices. */
const MESH_STEP: Record<QualitySettings['tier'], number> = { low: 18, medium: 14, high: 9, ultra: 6 };

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
  /** Per cell: 0 on the circuit's level ground, 1 in open countryside. */
  private readonly blend: Float32Array;
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
    this.blend = blendW;
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
        const away = isFinite(d) ? d : HILL_FAR_DISTANCE;
        const amplitude = HILL_NEAR + (HILL_FAR - HILL_NEAR) * smoothstep(150, HILL_FAR_DISTANCE, away);
        const hills = hillAt(x, z) * amplitude + hillAt(x * 2.7 + 1000, z * 2.7 - 500) * amplitude * 0.25;
        const land = (regionalAt(x, z) + hills) * settle + meanY * (1 - settle) - GROUND_DROP;
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

  /**
   * Mountains on the horizon: a ring of ridges well beyond the countryside. Coloured as distant mountains look,
   * hazed toward the sky, with fog off so they stay visible as silhouettes past the draw distance.
   */
  buildRidge(): THREE.Mesh {
    const cx = this.x0 + ((this.nx - 1) * CELL) / 2;
    const cz = this.z0 + ((this.nz - 1) * CELL) / 2;
    const inner = Math.hypot(((this.nx - 1) * CELL) / 2, ((this.nz - 1) * CELL) / 2) + 300;
    const outer = 5600;
    const around = 160;
    const radial = 12;
    const rand = seededRandom(151);
    const phases = [rand() * 6.28, rand() * 6.28, rand() * 6.28, rand() * 6.28];
    const positions: number[] = [];
    const indices: number[] = [];
    for (let i = 0; i <= around; i++) {
      const a = (i / around) * Math.PI * 2;
      // Ridgeline: a few overlapping waves around the horizon give peaks, saddles and a lower gap or two.
      const crest =
        180 +
        110 * Math.sin(a * 3 + phases[0]) +
        70 * Math.sin(a * 7 + phases[1]) +
        35 * Math.sin(a * 17 + phases[2]) +
        15 * Math.sin(a * 41 + phases[3]);
      for (let j = 0; j <= radial; j++) {
        const t = j / radial;
        const r = inner + (outer - inner) * t;
        // Rising from the plain to the crest about two thirds out, then falling away behind it.
        const profile = t < 0.65 ? Math.sin((t / 0.65) * Math.PI * 0.5) ** 1.6 : 1 - ((t - 0.65) / 0.35) * 0.6;
        positions.push(cx + Math.cos(a) * r, this.horizonHeight - 2 + Math.max(20, crest) * profile, cz + Math.sin(a) * r);
      }
    }
    for (let i = 0; i < around; i++) {
      for (let j = 0; j < radial; j++) {
        const k = i * (radial + 1) + j;
        indices.push(k, k + 1, k + radial + 1, k + 1, k + radial + 2, k + radial + 1);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setIndex(indices);
    geo.computeVertexNormals();
    // Aerial perspective: the base, seen through the most air, is palest; the crests a deeper blue-grey.
    const pos = geo.getAttribute('position') as THREE.BufferAttribute;
    const colors = new Float32Array(pos.count * 3);
    const low = new THREE.Color(0xb3c2cf);
    const high = new THREE.Color(0x7f93a3);
    const c = new THREE.Color();
    for (let k = 0; k < pos.count; k++) {
      const h = (pos.getY(k) - this.horizonHeight) / 260;
      c.copy(low).lerp(high, Math.min(1, Math.max(0, h)));
      colors[k * 3] = c.r;
      colors[k * 3 + 1] = c.g;
      colors[k * 3 + 2] = c.b;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    // Unlit: at this distance haze, not sunlight, sets the tone.
    const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ vertexColors: true, fog: false, side: THREE.DoubleSide }));
    mesh.name = 'ridge';
    return mesh;
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

  /**
   * Field colour: mown green beside the circuit; further out, patches of darker pasture and paler, drier grass,
   * so the countryside doesn't read as one lawn.
   */
  private fieldTint(x: number, z: number, out: THREE.Color): THREE.Color {
    const near = 1 - this.blendAt(x, z);
    const n = Math.sin(x * 0.011 + Math.sin(z * 0.007) * 2) * Math.cos(z * 0.013 + Math.sin(x * 0.005) * 2);
    const patch = n > 0.35 ? 0 : n < -0.35 ? 1 : 2;
    const far = patch === 0 ? [0.78, 0.85, 0.7] : patch === 1 ? [1.12, 1.05, 0.78] : [0.95, 1.0, 0.92];
    out.setRGB(1 + (far[0] - 1) * (1 - near), 1 + (far[1] - 1) * (1 - near), 1 + (far[2] - 1) * (1 - near));
    return out;
  }

  /** 0 on the circuit's level ground, rising to 1 in the open countryside. */
  private blendAt(x: number, z: number): number {
    const gx = Math.round((x - this.x0) / CELL);
    const gz = Math.round((z - this.z0) / CELL);
    if (gx < 0 || gz < 0 || gx >= this.nx || gz >= this.nz) return 1;
    return this.blend[gz * this.nx + gx];
  }

  private buildMesh(q: QualitySettings): THREE.Mesh {
    const step = MESH_STEP[q.tier];
    const w = (this.nx - 1) * CELL;
    const h = (this.nz - 1) * CELL;
    const cols = Math.floor(w / step) + 1;
    const rows = Math.floor(h / step) + 1;
    const positions = new Float32Array(cols * rows * 3);
    const uvs = new Float32Array(cols * rows * 2);
    const colors = new Float32Array(cols * rows * 3);
    const farness = new Float32Array(cols * rows);
    const tint = new THREE.Color();
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
        this.fieldTint(x, z, tint);
        colors[k * 3] = tint.r;
        colors[k * 3 + 1] = tint.g;
        colors[k * 3 + 2] = tint.b;
        farness[k] = this.blendAt(x, z);
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
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geo.setAttribute('farness', new THREE.BufferAttribute(farness, 1));
    geo.setIndex(indices);
    geo.computeVertexNormals();
    const grass = grassTextures(q.textureSize, q.anisotropy);
    const meadow = grassTextures(q.textureSize, q.anisotropy, false).map;
    const material = new THREE.MeshStandardMaterial({
      map: grass.map,
      normalMap: grass.normalMap,
      normalScale: new THREE.Vector2(0.5, 0.5),
      roughness: 0.95,
      metalness: 0,
      vertexColors: true,
    });
    // Mown stripes belong beside the circuit; the open countryside blends to unmown meadow, sampled at a different
    // scale so the two textures never line up into an obvious repeat.
    material.onBeforeCompile = (shader) => {
      shader.uniforms.meadowMap = { value: meadow };
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>
          attribute float farness;
          varying float vFarness;`)
        .replace('#include <begin_vertex>', `#include <begin_vertex>
          vFarness = farness;`);
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>
          uniform sampler2D meadowMap;
          varying float vFarness;`)
        .replace('#include <map_fragment>', `
          vec4 mown = texture2D(map, vMapUv);
          vec4 wild = texture2D(meadowMap, vMapUv * 0.61 + vec2(0.37, 0.11));
          diffuseColor *= mix(mown, wild, smoothstep(0.15, 0.85, vFarness));`);
    };
    const mesh = new THREE.Mesh(geo, material);
    mesh.receiveShadow = true;
    mesh.name = 'terrain';
    return mesh;
  }
}
