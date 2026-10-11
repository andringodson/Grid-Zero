import type { Car, SurfaceProbe, WheelSurface } from '../physics/Car.ts';
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
}

/** Puts a car on a track: surfaces under its wheels, barrier contact, and returning it to the circuit. */
export class World {
  readonly track: Track;
  private wheelHints = [-1, -1, -1, -1];
  private centreHint = -1;
  projection: TrackProjection;

  constructor(track: Track, car: Car) {
    this.track = track;
    this.projection = track.project(car.x, car.z);
  }

  readonly probe: SurfaceProbe = (x, z, wheel) => {
    const p = this.track.project(x, z, this.wheelHints[wheel]);
    this.wheelHints[wheel] = p.index;
    return SURFACES[this.track.surfaceAt(p)];
  };

  /** Runs after each physics step: keeps the car inside the barriers. */
  constrain(car: Car): StepResult {
    const p = this.track.project(car.x, car.z, this.centreHint);
    this.centreHint = p.index;
    this.projection = p;
    const limit = this.track.barrierAt(p) - CAR_HALF_WIDTH;
    const excess = Math.abs(p.lateral) - limit;
    if (excess <= 0) return { impact: 0 };

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
    if (vn <= 0) return { impact: 0 };

    // Lose the speed into the wall (with a small bounce) and some of the speed along it, scaled by how hard the hit was.
    vx -= 1.25 * vn * nx;
    vz -= 1.25 * vn * nz;
    const scrub = Math.max(0.55, 1 - vn * 0.02);
    vx *= scrub;
    vz *= scrub;
    car.u = vx * c + vz * s;
    car.v = -vx * s + vz * c;
    car.r *= 0.5;
    return { impact: vn };
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
