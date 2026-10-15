import { wrapAngle } from '../math.ts';
import type { Car } from '../physics/Car.ts';

/** Samples per second recorded for a ghost lap. */
const RATE = 20;
/** Values stored per sample: time, x, y, z, yaw, pitch, roll. */
const STRIDE = 7;

export interface GhostLap {
  /** Lap time, seconds. */
  time: number;
  /** Flat samples: [t, x, y, z, yaw, pitch, roll, t, x, ...], rounded to keep saved laps small. */
  samples: number[];
}

export interface GhostPose {
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  roll: number;
}

const round = (v: number, places: number) => Math.round(v * 10 ** places) / 10 ** places;

/** Records the car's path through a lap, a pose every 1/20 s of lap time. */
export class GhostRecorder {
  private samples: number[] = [];
  private next = 0;

  reset(): void {
    this.samples = [];
    this.next = 0;
  }

  add(lapTime: number, car: Car): void {
    // A fixed schedule (with a hair of tolerance for float noise), so frame timing doesn't stretch the interval.
    if (lapTime + 1e-6 < this.next) return;
    this.next += 1 / RATE;
    if (lapTime > this.next) this.next = lapTime + 1 / RATE;
    this.samples.push(round(lapTime, 3), round(car.x, 2), round(car.y, 2), round(car.z, 2), round(car.yaw, 4), round(car.pitch, 4), round(car.roll, 4));
  }

  finish(time: number): GhostLap {
    return { time, samples: this.samples.slice() };
  }
}

/** Where the ghost was `t` seconds into its lap, interpolated between samples; null before or after the lap. */
export function ghostPose(lap: GhostLap, t: number, out: GhostPose): GhostPose | null {
  const s = lap.samples;
  const n = s.length / STRIDE;
  if (n < 2 || t < s[0] || t > s[(n - 1) * STRIDE]) return null;
  // Binary search for the last sample at or before t.
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (s[mid * STRIDE] <= t) lo = mid;
    else hi = mid;
  }
  const a = lo * STRIDE;
  const b = hi * STRIDE;
  const span = s[b] - s[a];
  const f = span > 0 ? (t - s[a]) / span : 0;
  const mix = (k: number) => s[a + k] + (s[b + k] - s[a + k]) * f;
  out.x = mix(1);
  out.y = mix(2);
  out.z = mix(3);
  // Heading wraps at ±pi, so interpolate the short way round.
  out.yaw = s[a + 4] + wrapAngle(s[b + 4] - s[a + 4]) * f;
  out.pitch = mix(5);
  out.roll = mix(6);
  return out;
}

/** True if the data looks like a ghost lap this version can play. */
export function isGhostLap(v: unknown): v is GhostLap {
  const g = v as GhostLap;
  return !!g && typeof g.time === 'number' && Array.isArray(g.samples) && g.samples.length % STRIDE === 0;
}
