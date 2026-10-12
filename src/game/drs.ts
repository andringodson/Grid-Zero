import type { Track } from '../track/Track.ts';

export interface DrsZone {
  /** Where the gap to the car ahead is measured. */
  detection: number;
  /** Where the flap may open, and where the zone ends (before the braking point). */
  start: number;
  end: number;
}

/** Bends gentler than this radius count as straight. */
const STRAIGHT_RADIUS = 700;
/** A straight must be at least this long to get a zone. */
const MIN_STRAIGHT = 450;

/** Distance from a to b going forward round the lap. */
export function forwardDistance(track: Track, a: number, b: number): number {
  return track.wrapS(b - a);
}

/** True if s lies within a zone, allowing for zones that cross the start/finish line. */
export function inZone(track: Track, zone: DrsZone, s: number): boolean {
  return forwardDistance(track, zone.start, s) <= forwardDistance(track, zone.start, zone.end);
}

/**
 * DRS zones on every long straight: the flap may open 60 m after the corner exit until 100 m before the next
 * braking zone; detection is just before the corner that leads onto the straight, as on real circuits.
 */
export function findDrsZones(track: Track): DrsZone[] {
  const straight = (i: number) => Math.abs(track.curvature[track.wrap(i)]) < 1 / STRAIGHT_RADIUS;
  // Start scanning from a bend so no run is split across the end of the arrays.
  let origin = 0;
  while (straight(origin) && origin < track.count) origin++;
  const zones: DrsZone[] = [];
  let runStart = -1;
  for (let k = 1; k <= track.count; k++) {
    const i = origin + k;
    if (straight(i) && runStart < 0) runStart = i;
    if ((!straight(i) || k === track.count) && runStart >= 0) {
      const length = (i - runStart) * track.spacing;
      if (length >= MIN_STRAIGHT) {
        const s0 = runStart * track.spacing;
        const s1 = i * track.spacing;
        zones.push({
          detection: track.wrapS(s0 - 120),
          start: track.wrapS(s0 + 60),
          end: track.wrapS(s1 - 100),
        });
      }
      runStart = -1;
    }
  }
  return zones;
}
