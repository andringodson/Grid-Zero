import type { Car, SurfaceProbe, WheelSurface } from '../physics/Car.ts';

const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
import type { Track, TrackProjection } from '../track/Track.ts';

const SURFACES: Record<WheelSurface['kind'], WheelSurface> = {
  track: { kind: 'track', grip: 1, drag: 0 },
  kerb: { kind: 'kerb', grip: 0.92, drag: 0.012 },
  grass: { kind: 'grass', grip: 0.5, drag: 0.3 },
};

/** Half the car's width, for barrier contact. */
const CAR_HALF_WIDTH = 1.0;

export interface StepResult {
  /** Speed into the barrier in m/s, 0 if there was no contact. */
  impact: number;
  /** How square-on the hit was: 1 nose-first, 0 a glancing scrape along the wall. */
  frontal: number;
}

/** The racing line is rubbered in and grips a little better; off it, marbles and dust grip a little worse. */
const LINE_GRIP_BONUS = 0.02;
const MARBLES_GRIP_LOSS = 0.03;

/** Puts a car on a track: surfaces under its wheels, barrier contact, and returning it to the circuit. */
export class World {
  readonly track: Track;
  private wheelHints = [-1, -1, -1, -1];
  private centreHint = -1;
  private line: Float64Array | null = null;
  private readonly asphalt: WheelSurface[] = [0, 1, 2, 3].map(() => ({ ...SURFACES.track }));
  projection: TrackProjection;

  constructor(track: Track, car: Car) {
    this.track = track;
    this.projection = track.project(car.x, car.z);
  }

  /** Racing-line offsets per track sample; asphalt grip then varies with distance from the line. */
  setRacingLine(offset: Float64Array): void {
    this.line = offset;
  }

  readonly probe: SurfaceProbe = (x, z, wheel) => {
    const p = this.track.project(x, z, this.wheelHints[wheel]);
    this.wheelHints[wheel] = p.index;
    const kind = this.track.surfaceAt(p);
    if (kind !== 'track' || !this.line) return SURFACES[kind];
    const off = Math.abs(p.lateral - this.line[p.index]);
    const onLine = 1 - smoothstep(1.5, 4.5, off);
    const marbles = smoothstep(4, 8, off);
    const surface = this.asphalt[wheel];
    surface.grip = 1 + LINE_GRIP_BONUS * onLine - MARBLES_GRIP_LOSS * marbles;
    return surface;
  };

  /** Runs after each physics step: keeps the car inside the barriers. */
  constrain(car: Car): StepResult {
    const p = this.track.project(car.x, car.z, this.centreHint);
    this.centreHint = p.index;
    this.projection = p;
    const limit = this.track.barrierAt(p) - CAR_HALF_WIDTH;
    const excess = Math.abs(p.lateral) - limit;
    if (excess <= 0) return { impact: 0, frontal: 0 };

    // Outward normal: toward the barrier the car is touching.
    const side = Math.sign(p.lateral);
    const nx = -Math.sin(p.heading) * side;
    const nz = Math.cos(p.heading) * side;
    car.x -= nx * excess;
    car.z -= nz * excess;

    const c = Math.cos(car.yaw);
    const s = Math.sin(car.yaw);
    let vx = car.u * c - car.v * s;
    let vz = car.u * s + car.v * c;
    const vn = vx * nx + vz * nz;
    if (vn <= 0) return { impact: 0, frontal: 0 };
    const frontal = Math.max(0, c * nx + s * nz);

    // Lose the speed into the wall (with a small bounce) and some of the speed along it, scaled by how hard the hit was.
    vx -= 1.25 * vn * nx;
    vz -= 1.25 * vn * nz;
    const scrub = Math.max(0.55, 1 - vn * 0.02);
    vx *= scrub;
    vz *= scrub;
    car.u = vx * c + vz * s;
    car.v = -vx * s + vz * c;
    car.r *= 0.5;
    return { impact: vn, frontal };
  }

  /** Puts the car back on the centreline at its current position along the lap, stopped and facing the right way. */
  resetCar(car: Car): void {
    const p = this.track.project(car.x, car.z, this.centreHint);
    const point = this.track.pointAt(p.s, 0);
    car.reset(point.x, point.z, point.heading);
    this.forgetPosition();
  }

  /** Call after moving the car by more than a few metres, so the next lookups search the whole circuit. */
  forgetPosition(): void {
    this.wheelHints = [-1, -1, -1, -1];
    this.centreHint = -1;
  }

  /** True when all four wheels are off the track and kerbs, which breaks track limits. */
  allWheelsOff(car: Car): boolean {
    return car.wheelSurface.every((k) => k === 'grass');
  }
}
