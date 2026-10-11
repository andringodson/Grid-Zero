import type { DrsZone } from './drs.ts';

export type RacePhase = 'lights' | 'racing' | 'finished';

export interface RaceEntrant {
  id: string;
  name: string;
  /** Three-letter code for the timing tower. */
  code: string;
  teamName: string;
  colour: string;
  isPlayer: boolean;
}

export interface Standing {
  entrant: RaceEntrant;
  /** Distance covered since the start line, in metres; negative while behind the line on the grid. */
  progress: number;
  /** Laps started (1 after first crossing the line). */
  lap: number;
  finished: boolean;
  finishTime: number | null;
  bestLap: number | null;
  lastLap: number | null;
  /** Seconds behind the leader at the same point on the track. */
  gap: number;
  /** Track-limit offences so far, and time penalties (s) added to the finishing time. */
  warnings: number;
  penalty: number;
  /** Index of the DRS zone this car is cleared to use, or -1. */
  drsZone: number;
}

export interface RaceOptions {
  drsZones?: readonly DrsZone[];
  /** DRS is enabled from this lap; real races wait two laps after the start. */
  drsFromLap?: number;
  random?: () => number;
}

/** Track-limit offences allowed before penalties start, and the penalty for each one after that. */
const FREE_WARNINGS = 3;
const LIMITS_PENALTY = 5;
/** Within this many seconds of the car ahead at a detection point, DRS is enabled for the zone. */
const DRS_GAP = 1;

export type RaceEvent =
  | { type: 'light'; count: number }
  | { type: 'lightsOut' }
  | { type: 'lap'; entrant: RaceEntrant; lap: number; time: number }
  | { type: 'finish'; entrant: RaceEntrant; position: number; time: number }
  | { type: 'trackLimits'; entrant: RaceEntrant; warnings: number; penalty: number }
  | { type: 'drs'; entrant: RaceEntrant; enabled: boolean };

const LIGHT_INTERVAL = 1;
const CHECKPOINT = 25;

interface State extends Standing {
  prevS: number;
  lapStart: number;
}

/**
 * A race from a standing start: five red lights, a random hold, lights out. Each car's progress is its distance
 * along the track unwrapped across the line, so positions are just progress order. Gaps come from the time the
 * first car passed each 25 m checkpoint.
 */
export class Race {
  readonly laps: number;
  readonly length: number;
  phase: RacePhase = 'lights';
  /** Seconds since lights out. */
  time = 0;
  lights = 0;
  private lightsClock = 0;
  private readonly holdAfterLights: number;
  private readonly states: State[];
  private readonly checkpoints: number[] = [];
  private finishers = 0;
  private readonly drsZones: readonly DrsZone[];
  private readonly drsFromLap: number;

  constructor(length: number, laps: number, entrants: RaceEntrant[], startS: number[], options: RaceOptions = {}) {
    this.length = length;
    this.laps = laps;
    this.drsZones = options.drsZones ?? [];
    this.drsFromLap = options.drsFromLap ?? 3;
    this.holdAfterLights = 0.4 + (options.random ?? Math.random)() * 1.6;
    this.states = entrants.map((entrant, i) => {
      const s = startS[i];
      const progress = s > length / 2 ? s - length : s;
      return {
        entrant,
        progress,
        prevS: s,
        lap: progress < 0 ? 0 : 1,
        lapStart: 0,
        finished: false,
        finishTime: null,
        bestLap: null,
        lastLap: null,
        gap: 0,
        warnings: 0,
        penalty: 0,
        drsZone: -1,
      };
    });
  }

  /** Classified time: finishing time plus penalties. */
  private classified(st: Standing): number {
    return st.finishTime! + st.penalty;
  }

  /** Records a track-limits offence: warnings first, then a time penalty for each further offence. */
  trackLimits(id: string): RaceEvent[] {
    const st = this.states.find((s) => s.entrant.id === id);
    if (!st || st.finished || this.phase !== 'racing') return [];
    st.warnings++;
    if (st.warnings > FREE_WARNINGS) st.penalty += LIMITS_PENALTY;
    return [{ type: 'trackLimits', entrant: st.entrant, warnings: st.warnings, penalty: st.penalty }];
  }

  /** True when this car may open its DRS flap at distance s. */
  drsAvailable(id: string, s: number): boolean {
    const st = this.states.find((x) => x.entrant.id === id);
    if (!st || st.drsZone < 0 || this.phase !== 'racing') return false;
    const zone = this.drsZones[st.drsZone];
    const along = (((s - zone.start) % this.length) + this.length) % this.length;
    const span = (((zone.end - zone.start) % this.length) + this.length) % this.length;
    return along <= span;
  }

