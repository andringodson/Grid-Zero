import type { RacingLine } from '../ai/racingLine.ts';
import type { Track } from '../track/Track.ts';

/** The racing line's ideal lap: its speed profile driven exactly, seconds. */
export function idealLap(track: Track, line: RacingLine): number {
  let t = 0;
  for (let i = 0; i < track.count; i++) t += track.spacing / line.speed[i];
  return t;
}

/**
 * An AI driver's flying lap at `pace`, as a multiple of the ideal lap. Fitted to AI laps measured on Halden Ring
 * (pace 0.86 to 0.985, dry, mediums): drivers lose time everywhere, not just in proportion to pace. Other circuits
 * scale it by their measured `lapScale`.
 */
export function aiLapTime(ideal: number, pace: number, scale = 1): number {
  return ideal * (0.374 + 0.823 / pace) * scale;
}

/** Grid slots by qualifying time, fastest on pole; a car with no time (Infinity) starts from the back. */
export function gridSlots(times: readonly number[]): number[] {
  const order = times.map((_, i) => i).sort((a, b) => times[a] - times[b]);
  const slots = new Array<number>(times.length);
  order.forEach((entry, slot) => (slots[entry] = slot));
  return slots;
}
