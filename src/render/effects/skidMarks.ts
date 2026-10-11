import * as THREE from 'three';
import type { Car } from '../../physics/Car.ts';
import type { QualitySettings } from '../quality.ts';
import { GROUND_Y } from '../trackMesh.ts';
import { type HasCar, TYRE_WIDTH, tyreScrub, wheelX, wheelZ } from './tyres.ts';

/** Mark segments kept per tier; the oldest fade out and are overwritten. */
const CAPACITY: Record<QualitySettings['tier'], number> = { low: 600, medium: 1600, high: 3200, ultra: 5000 };

/** A mark starts above this scrub and continues until it drops below the lower figure, so it doesn't flicker. */
const START = 0.16;
const STOP = 0.08;
/** Shortest stretch of travel worth a new segment, and the jump that means the car was moved rather than driven. */
const MIN_STEP = 0.25;
const MAX_STEP = 6;
/** Length of the tyre's contact patch: a tyre sliding sideways leaves a mark this wide. */
const PATCH_LENGTH = 0.22;
const ASPHALT_Y = 0.008;
const GRASS_Y = GROUND_Y + 0.012;

const vertexShader = /* glsl */ `
attribute vec3 info;
attribute float edge;
uniform float head;
uniform float capacity;
varying float vAlpha;
varying float vKind;
varying float vEdge;
#include <fog_pars_vertex>
void main() {
  // The oldest quarter of the buffer fades out before it is overwritten.
  float age = head - info.z;
  vAlpha = info.x * (1.0 - smoothstep(capacity * 0.75, capacity, age));
  vKind = info.y;
  vEdge = edge;
  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}`;

const fragmentShader = /* glsl */ `
varying float vAlpha;
varying float vKind;
varying float vEdge;
#include <fog_pars_fragment>
void main() {
  // Soft shoulders: a tyre leaves less rubber at the edges of its tread.
  float soft = smoothstep(0.0, 0.3, vEdge) * smoothstep(1.0, 0.7, vEdge);
  vec3 rubber = vec3(0.01, 0.01, 0.012);
  vec3 turf = vec3(0.075, 0.055, 0.025);
  gl_FragColor = vec4(mix(rubber, turf, vKind), vAlpha * soft);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}`;

/** Per-wheel trail state: where the last segment ended, so the next one joins it seamlessly. */
interface Trail {
  active: boolean;
  /** 0 asphalt, 1 grass. */
  kind: number;
  x: number;
  z: number;
  lx: number;
  lz: number;
  rx: number;
  rz: number;
  alpha: number;
}

const newTrail = (): Trail => ({ active: false, kind: 0, x: 0, z: 0, lx: 0, lz: 0, rx: 0, rz: 0, alpha: 0 });

/**
 * Tyre marks laid under every car: black rubber where a tyre locks, spins or slides on asphalt, and torn brown turf
 * where it runs on grass. All marks live in one ring-buffer geometry, so they cost a single draw call however many
 * there are; only the segments written this frame are uploaded.
 */
export class SkidMarks {
  readonly mesh: THREE.Mesh;
  private readonly capacity: number;
  private readonly positions: THREE.BufferAttribute;
  private readonly info: THREE.BufferAttribute;
  private readonly material: THREE.ShaderMaterial;
  private readonly trails = new Map<Car, Trail[]>();
  /** Total segments ever written; the slot is this modulo the capacity. */
  private written = 0;
  private dirtyFrom = -1;

