import { wrapAngle } from '../math.ts';
import type { CircuitDefinition } from './circuits.ts';

export type Surface = 'track' | 'kerb' | 'grass' | 'gravel' | 'runoff';

/** What lies beyond the kerb on one side of a track sample. */
export const RUNOFF_GRASS = 0;
export const RUNOFF_GRAVEL = 1;
export const RUNOFF_ASPHALT = 2;

export interface TrackProjection {
  /** Sample index: the point lies between samples `index` and `index + 1`. */
  index: number;
  /** Distance along the centreline from the start/finish line, in [0, length). */
  s: number;
  /** Signed distance from the centreline; positive is to the right of the driving direction. */
  lateral: number;
  /** Centreline heading in radians; direction is (cos, sin) in the x-z plane. */
  heading: number;
}

export interface TrackPoint {
  x: number;
  /** Height of the track surface at this point. */
  y: number;
  z: number;
  heading: number;
}

const SAMPLE_SPACING = 2;
const DENSE_STEPS = 64;
/** Samples further apart than this along the track count as a different part of the circuit. */
const NONLOCAL_DISTANCE = 120;
const LOCAL_SEARCH = 24;

type Vec = readonly [number, number];

/** Centripetal Catmull-Rom (alpha 0.5): no cusps or self-intersections within a segment. */
function catmullRom(p0: Vec, p1: Vec, p2: Vec, p3: Vec, t: number): [number, number] {
  const knot = (a: Vec, b: Vec) => Math.max(Math.hypot(b[0] - a[0], b[1] - a[1]) ** 0.5, 1e-6);
  const t0 = 0;
  const t1 = t0 + knot(p0, p1);
  const t2 = t1 + knot(p1, p2);
  const t3 = t2 + knot(p2, p3);
  const u = t1 + (t2 - t1) * t;
  const mix = (a: Vec, b: Vec, ta: number, tb: number): [number, number] => {
    const wa = (tb - u) / (tb - ta);
    const wb = (u - ta) / (tb - ta);
    return [a[0] * wa + b[0] * wb, a[1] * wa + b[1] * wb];
  };
  const a1 = mix(p0, p1, t0, t1);
  const a2 = mix(p1, p2, t1, t2);
  const a3 = mix(p2, p3, t2, t3);
  const b1 = mix(a1, a2, t0, t2);
  const b2 = mix(a2, a3, t1, t3);
  return mix(b1, b2, t1, t2);
}

export class Track {
  readonly id: string;
  readonly name: string;
  readonly width: number;
  readonly halfWidth: number;
  readonly kerbWidth = 1.8;
  readonly length: number;
  readonly spacing: number;
  readonly count: number;

  readonly xs: Float64Array;
  readonly zs: Float64Array;
  /** Unit tangent per sample. */
  readonly tx: Float64Array;
  readonly tz: Float64Array;
  readonly heading: Float64Array;
  /** Signed curvature (1/m); positive is a right-hand bend. */
  readonly curvature: Float64Array;
  /** Centreline height (m), gradient (rise per metre) and vertical curvature (1/m; negative over a crest). */
  readonly ys: Float64Array;
  readonly grade: Float64Array;
  readonly verticalCurvature: Float64Array;
  /** Camber (radians); positive raises the right-hand edge. */
  readonly camber: Float64Array;
  readonly kerbLeft: Uint8Array;
  readonly kerbRight: Uint8Array;
  /** Distance from the centreline to the barrier on each side. */
  readonly barrierLeft: Float64Array;
  readonly barrierRight: Float64Array;
  /** Run-off beyond the kerbs on each side: RUNOFF_GRASS, RUNOFF_GRAVEL or RUNOFF_ASPHALT. */
  readonly runoffLeft: Uint8Array;
  readonly runoffRight: Uint8Array;
  /** Start of each timing sector, in metres from the line. */
  readonly sectorStarts: readonly number[];

