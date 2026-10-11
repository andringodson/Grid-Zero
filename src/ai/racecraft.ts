import { clamp } from '../math.ts';
import type { Track } from '../track/Track.ts';
import type { Driver } from './Driver.ts';

export interface TrafficCar {
  id: string;
  /** Distance along the lap. */
  s: number;
  lateral: number;
  speed: number;
}

/** Looks this far ahead for traffic. */
const AHEAD = 45;
/** Cars closer than this sideways are in the same lane. */
const LANE_WIDTH = 2.6;
/** Sideways spacing when passing. */
const PASS_SPACING = 3.3;
/** Following distance the driver settles at when it can't get by. */
const FOLLOW_GAP = 9;

/**
 * Traffic awareness for one AI driver: find the nearest car ahead in its lane, move to the side with more room when
 * closing on it, and hold station behind it when there's no room, instead of driving into it.
 */
export function planTraffic(driver: Driver, self: TrafficCar, others: readonly TrafficCar[], track: Track): void {
  const limit = track.halfWidth - 1.3;
  let blocker: TrafficCar | null = null;
  let blockerGap = Infinity;
  let alongside: TrafficCar | null = null;
  for (const o of others) {
    if (o.id === self.id) continue;
    const ahead = track.wrapS(o.s - self.s);
    const gap = ahead > track.length / 2 ? ahead - track.length : ahead;
    const latDiff = o.lateral - self.lateral;
    if (Math.abs(gap) < 5.5 && Math.abs(latDiff) < LANE_WIDTH + 0.6) alongside = o;
    if (gap > 0 && gap < AHEAD && Math.abs(latDiff) < LANE_WIDTH && gap < blockerGap) {
      blocker = o;
      blockerGap = gap;
    }
  }

  const index = Math.floor(track.wrapS(self.s) / track.spacing) % track.count;
  const lineHere = driver.lineOffsetAt(index);
  driver.speedCap = Infinity;

  if (alongside) {
    // Give a car alongside room: move away from it.
    const away = Math.sign(self.lateral - alongside.lateral) || 1;
    driver.laneTarget = clamp(alongside.lateral + away * PASS_SPACING, -limit, limit) - lineHere;
    return;
  }

  if (!blocker) {
    driver.laneTarget = 0;
    return;
  }

  const closing = self.speed - blocker.speed;
  // Side-by-side into a heavy braking zone ends in contact; set passes up on the straights instead.
  const brakingAhead = driver.targetSpeed(self.s + 20, self.speed) < self.speed * 0.8;
  if (closing > -1 && !brakingAhead) {
    // Pass on the side with more track.
    const roomRight = limit - blocker.lateral;
    const roomLeft = blocker.lateral + limit;
    const side = roomRight >= roomLeft ? 1 : -1;
    const room = side > 0 ? roomRight : roomLeft;
    if (room >= PASS_SPACING - 0.3) {
      driver.laneTarget = clamp(blocker.lateral + side * PASS_SPACING, -limit, limit) - lineHere;
    }
  }
  // Close behind in the same lane: don't run into the back of it. The window grows with closing speed, by the
  // distance needed to shed that speed difference, because a slower car ahead brakes earlier for corners.
  const window = FOLLOW_GAP + 12 + Math.max(0, closing) ** 2 / 30;
  if (blockerGap < window) {
    driver.speedCap = Math.max(5, blocker.speed + (blockerGap - FOLLOW_GAP) * 0.45);
  }
}
