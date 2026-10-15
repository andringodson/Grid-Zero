import type { RacingLine } from '../ai/racingLine.ts';
import type { Car } from '../physics/Car.ts';
import { COMPOUNDS, type TyreCompound } from '../physics/tyre.ts';
import type { Track } from '../track/Track.ts';

/** Pit lane speed limit: 80 km/h. */
export const PIT_SPEED = 80 / 3.6;
/** Tyres come out of the blankets at this temperature, below their window, so an out-lap needs care. */
export const BLANKET_TEMP = 80;
/** A car heading for the pits starts moving across this far before the pit entry. */
export const PIT_APPROACH = 150;
/** The speed limit starts this far before the pit wall and ends this far after it. */
const LIMIT_BEFORE = 30;
const LIMIT_AFTER = 20;
/** Braking for the speed-limit line, and gently into the box, m/s². */
const LIMIT_DECEL = 25;
const STOP_DECEL = 5;
/** Distance over which a car turns from the fast lane into its box, and back out. */
const BOX_TURN = 30;

const smoothstep = (t: number) => {
  const x = Math.min(1, Math.max(0, t));
  return x * x * (3 - 2 * x);
};

/** Metres from the pit entry: negative over the half lap before it, positive over the half lap after. */
export function pitU(track: Track, s: number): number {
  const u = track.pitDistance(s);
  return u > track.length / 2 ? u - track.length : u;
}

/** Where the speed limit ends, in metres from the pit entry. */
export function limitEnd(track: Track): number {
  return track.pitDistance(track.pit!.wallEnd) + LIMIT_AFTER;
}

/**
 * The line through the pits to the box at distance `box` along the lap: the racing line until the approach, across
 * to the pit road, along the fast lane at the speed limit, into the box and out, then back to the racing line after
 * the exit. With `stop` it brakes to a halt in the box; without, it is the way out after the stop.
 */
export function pitLine(track: Track, line: RacingLine, box: number, stop: boolean): RacingLine {
  const pit = track.pit!;
  const side = pit.side;
  const A = track.pitDistance(pit.wallStart);
  const B = track.pitDistance(pit.wallEnd);
  const C = track.pitDistance(pit.exit);
  const boxU = track.pitDistance(box);
  const entryLane = track.halfWidth - 1.5;
  const exitLane = track.halfWidth - 2.5;
  const offset = Float64Array.from(line.offset);
  const speed = Float64Array.from(line.speed);
  for (let i = 0; i < track.count; i++) {
    const u = pitU(track, i * track.spacing);
    if (u < -PIT_APPROACH || u > C + PIT_APPROACH) continue;
    const race = line.offset[i];
    let lateral: number;
    if (u < 0) lateral = race + (side * entryLane - race) * smoothstep((u + PIT_APPROACH) / PIT_APPROACH);
    else if (u < A) lateral = side * (entryLane + (pit.lane - entryLane) * smoothstep(u / A));
    else if (u <= B) {
      const into = smoothstep((u - (boxU - BOX_TURN)) / BOX_TURN);
      const outOf = smoothstep((u - boxU) / BOX_TURN);
      lateral = side * (pit.lane + (pit.box - pit.lane) * (u <= boxU ? into : 1 - outOf));
    } else if (u < C) lateral = side * (pit.lane + (exitLane - pit.lane) * smoothstep((u - B) / (C - B)));
    else lateral = side * exitLane + (race - side * exitLane) * smoothstep((u - C) / PIT_APPROACH);
    offset[i] = lateral;

    let v = line.speed[i];
    if (u < A - LIMIT_BEFORE) v = Math.min(v, Math.sqrt(PIT_SPEED ** 2 + 2 * LIMIT_DECEL * (A - LIMIT_BEFORE - u)));
    else if (u <= B + LIMIT_AFTER) v = Math.min(v, PIT_SPEED);
    if (stop && u <= boxU) v = Math.min(v, Math.sqrt(2 * STOP_DECEL * (boxU - u)));
    speed[i] = v;
  }
  return { ...line, offset, speed };
}

const isSlick = (c: TyreCompound) => c.id !== 'inter' && c.id !== 'wet';

/**
 * The tyres for the conditions, as a team would call it: full wets in standing water, intermediates on a damp track,
 * and in the dry the current slick (fresh) or `dry` when coming off rain tyres.
 */
export function tyresFor(wetness: number, current: TyreCompound, dry: TyreCompound): TyreCompound {
  if (wetness > 0.55) return COMPOUNDS.wet;
  if (wetness > 0.25) return COMPOUNDS.inter;
  return isSlick(current) ? current : dry;
}

/** True when the tyres fitted are the wrong kind for the track: slicks in the wet, or rain tyres on a drying one. */
export function wrongTyres(wetness: number, current: TyreCompound): boolean {
  return tyresFor(wetness, current, COMPOUNDS.medium).id !== current.id && (isSlick(current) || wetness < 0.15 || wetness > 0.6);
}

/**
 * An AI car's pit call on the approach: the tyres to fit, or null to stay out. It pits when its tyres are wrong for
 * the track (each driver reads the conditions a little differently, so they don't all come in on the same lap) or
 * its nose is broken.
 */
export function aiPitCall(id: string, car: Car, wetness: number): TyreCompound | null {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) % 101;
  const feel = wetness + (h % 11) / 100 - 0.05;
  if (!wrongTyres(feel, car.compound) && car.wingDamage <= 0.3) return null;
  return tyresFor(wetness, car.compound, COMPOUNDS.medium);
}