  constructor(def: CircuitDefinition) {
    this.id = def.id;
    this.name = def.name;
    this.width = def.width;
    this.halfWidth = def.width / 2;

    // 1. Dense polyline through the control points.
    const pts = def.points;
    const n = pts.length;
    const dense: [number, number][] = [];
    for (let i = 0; i < n; i++) {
      const p0 = pts[(i - 1 + n) % n];
      const p1 = pts[i];
      const p2 = pts[(i + 1) % n];
      const p3 = pts[(i + 2) % n];
      for (let k = 0; k < DENSE_STEPS; k++) dense.push(catmullRom(p0, p1, p2, p3, k / DENSE_STEPS));
    }
    const cum = new Float64Array(dense.length + 1);
    for (let i = 0; i < dense.length; i++) {
      const a = dense[i];
      const b = dense[(i + 1) % dense.length];
      cum[i + 1] = cum[i] + Math.hypot(b[0] - a[0], b[1] - a[1]);
    }
    const total = cum[dense.length];

    // 2. Resample at even spacing so every sample covers the same distance.
    const count = Math.round(total / SAMPLE_SPACING);
    this.count = count;
    this.length = total;
    this.spacing = total / count;
    this.xs = new Float64Array(count);
    this.zs = new Float64Array(count);
    let j = 0;
    for (let k = 0; k < count; k++) {
      const s = k * this.spacing;
      while (cum[j + 1] < s) j++;
      const t = (s - cum[j]) / (cum[j + 1] - cum[j] || 1);
      const a = dense[j];
      const b = dense[(j + 1) % dense.length];
      this.xs[k] = a[0] + (b[0] - a[0]) * t;
      this.zs[k] = a[1] + (b[1] - a[1]) * t;
    }

    // 3. Tangents, headings and curvature.
    this.tx = new Float64Array(count);
    this.tz = new Float64Array(count);
    this.heading = new Float64Array(count);
    for (let k = 0; k < count; k++) {
      const dx = this.xs[this.wrap(k + 1)] - this.xs[this.wrap(k - 1)];
      const dz = this.zs[this.wrap(k + 1)] - this.zs[this.wrap(k - 1)];
      const len = Math.hypot(dx, dz) || 1;
      this.tx[k] = dx / len;
      this.tz[k] = dz / len;
      this.heading[k] = Math.atan2(dz, dx);
    }
    const rawCurv = new Float64Array(count);
    for (let k = 0; k < count; k++) {
      rawCurv[k] = wrapAngle(this.heading[this.wrap(k + 1)] - this.heading[this.wrap(k - 1)]) / (2 * this.spacing);
    }
    this.curvature = this.smooth(rawCurv, 3);

    // 3b. Elevation: heights and camber given at the control points, interpolated along the lap with smooth
    //     (Catmull-Rom Hermite) curves, then smoothed so crests and dips stay within what a real circuit has.
    const ctrlS = pts.map((_, i) => cum[i * DENSE_STEPS]);
    const along = (values: readonly number[] | undefined): Float64Array => {
      const out = new Float64Array(count);
      if (!values) return out;
      let seg = 0;
      for (let k = 0; k < count; k++) {
        const s = k * this.spacing;
        while (seg < n - 1 && ctrlS[seg + 1] <= s) seg++;
        const i0 = seg;
        const i1 = (seg + 1) % n;
        const s0 = ctrlS[i0];
        const s1 = i1 === 0 ? total : ctrlS[i1];
        const span = s1 - s0;
        const t = (s - s0) / span;
        const sPrev = i0 === 0 ? ctrlS[n - 1] - total : ctrlS[i0 - 1];
        const sNext = (i1 + 1) % n === 0 ? total + (i1 === 0 ? ctrlS[1] : 0) : ctrlS[(i1 + 1) % n] + (i1 === 0 ? total : 0);
        const v0 = values[i0];
        const v1 = values[i1];
        const m0 = ((v1 - values[(i0 - 1 + n) % n]) / (s1 - sPrev)) * span;
        const m1 = ((values[(i1 + 1) % n] - v0) / (sNext - s0)) * span;
        const t2 = t * t;
        const t3 = t2 * t;
        out[k] = (2 * t3 - 3 * t2 + 1) * v0 + (t3 - 2 * t2 + t) * m0 + (-2 * t3 + 3 * t2) * v1 + (t3 - t2) * m1;
      }
      return out;
    };
    this.ys = this.smooth(this.smooth(along(def.heights), 10), 10);
    this.camber = this.smooth(along(def.camber), 8);
    this.grade = new Float64Array(count);
    const rawVert = new Float64Array(count);
    for (let k = 0; k < count; k++) {
      const prev = this.ys[this.wrap(k - 1)];
      const next = this.ys[this.wrap(k + 1)];
      this.grade[k] = (next - prev) / (2 * this.spacing);
      rawVert[k] = (next - 2 * this.ys[k] + prev) / (this.spacing * this.spacing);
    }
    this.verticalCurvature = this.smooth(rawVert, 4);

    // 4. Kerbs wherever the track bends meaningfully, extended a little either side of the corner.
    this.kerbLeft = new Uint8Array(count);
    this.kerbRight = new Uint8Array(count);
    const extend = Math.round(14 / this.spacing);
    for (let k = 0; k < count; k++) {
      if (Math.abs(this.curvature[k]) < 1 / 260) continue;
      for (let d = -extend; d <= extend; d++) {
        this.kerbLeft[this.wrap(k + d)] = 1;
        this.kerbRight[this.wrap(k + d)] = 1;
      }
    }

    // 5. Barriers: generous run-off in corners, but never past the halfway point to another part of the circuit,
    //    and never past the centre of curvature on the inside of a bend.
    const edge = this.halfWidth + this.kerbWidth;
    const wantLeft = new Float64Array(count);
    const wantRight = new Float64Array(count);
    for (let k = 0; k < count; k++) {
      const runoff = Math.abs(this.curvature[k]) > 1 / 400 ? 32 : 16;
      wantLeft[k] = edge + runoff;
      wantRight[k] = edge + runoff;
    }
    for (let k = 0; k < count; k++) {
      const rx = -this.tz[k];
      const rz = this.tx[k];
      for (let m = 0; m < count; m++) {
        if (this.cyclicDistance(k * this.spacing, m * this.spacing) < NONLOCAL_DISTANCE) continue;
        const dx = this.xs[m] - this.xs[k];
        const dz = this.zs[m] - this.zs[k];
        const dist = Math.hypot(dx, dz);
        if (dist > 2 * (edge + 40)) continue;
        if (dx * rx + dz * rz > 0) wantRight[k] = Math.min(wantRight[k], dist / 2);
        else wantLeft[k] = Math.min(wantLeft[k], dist / 2);
      }
      const radius = 1 / Math.max(Math.abs(this.curvature[k]), 1e-6);
      if (this.curvature[k] > 0) wantRight[k] = Math.min(wantRight[k], radius * 0.85);
      else wantLeft[k] = Math.min(wantLeft[k], radius * 0.85);
    }
    // A moving minimum then an average gives a barrier line without sudden steps.
    this.barrierLeft = this.smooth(this.movingMin(wantLeft, 10), 6);
    this.barrierRight = this.smooth(this.movingMin(wantRight, 10), 6);

    // 6. Run-off on the outside of corners, where a car that gets it wrong ends up. Tight corners at the end of a
    //    braking zone get painted asphalt, so a driver who outbrakes himself can rejoin, and it reaches back over
    //    the braking zone; faster corners get gravel, which slows a car that slides off hard.
    this.runoffLeft = new Uint8Array(count);
    this.runoffRight = new Uint8Array(count);
    const before = Math.round(50 / this.spacing);
    const after = Math.round(40 / this.spacing);
    const brakingZone = Math.round(120 / this.spacing);
    for (let k = 0; k < count; k++) {
      const c = this.curvature[k];
      if (Math.abs(c) < 1 / 400) continue;
      const tight = Math.abs(c) > 1 / 80;
      const kind = tight ? RUNOFF_ASPHALT : RUNOFF_GRAVEL;
      // The outside of a right-hander is on the left.
      const side = c > 0 ? this.runoffLeft : this.runoffRight;
      for (let d = -(tight ? brakingZone : before); d <= after; d++) {
        const i = this.wrap(k + d);
        // Asphalt wins where zones overlap: it's what the tight corner's braking zone needs.
        if (side[i] !== RUNOFF_ASPHALT) side[i] = kind;
      }
    }

    this.sectorStarts = [0, this.length / 3, (2 * this.length) / 3];
  }

