export interface LapRecord {
  lap: number;
  time: number;
  sectors: number[];
  valid: boolean;
  /** Elapsed lap time at every TRACE_STEP metres, for the live delta and the ghost. */
  trace: number[];
}

export type TimingEvent =
  | { type: 'sector'; index: number; time: number; personalBest: boolean }
  | { type: 'lap'; record: LapRecord; personalBest: boolean }
  | { type: 'invalidated'; reason: 'track-limits' | 'reset' | 'reversed' };

export const TRACE_STEP = 10;
/** How close to the line (either side) a jump in distance counts as crossing it rather than a teleport. */
const LINE_WINDOW = 150;

/**
 * Times laps from a car's distance along the circuit. A lap counts only if the car has passed every sector in order,
 * so cutting back across the line doesn't produce a lap. Crossing times are interpolated within the physics step.
 */
export class LapTimer {
  readonly length: number;
  readonly sectorStarts: readonly number[];

  lap = 0;
  lapTime = 0;
  /** False until the car first crosses the line; the out-lap isn't timed. */
  started = false;
  valid = true;
  sector = 0;
  currentSectors: number[] = [];
  best: LapRecord | null = null;
  last: LapRecord | null = null;
  bestSectors: (number | null)[];

  private prevS = -1;
  private sectorStartTime = 0;
  private trace: number[] = [];

  constructor(length: number, sectorStarts: readonly number[], best: LapRecord | null = null) {
    this.length = length;
    this.sectorStarts = sectorStarts;
    this.best = best;
    this.bestSectors = sectorStarts.map((_, i) => best?.sectors[i] ?? null);
  }

  /** Time gained (negative) or lost (positive) against the best lap at the current distance; null without a best. */
  delta(s: number): number | null {
    if (!this.started || !this.best) return null;
    const trace = this.best.trace;
    const f = s / TRACE_STEP;
    const i = Math.floor(f);
    if (i + 1 >= trace.length) return null;
    const ref = trace[i] + (trace[i + 1] - trace[i]) * (f - i);
    return this.lapTime - ref;
  }

  invalidate(reason: 'track-limits' | 'reset' | 'reversed'): TimingEvent[] {
    if (!this.started || !this.valid) return [];
    this.valid = false;
    return [{ type: 'invalidated', reason }];
  }

  update(s: number, dt: number, offTrack: boolean): TimingEvent[] {
    const events: TimingEvent[] = [];
    const prev = this.prevS;
    this.prevS = s;
    if (prev < 0) return events;

    const L = this.length;
    const crossedForward = prev > L - LINE_WINDOW && s < LINE_WINDOW;
    const crossedBackward = prev < LINE_WINDOW && s > L - LINE_WINDOW;

    if (crossedBackward) {
      events.push(...this.invalidate('reversed'));
      // No sector in progress: crossing forward again starts a fresh lap rather than finishing this one.
      this.sector = -1;
      return events;
    }

    if (crossedForward) {
      // Fraction of this step taken before reaching the line.
      const before = L - prev;
      const after = s;
      const f = before + after > 0 ? before / (before + after) : 1;
      const crossTime = this.lapTime + dt * f;
      if (this.started && this.sector === this.sectorStarts.length - 1) {
        events.push(...this.finishLap(crossTime));
      }
      this.startLap(dt * (1 - f));
      this.recordTrace(s);
      return events;
    }

    if (!this.started) return events;
    this.lapTime += dt;

    // Sector boundaries.
    const next = this.sector + 1;
    if (next < this.sectorStarts.length) {
      const boundary = this.sectorStarts[next];
      if (prev < boundary && s >= boundary && s - prev < LINE_WINDOW) {
        const f = (boundary - prev) / (s - prev);
        const at = this.lapTime - dt * (1 - f);
        events.push(this.closeSector(this.sector, at - this.sectorStartTime));
        this.sectorStartTime = at;
        this.sector = next;
      }
    }

    if (offTrack) events.push(...this.invalidate('track-limits'));
    this.recordTrace(s);
    return events;
  }

  private recordTrace(s: number): void {
    const bucket = Math.floor(s / TRACE_STEP);
    while (this.trace.length <= bucket) this.trace.push(this.lapTime);
  }

  private closeSector(index: number, time: number): TimingEvent {
    this.currentSectors[index] = time;
    const pb = this.valid && (this.bestSectors[index] === null || time < this.bestSectors[index]!);
    if (pb) this.bestSectors[index] = time;
    return { type: 'sector', index, time, personalBest: pb };
  }

  private finishLap(time: number): TimingEvent[] {
    const events: TimingEvent[] = [];
    const lastSector = this.sectorStarts.length - 1;
    events.push(this.closeSector(lastSector, time - this.sectorStartTime));
    const record: LapRecord = {
      lap: this.lap,
      time,
      sectors: [...this.currentSectors],
      valid: this.valid,
      trace: [...this.trace],
    };
    // The trace must end at the lap time so the delta works right up to the line.
    record.trace.push(time);
    const pb = record.valid && (!this.best || time < this.best.time);
    if (pb) this.best = record;
    this.last = record;
    events.push({ type: 'lap', record, personalBest: pb });
    return events;
  }

  private startLap(carriedTime: number): void {
    this.started = true;
    this.lap++;
    this.lapTime = carriedTime;
    this.sectorStartTime = 0;
    this.sector = 0;
    this.valid = true;
    this.currentSectors = [];
    this.trace = [];
  }
}

export function formatLapTime(t: number | null | undefined): string {
  if (t === null || t === undefined || !isFinite(t)) return '--:--.---';
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${m}:${s.toFixed(3).padStart(6, '0')}`;
}

export function formatDelta(d: number | null): string {
  if (d === null) return '';
  return `${d < 0 ? '-' : '+'}${Math.abs(d).toFixed(3)}`;
}
