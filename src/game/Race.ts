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
}

export type RaceEvent =
  | { type: 'light'; count: number }
  | { type: 'lightsOut' }
  | { type: 'lap'; entrant: RaceEntrant; lap: number; time: number }
  | { type: 'finish'; entrant: RaceEntrant; position: number; time: number };

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

  constructor(length: number, laps: number, entrants: RaceEntrant[], startS: number[], random: () => number = Math.random) {
    this.length = length;
    this.laps = laps;
    this.holdAfterLights = 0.4 + random() * 1.6;
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
      };
    });
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
      if (a.finished && b.finished) return a.finishTime! - b.finishTime!;
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
    for (const st of this.states) {
      const s = sOf(st.entrant.id);
      let delta = s - st.prevS;
      if (delta < -this.length / 2) delta += this.length;
      else if (delta > this.length / 2) delta -= this.length;
      st.prevS = s;
      if (st.finished) continue;
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
    if (this.states.every((s) => s.finished)) this.phase = 'finished';
    return events;
  }

  /** Ends the race for everyone still running (e.g. once the player has finished and seen the flag). */
  close(): void {
    this.phase = 'finished';
  }
}