  wrap(i: number): number {
    return ((i % this.count) + this.count) % this.count;
  }

  /** Shortest distance between two positions along the loop. */
  cyclicDistance(a: number, b: number): number {
    const d = Math.abs(a - b) % this.length;
    return Math.min(d, this.length - d);
  }

  /** Normalises a distance along the track into [0, length). */
  wrapS(s: number): number {
    return ((s % this.length) + this.length) % this.length;
  }

  pointAt(s: number, lateral = 0): TrackPoint {
    s = this.wrapS(s);
    const f = s / this.spacing;
    const i = Math.floor(f) % this.count;
    const t = f - Math.floor(f);
    const i2 = this.wrap(i + 1);
    const cx = this.xs[i] + (this.xs[i2] - this.xs[i]) * t;
    const cz = this.zs[i] + (this.zs[i2] - this.zs[i]) * t;
    const heading = this.heading[i] + wrapAngle(this.heading[i2] - this.heading[i]) * t;
    const y = this.surfaceY(i, lateral) + (this.surfaceY(i2, lateral) - this.surfaceY(i, lateral)) * t;
    return { x: cx - Math.sin(heading) * lateral, y, z: cz + Math.cos(heading) * lateral, heading };
  }

  /**
   * Height of the ground at sample i, `lateral` metres from the centreline. Camber tilts the track and kerbs;
   * beyond the kerbs the run-off continues level from the edge.
   */
  surfaceY(i: number, lateral: number): number {
    const edge = this.halfWidth + this.kerbWidth;
    return this.ys[i] + Math.max(-edge, Math.min(edge, lateral)) * Math.tan(this.camber[i]);
  }