  constructor(q: QualitySettings) {
    const cap = CAPACITY[q.tier];
    this.capacity = cap;
    const geo = new THREE.BufferGeometry();
    this.positions = new THREE.BufferAttribute(new Float32Array(cap * 4 * 3), 3);
    this.positions.setUsage(THREE.DynamicDrawUsage);
    this.info = new THREE.BufferAttribute(new Float32Array(cap * 4 * 3), 3);
    this.info.setUsage(THREE.DynamicDrawUsage);
    const edge = new Float32Array(cap * 4);
    const index = new Uint32Array(cap * 6);
    for (let s = 0; s < cap; s++) {
      edge.set([0, 1, 0, 1], s * 4);
      const v = s * 4;
      index.set([v, v + 2, v + 1, v + 1, v + 2, v + 3], s * 6);
    }
    geo.setAttribute('position', this.positions);
    geo.setAttribute('info', this.info);
    geo.setAttribute('edge', new THREE.BufferAttribute(edge, 1));
    geo.setIndex(new THREE.BufferAttribute(index, 1));
    geo.setDrawRange(0, 0);

    this.material = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { head: { value: 0 }, capacity: { value: cap } }]),
      vertexShader,
      fragmentShader,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      fog: true,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -4,
    });
    this.mesh = new THREE.Mesh(geo, this.material);
    // The marks span the whole circuit; culling would only ever hide them all at once.
    this.mesh.frustumCulled = false;
    this.mesh.name = 'skid-marks';
  }

  /** Extends the marks under every car's wheels; call once per rendered frame. */
  update(cars: readonly HasCar[]): void {
    this.dirtyFrom = this.written;
    for (const { car } of cars) {
      let trails = this.trails.get(car);
      if (!trails) {
        trails = [newTrail(), newTrail(), newTrail(), newTrail()];
        this.trails.set(car, trails);
      }
      for (let w = 0; w < 4; w++) this.updateWheel(car, w, trails[w]);
    }
    if (this.written > this.dirtyFrom) this.upload();
  }

  /** Forgets cars that have left the field, so their trails can't join up with a new car's. */
  prune(cars: readonly HasCar[]): void {
    for (const car of this.trails.keys()) if (!cars.some((c) => c.car === car)) this.trails.delete(car);
  }

  private updateWheel(car: Car, w: number, t: Trail): void {
    const x = wheelX(car, w);
    const z = wheelZ(car, w);
    const surface = car.wheelSurface[w];
    const speed = car.speed;

    let kind = -1;
    let alpha = 0;
    if (surface === 'grass' && speed > 3) {
      kind = 1;
      alpha = 0.32 + 0.3 * Math.max(car.slide, car.lockup);
    } else if (surface === 'track') {
      const scrub = tyreScrub(car, w);
      if (scrub > (t.active && t.kind === 0 ? STOP : START)) {
        kind = 0;
        alpha = Math.min(0.68, 0.16 + scrub * 0.55);
      }
    }

    const dx = x - t.x;
    const dz = z - t.z;
    const dist = Math.hypot(dx, dz);
    if (kind < 0 || dist > MAX_STEP || (t.active && kind !== t.kind)) {
      // Lift off: the next mark starts afresh from wherever the wheel is then.
      t.active = false;
      t.x = x;
      t.z = z;
      if (kind < 0) return;
    }
    if (t.active && dist < MIN_STEP) return;

    // Swept width: the tread's width across the direction of travel, plus the contact patch's length when sliding.
    const heading = car.yaw + (w < 2 ? car.steerAngle : 0);
    const mx = dist > 1e-4 ? dx / dist : Math.cos(heading);
    const mz = dist > 1e-4 ? dz / dist : Math.sin(heading);
    const along = Math.abs(mx * Math.cos(heading) + mz * Math.sin(heading));
    const half = (TYRE_WIDTH[w] * along + PATCH_LENGTH * Math.sqrt(Math.max(0, 1 - along * along))) / 2;
    // Right of the direction of travel.
    const lx = x + mz * half;
    const lz = z - mx * half;
    const rx = x - mz * half;
    const rz = z + mx * half;

    if (t.active) {
      this.writeSegment(t, lx, lz, rx, rz, kind, alpha);
    }
    t.active = true;
    t.kind = kind;
    t.x = x;
    t.z = z;
    t.lx = lx;
    t.lz = lz;
    t.rx = rx;
    t.rz = rz;
    t.alpha = alpha;
  }

  private writeSegment(t: Trail, lx: number, lz: number, rx: number, rz: number, kind: number, alpha: number): void {
    const slot = this.written % this.capacity;
    const seq = this.written;
    this.written++;
    const y = kind === 1 ? GRASS_Y : ASPHALT_Y;
    const p = this.positions.array as Float32Array;
    const o = slot * 12;
    p[o] = t.lx;
    p[o + 1] = y;
    p[o + 2] = t.lz;
    p[o + 3] = t.rx;
    p[o + 4] = y;
    p[o + 5] = t.rz;
    p[o + 6] = lx;
    p[o + 7] = y;
    p[o + 8] = lz;
    p[o + 9] = rx;
    p[o + 10] = y;
    p[o + 11] = rz;
    // A little variation along the mark, as a real tyre lays rubber unevenly.
    const a = alpha * (0.85 + 0.15 * Math.sin(seq * 2.399));
    const inf = this.info.array as Float32Array;
    for (let v = 0; v < 4; v++) {
      inf[o + v * 3] = v < 2 ? t.alpha : a;
      inf[o + v * 3 + 1] = kind;
      inf[o + v * 3 + 2] = seq;
    }
  }

  private upload(): void {
    const cap = this.capacity;
    const count = this.written - this.dirtyFrom;
    const from = this.dirtyFrom % cap;
    if (count >= cap) {
      this.markDirty(0, cap);
    } else if (from + count <= cap) {
      this.markDirty(from, count);
    } else {
      // This frame's segments wrapped round the end of the buffer.
      this.markDirty(from, cap - from);
      this.markDirty(0, from + count - cap);
    }
    this.positions.needsUpdate = true;
    this.info.needsUpdate = true;
    this.mesh.geometry.setDrawRange(0, Math.min(this.written, cap) * 6);
    this.material.uniforms.head.value = this.written;
  }

  /** Both dynamic attributes hold 12 floats per segment. */
  private markDirty(segment: number, count: number): void {
    this.positions.addUpdateRange(segment * 12, count * 12);
    this.info.addUpdateRange(segment * 12, count * 12);
  }
}
