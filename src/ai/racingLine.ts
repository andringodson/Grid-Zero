import { clamp } from '../math.ts';
import type { CarSpec } from '../physics/carSpec.ts';
import type { Track } from '../track/Track.ts';

const G = 9.81;
const AIR_DENSITY = 1.225;

export interface RacingLine {
  /** Lateral offset from the centreline at each track sample (positive right). */
  offset: Float64Array;
  /** World positions of the line. */
  xs: Float64Array;
  zs: Float64Array;
  /** Signed curvature of the line itself. */
  curvature: Float64Array;
  /** Highest speed (m/s) at each sample that grip allows, after braking zones are worked back from each corner. */
  speed: Float64Array;
}

/**
 * Minimum-curvature racing line: gradient descent on the sum of squared second differences of the path, moving each
 * point only sideways and keeping it inside the white lines. Minimising curvature (not length, which would hug the
 * inside of every bend) gives the classic outside-apex-outside line with the largest radius through each corner.
 * Coarse strides first settle the long-wavelength shape, then finer strides refine it.
 */
export function computeRacingLine(track: Track, spec: CarSpec, gripScale = 0.92): RacingLine {
  const n = track.count;
  const limit = track.halfWidth - 1.6;
  const offset = new Float64Array(n);
  const rx = new Float64Array(n);
  const rz = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    rx[i] = -track.tz[i];
    rz[i] = track.tx[i];
  }

  const xs = new Float64Array(n);
  const zs = new Float64Array(n);
  const place = () => {
    for (let i = 0; i < n; i++) {
      xs[i] = track.xs[i] + rx[i] * offset[i];
      zs[i] = track.zs[i] + rz[i] * offset[i];
    }
  };

  const dx = new Float64Array(n);
  const dz = new Float64Array(n);
  for (const stride of [16, 8, 4, 2, 1]) {
    for (let iter = 0; iter < 400; iter++) {
      place();
      // Second difference: the discrete curvature vector at each point.
      for (let i = 0; i < n; i++) {
        const a = track.wrap(i - stride);
        const b = track.wrap(i + stride);
        dx[i] = xs[a] - 2 * xs[i] + xs[b];
        dz[i] = zs[a] - 2 * zs[i] + zs[b];
      }
      // Gradient of the summed squared curvature with respect to each point, projected onto its sideways direction.
      for (let i = 0; i < n; i++) {
        const a = track.wrap(i - stride);
        const b = track.wrap(i + stride);
        const gx = dx[a] - 2 * dx[i] + dx[b];
        const gz = dz[a] - 2 * dz[i] + dz[b];
        offset[i] = clamp(offset[i] - 0.05 * (gx * rx[i] + gz * rz[i]), -limit, limit);
      }
    }
  }
  place();

  // Curvature of the line from three points.
  const curvature = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const a = track.wrap(i - 2);
    const b = track.wrap(i + 2);
    const ax = xs[i] - xs[a];
    const az = zs[i] - zs[a];
    const bx = xs[b] - xs[i];
    const bz = zs[b] - zs[i];
    const cross = ax * bz - az * bx;
    const la = Math.hypot(ax, az);
    const lb = Math.hypot(bx, bz);
    const lc = Math.hypot(xs[b] - xs[a], zs[b] - zs[a]);
    curvature[i] = (2 * cross) / Math.max(la * lb * lc, 1e-6);
  }

  // Cornering speed: lateral grip mu * (g + downforce/m) must supply v^2 * curvature.
  const mu = spec.tyreMu * Math.min(spec.gripFront, spec.gripRear) * gripScale;
  const aeroK = (0.5 * AIR_DENSITY * spec.clA) / spec.mass;
  const vTop = 95;
  const speed = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const k = Math.abs(curvature[i]);
    const denom = k - mu * aeroK;
    speed[i] = denom <= 0 ? vTop : Math.min(vTop, Math.sqrt((mu * G) / denom));
  }

  // Braking zones: work backwards from each corner using the deceleration grip and drag allow at each speed.
  // Two passes round the loop so corners just after the line are handled.
  const brakeMu = mu * 0.85;
  const dragK = (0.5 * AIR_DENSITY * spec.cdA) / spec.mass;
  for (let pass = 0; pass < 2; pass++) {
    for (let k = n - 1; k >= 0; k--) {
      const i = k;
      const next = track.wrap(i + 1);
      const ds = Math.hypot(xs[next] - xs[i], zs[next] - zs[i]);
      const v = speed[next];
      const decel = brakeMu * (G + aeroK * v * v) + dragK * v * v;
      speed[i] = Math.min(speed[i], Math.sqrt(v * v + 2 * decel * ds));
    }
  }

  return { offset, xs, zs, curvature, speed };
}