  /** Cars must stay on the brakes until the lights go out. */
  get held(): boolean {
    return this.phase === 'lights';
  }

  standing(id: string): Standing {
    return this.states.find((s) => s.entrant.id === id)!;
  }

  /** Finished cars in finishing order, then everyone else by distance covered. */
  standings(): Standing[] {
    return [...this.states].sort((a, b) => {
      if (a.finished && b.finished) return this.classified(a) - this.classified(b);
      if (a.finished !== b.finished) return a.finished ? -1 : 1;
      return b.progress - a.progress;
    });
  }

  position(id: string): number {
    return this.standings().findIndex((s) => s.entrant.id === id) + 1;
  }

  update(dt: number, sOf: (id: string) => number): RaceEvent[] {
    const events: RaceEvent[] = [];
    if (this.phase === 'lights') {
      this.lightsClock += dt;
      const lit = Math.min(5, Math.floor(this.lightsClock / LIGHT_INTERVAL));
      if (lit > this.lights) {
        this.lights = lit;
        events.push({ type: 'light', count: lit });
      }
      if (this.lightsClock >= 5 * LIGHT_INTERVAL + this.holdAfterLights) {
        this.lights = 0;
        this.phase = 'racing';
        events.push({ type: 'lightsOut' });
      }
      return events;
    }

    this.time += dt;
    const finishLine = this.laps * this.length;
    const detections: [State, number][] = [];
    for (const st of this.states) {
      const s = sOf(st.entrant.id);
      let delta = s - st.prevS;
      if (delta < -this.length / 2) delta += this.length;
      else if (delta > this.length / 2) delta -= this.length;
      const fromS = st.prevS;
      st.prevS = s;
      if (st.finished) continue;
      if (delta > 0) {
        this.drsZones.forEach((zone, k) => {
          const toDetection = (((zone.detection - fromS) % this.length) + this.length) % this.length;
          if (toDetection > 0 && toDetection <= delta) detections.push([st, k]);
        });
      }
      const before = st.progress;
      st.progress += delta;

      // Crossed the line into a new lap (only counts going forwards).
      const lapNow = Math.floor(st.progress / this.length) + 1;
      if (st.progress >= 0 && lapNow > st.lap) {
        // Interpolate the crossing inside this step.
        const crossAt = this.time - dt * ((st.progress - (lapNow - 1) * this.length) / Math.max(delta, 1e-6));
        if (st.lap >= 1) {
          const lapTime = crossAt - st.lapStart;
          st.lastLap = lapTime;
          st.bestLap = st.bestLap === null ? lapTime : Math.min(st.bestLap, lapTime);
          events.push({ type: 'lap', entrant: st.entrant, lap: st.lap, time: lapTime });
        }
        st.lap = lapNow;
        st.lapStart = Math.max(0, crossAt);

        if (st.progress >= finishLine) {
          st.finished = true;
          st.finishTime = crossAt;
          st.progress = finishLine;
          this.finishers++;
          events.push({ type: 'finish', entrant: st.entrant, position: this.finishers, time: crossAt });
        }
      }

      // Gap to the leader: when did the first car pass this checkpoint?
      if (st.progress > 0) {
        const fromK = Math.max(0, Math.floor(before / CHECKPOINT) + 1);
        const toK = Math.floor(st.progress / CHECKPOINT);
        for (let k = fromK; k <= toK; k++) {
          if (this.checkpoints[k] === undefined) this.checkpoints[k] = this.time;
          // Both times are for the same point on track, so the difference is the true gap.
          st.gap = this.time - this.checkpoints[k];
        }
      }
    }
    // DRS detection: measured against the car directly ahead on the road, once positions are up to date.
    if (detections.length > 0) {
      const order = this.standings();
      for (const [st, k] of detections) {
        const pos = order.indexOf(st);
        const ahead = pos > 0 ? order[pos - 1] : null;
        const gapAhead = ahead && !ahead.finished ? st.gap - ahead.gap : Infinity;
        const enabled = st.lap >= this.drsFromLap && gapAhead >= 0 && gapAhead < DRS_GAP;
        st.drsZone = enabled ? k : -1;
        events.push({ type: 'drs', entrant: st.entrant, enabled });
      }
    }

    if (this.states.every((s) => s.finished)) this.phase = 'finished';
    return events;
  }

  /** Ends the race for everyone still running (e.g. once the player has finished and seen the flag). */
  close(): void {
    this.phase = 'finished';
  }
}
