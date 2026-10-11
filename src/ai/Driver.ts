import { clamp, wrapAngle } from '../math.ts';
import type { Car, CarControls } from '../physics/Car.ts';
import type { Track, TrackProjection } from '../track/Track.ts';
import type { RacingLine } from './racingLine.ts';

export interface DriverSkill {
  /** Fraction of the racing line's target speed the driver dares to carry (0.9 cautious .. 1.0 on the limit). */
  pace: number;
  /** Extra lateral offset from the line, for overtaking or defending. */
  laneOffset: number;
}

/**
 * AI driver: follows the racing line with pure-pursuit steering and holds the line's speed profile with throttle and
 * brake. It drives the same car physics the player does, through the same controls.
 */
export class Driver {
  readonly skill: DriverSkill;
  private readonly track: Track;
  private readonly line: RacingLine;
  private hint = -1;
  projection: TrackProjection | null = null;

  constructor(track: Track, line: RacingLine, skill: DriverSkill) {
    this.track = track;
    this.line = line;
    this.skill = skill;
  }

  /** Target point on the racing line `ahead` metres past distance s, shifted by the lane offset. */
  private target(s: number, ahead: number, lane: number): [number, number] {
    const t = this.track;
    const f = t.wrapS(s + ahead) / t.spacing;
    const i = Math.floor(f) % t.count;
    const j = t.wrap(i + 1);
    const u = f - Math.floor(f);
    const off = (this.line.offset[i] * (1 - u) + this.line.offset[j] * u + lane);
    const limit = t.halfWidth - 1.2;
    const o = clamp(off, -limit, limit);
    const cx = t.xs[i] + (t.xs[j] - t.xs[i]) * u;
    const cz = t.zs[i] + (t.zs[j] - t.zs[i]) * u;
    return [cx - t.tz[i] * o, cz + t.tx[i] * o];
  }

  /** Target speed: the slowest point a short distance ahead, so braking starts in time. */
  targetSpeed(s: number, speed: number): number {
    const t = this.track;
    const look = 4 + speed * 0.25;
    let v = Infinity;
    for (let d = 0; d <= look; d += t.spacing) {
      const i = Math.floor(t.wrapS(s + d) / t.spacing) % t.count;
      v = Math.min(v, this.line.speed[i]);
    }
    return v * this.skill.pace;
  }

  drive(car: Car): CarControls {
    const p = this.track.project(car.x, car.z, this.hint);
    this.hint = p.index;
    this.projection = p;
    const speed = Math.abs(car.u);

    // Pure pursuit: steer along the arc that reaches a point on the line ahead.
    const lookahead = 7 + speed * 0.32;
    const [tx, tz] = this.target(p.s, lookahead, this.skill.laneOffset);
    const alpha = wrapAngle(Math.atan2(tz - car.z, tx - car.x) - car.yaw);
    const L = car.spec.wheelbase;
    const wheelAngle = Math.atan2(2 * L * Math.sin(alpha), lookahead);
    // Counter the car's own yaw rate a little so it doesn't weave.
    const yawDamp = -car.r * 0.02;
    let steer = clamp((wheelAngle + yawDamp) / car.maxSteerAt(speed), -1, 1);

    const vTarget = this.targetSpeed(p.s, speed);
    const err = vTarget - speed;
    let throttle = 0;
    let brake = 0;
    if (err > -0.5) {
      // Progressive throttle, and less of it while the steering is wound on.
      throttle = clamp(0.25 + err * 0.3, 0, 1) * (1 - 0.45 * Math.max(0, Math.abs(steer) - 0.4));
    } else if (err < -2) {
      brake = clamp(-err * 0.08, 0, 1);
      // Trail-brake gently when already cornering hard; heavy braking mid-corner unsettles the rear.
      brake *= clamp(1 - (Math.abs(car.gLat) - 2) / 3, 0.3, 1);
    }

    // Catching a slide: off the brakes, a little throttle to settle the rear, and opposite lock in proportion to how
    // far the car is sliding rather than full lock, which would snap it the other way.
    const sideslip = Math.atan2(car.v, Math.max(Math.abs(car.u), 1));
    if (car.slide > 0.35 && speed > 8) {
      brake = 0;
      throttle = Math.min(throttle, 0.25);
      steer = clamp(steer * 0.5 + (sideslip / car.maxSteerAt(speed)) * 0.6, -1, 1);
    }

    return { throttle, brake, steer, shiftUp: false, shiftDown: false };
  }
}