  /** Ground height under a projected position, interpolated between samples. */
  heightAt(p: TrackProjection): number {
    const i2 = this.wrap(p.index + 1);
    let t = p.s / this.spacing - p.index;
    if (t < 0) t += this.count;
    t = Math.min(1, Math.max(0, t));
    return this.surfaceY(p.index, p.lateral) * (1 - t) + this.surfaceY(i2, p.lateral) * t;
  }

  /**
   * Finds where a world position sits relative to the centreline. Pass the previous result's index as a hint
   * to keep this cheap; without a hint (or if the hint is far off) it searches the whole circuit.
   */
  project(x: number, z: number, hint = -1): TrackProjection {
    let best = this.projectRange(x, z, hint, LOCAL_SEARCH);
    if (hint < 0 || Math.abs(best.lateral) > 80) best = this.projectRange(x, z, 0, this.count);
    return best;
  }

  private projectRange(x: number, z: number, centre: number, radius: number): TrackProjection {
    let bestD = Infinity;
    let bestI = 0;
    let bestT = 0;
    const from = radius >= this.count ? 0 : centre - radius;
    const to = radius >= this.count ? this.count : centre + radius;
    for (let k = from; k < to; k++) {
      const i = this.wrap(k);
      const i2 = this.wrap(i + 1);
      const ax = this.xs[i];
      const az = this.zs[i];
      const ex = this.xs[i2] - ax;
      const ez = this.zs[i2] - az;
      const len2 = ex * ex + ez * ez;
      let t = ((x - ax) * ex + (z - az) * ez) / len2;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const px = ax + ex * t - x;
      const pz = az + ez * t - z;
      const d = px * px + pz * pz;
      if (d < bestD) {
        bestD = d;
        bestI = i;
        bestT = t;
      }
    }
    const i2 = this.wrap(bestI + 1);
    const ex = this.xs[i2] - this.xs[bestI];
    const ez = this.zs[i2] - this.zs[bestI];
    const len = Math.hypot(ex, ez) || 1;
    const cx = this.xs[bestI] + ex * bestT;
    const cz = this.zs[bestI] + ez * bestT;
    // Right of the direction of travel is (-dz, dx).
    const lateral = ((x - cx) * -ez + (z - cz) * ex) / len;
    return {
      index: bestI,
      s: this.wrapS((bestI + bestT) * this.spacing),
      lateral,
      heading: Math.atan2(ez, ex),
    };
  }

  surfaceAt(p: TrackProjection): Surface {
    const a = Math.abs(p.lateral);
    if (a <= this.halfWidth) return 'track';
    const kerb = p.lateral > 0 ? this.kerbRight[p.index] : this.kerbLeft[p.index];
    if (kerb && a <= this.halfWidth + this.kerbWidth) return 'kerb';
    const runoff = p.lateral > 0 ? this.runoffRight[p.index] : this.runoffLeft[p.index];
    if (runoff === RUNOFF_GRAVEL) return 'gravel';
    if (runoff === RUNOFF_ASPHALT) return 'runoff';
    return 'grass';
  }

  barrierAt(p: TrackProjection): number {
    return p.lateral > 0 ? this.barrierRight[p.index] : this.barrierLeft[p.index];
  }

  /** Starting grid: two columns, staggered 8 m apart, behind the start/finish line. */
  gridSlot(slot: number): TrackPoint {
    const s = -12 - slot * 8;
    return this.pointAt(s, slot % 2 === 0 ? -3.2 : 3.2);
  }

  private smooth(src: Float64Array, radius: number): Float64Array {
    const out = new Float64Array(src.length);
    for (let k = 0; k < src.length; k++) {
      let sum = 0;
      for (let d = -radius; d <= radius; d++) sum += src[this.wrap(k + d)];
      out[k] = sum / (2 * radius + 1);
    }
    return out;
  }

  private movingMin(src: Float64Array, radius: number): Float64Array {
    const out = new Float64Array(src.length);
    for (let k = 0; k < src.length; k++) {
      let m = Infinity;
      for (let d = -radius; d <= radius; d++) m = Math.min(m, src[this.wrap(k + d)]);
      out[k] = m;
    }
    return out;
  }
}
