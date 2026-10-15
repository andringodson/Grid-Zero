import { Driver, type DriverSkill } from '../ai/Driver.ts';
import { planTraffic, type TrafficCar } from '../ai/racecraft.ts';
import type { RacingLine } from '../ai/racingLine.ts';
import { Car, type Assists, type CarControls } from '../physics/Car.ts';
import type { CarSpec } from '../physics/carSpec.ts';
import { resolveCollisions } from '../physics/collisions.ts';
import type { TyreCompound } from '../physics/tyre.ts';
import type { Track } from '../track/Track.ts';
import { BLANKET_TEMP, limitEnd, PIT_APPROACH, pitLine, pitU } from './pits.ts';
import { World } from './World.ts';

/** A car's trip through the pits, driven by its own pit driver: in to the box, the stop, and out. */
export interface PitStop {
  driver: Driver;
  phase: 'in' | 'service' | 'out';
  compound: TyreCompound;
  /** Seconds left in the stop while in service. */
  timer: number;
  /** How long the stop takes, seconds. */
  stopTime: number;
}

export interface FieldCar {
  id: string;
  car: Car;
  world: World;
  /** Null for the player, whose controls come from input. */
  driver: Driver | null;
  /** Hardest barrier or car contact this frame, m/s. */
  impact: number;
  /** Seconds an AI car has been stopped or pointing the wrong way. */
  stuck: number;
  /** Distance along the lap of the team's pit box. */
  box: number;
  /** Set while the car is in the pits. */
  pit: PitStop | null;
  /** An AI car told to pit next time by: the tyres to fit. */
  pitRequest: TyreCompound | null;
}

/** Pit crews drive cars through the pits like a robot: no mistakes, exactly the limit. */
const PIT_SKILL: DriverSkill = { pace: 1, laneOffset: 0 };
/** A stop: wheels off and on, and a nose change on top when the front wing is damaged. */
const TYRE_CHANGE = 2.2;
const NOSE_CHANGE = 5;

/** An AI car stopped or facing backwards this long is put back on track. */
const RECOVER_AFTER = 2.5;
/** Slipstream reaches this far behind a car; dirty air (lost downforce) is shorter. */
const TOW_RANGE = 70;
const DIRTY_AIR_RANGE = 35;
/** Wake width: cars further apart sideways than this are in clean air. */
const WAKE_WIDTH = 3;
/** Frontal impacts below this closing speed (m/s) don't hurt the front wing. */
const DAMAGE_THRESHOLD = 9;

const AI_ASSISTS: Assists = { steering: true, autoGears: true, tractionControl: true, abs: true };

/** Every car on track: physics, AI driving, traffic and contact. No rendering, so it also runs in tests. */
export class Field {
  readonly track: Track;
  readonly line: RacingLine;
  readonly cars: FieldCar[] = [];
  private wasHeld = false;
  /** Water on the track, 0 to 1, from the weather. */
  wetness = 0;
  /** The tyres a car gets when it drives into the pits without being called in (the player): the same again by default. */
  pitTyres: (fc: FieldCar) => TyreCompound = (fc) => fc.car.compound;

  constructor(track: Track, line: RacingLine) {
    this.track = track;
    this.line = line;
  }

  addPlayer(id: string, car: Car, world: World): FieldCar {
    world.setRacingLine(this.line.offset);
    const fc: FieldCar = { id, car, world, driver: null, impact: 0, stuck: 0, box: this.track.pit?.boxes[0] ?? 0, pit: null, pitRequest: null };
    this.cars.push(fc);
    return fc;
  }

  addAI(id: string, spec: CarSpec, skill: DriverSkill, slot: number): FieldCar {
    const car = new Car(spec, AI_ASSISTS);
    const g = this.track.gridSlot(slot);
    car.reset(g.x, g.z, g.heading);
    const world = new World(this.track, car);
    world.setRacingLine(this.line.offset);
    const fc: FieldCar = {
      id,
      car,
      world,
      driver: new Driver(this.track, this.line, skill),
      impact: 0,
      stuck: 0,
      box: this.track.pit?.boxes[0] ?? 0,
      pit: null,
      pitRequest: null,
    };
    this.cars.push(fc);
    return fc;
  }

  removeAI(): void {
    for (let i = this.cars.length - 1; i >= 0; i--) if (this.cars[i].driver) this.cars.splice(i, 1);
  }

  private checkStuck(fc: FieldCar, dt: number): void {
    const p = fc.world.projection;
    const facing = Math.cos(fc.car.yaw - p.heading);
    if (Math.abs(fc.car.u) < 2 || facing < 0) fc.stuck += dt;
    else fc.stuck = 0;
    if (fc.stuck > RECOVER_AFTER && this.clearBehind(fc)) {
      fc.world.resetCar(fc.car);
      fc.stuck = 0;
    }
  }

  /** True when no other car is about to arrive at this car's spot, so it can rejoin without being hit. */
  private clearBehind(fc: FieldCar): boolean {
    const s = fc.world.projection.s;
    return this.cars.every((o) => {
      if (o === fc) return true;
      const behind = this.track.wrapS(s - o.world.projection.s);
      return behind > 120 || behind < 0.5 || this.track.length - behind < 15;
    });
  }

  /** Traffic planning and the air each car is driving through: once per frame is plenty. */
  plan(): void {
    const traffic: TrafficCar[] = this.cars.map((fc) => ({
      id: fc.id,
      s: fc.world.projection.s,
      lateral: fc.world.projection.lateral,
      speed: Math.abs(fc.car.u),
    }));
    traffic.forEach((self, i) => {
      const fc = this.cars[i];
      // In the pits there is no racing: just don't drive into the car ahead.
      if (fc.pit) fc.pit.driver.speedCap = this.pitTraffic(self, traffic);
      else if (fc.driver) planTraffic(fc.driver, self, traffic, this.track);
      this.updateAir(fc.car, self, traffic);
    });
  }

  private pitTraffic(self: TrafficCar, traffic: readonly TrafficCar[]): number {
    let cap = Infinity;
    for (const o of traffic) {
      if (o.id === self.id || Math.abs(o.lateral - self.lateral) > 2.6) continue;
      const ahead = this.track.wrapS(o.s - self.s);
      if (ahead > 0.5 && ahead < 15) cap = Math.min(cap, ahead < 8 ? 0 : o.speed);
    }
    return cap;
  }

  /** Tells an AI car to pit next time by for these tyres; refused while its team-mate is using the box. */
  requestPit(fc: FieldCar, compound: TyreCompound): boolean {
    if (fc.pit || this.cars.some((o) => o !== fc && o.box === fc.box && (o.pit || o.pitRequest))) return false;
    fc.pitRequest = compound;
    return true;
  }

  /** Abandons any stop in progress, e.g. when a car is put back on the grid. */
  cancelPit(fc: FieldCar): void {
    fc.pit = null;
    fc.pitRequest = null;
    if (fc.driver) fc.driver.hint = -1;
  }

  private startPit(fc: FieldCar, compound: TyreCompound): void {
    fc.pit = { driver: new Driver(this.track, pitLine(this.track, this.line, fc.box, true), PIT_SKILL), phase: 'in', compound, timer: 0, stopTime: 0 };
    fc.pitRequest = null;
  }

  /**
   * Pit stops: an AI car that has been called in turns off on the approach; any car driven onto the pit road (the
   * player) is committed to a stop. From there the pit driver takes it to the box, the crew changes tyres (and the
   * nose if damaged), and it drives out, handing back at the end of the speed limit (the player) or once back on the
   * racing line (AI). Returns the controls to use, 'parked' during the stop, or null when the car isn't pitting.
   */
  private pitControls(fc: FieldCar, dt: number): CarControls | 'parked' | null {
    const track = this.track;
    const pit = track.pit;
    if (!pit) return null;
    const p = fc.world.projection;
    const u = pitU(track, p.s);
    if (!fc.pit) {
      if (fc.pitRequest && u > -PIT_APPROACH && u < -PIT_APPROACH + 40) this.startPit(fc, fc.pitRequest);
      else if (
        !fc.driver &&
        u >= 0 &&
        u < track.pitDistance(pit.wallStart) &&
        Math.sign(p.lateral) === pit.side &&
        Math.abs(p.lateral) > track.halfWidth + 1.5
      ) {
        this.startPit(fc, this.pitTyres(fc));
      } else return null;
    }
    const stop = fc.pit!;
    const car = fc.car;
    if (stop.phase === 'in') {
      // The crew catches the car as it rolls into its marks.
      const toBox = track.pitDistance(fc.box) - track.pitDistance(p.s);
      if (toBox < 2 && toBox > -3 && Math.abs(car.u) < 6) {
        stop.phase = 'service';
        stop.stopTime = TYRE_CHANGE + Math.random() * 0.8 + (car.wingDamage > 0.1 ? NOSE_CHANGE : 0);
        stop.timer = stop.stopTime;
        return 'parked';
      }
    } else if (stop.phase === 'service') {
      stop.timer -= dt;
      if (stop.timer > 0) return 'parked';
      car.setTyres(BLANKET_TEMP, 0, stop.compound);
      car.wingDamage = 0;
      stop.driver = new Driver(track, pitLine(track, this.line, fc.box, false), PIT_SKILL);
      stop.phase = 'out';
    } else {
      const release = fc.driver ? track.pitDistance(pit.exit) + PIT_APPROACH : limitEnd(track);
      if (u > release) {
        this.cancelPit(fc);
        return null;
      }
    }
    return stop.driver.drive(car, dt);
  }

  /**
   * Behind another car the air is already moving: less drag (the tow down a straight) but also less downforce
   * (dirty air), which is why following closely through corners is hard.
   */
  private updateAir(car: Car, self: TrafficCar, traffic: readonly TrafficCar[]): void {
    let gap = Infinity;
    for (const o of traffic) {
      if (o.id === self.id || Math.abs(o.lateral - self.lateral) > WAKE_WIDTH) continue;
      const ahead = this.track.wrapS(o.s - self.s);
      if (ahead > 0.5 && ahead < gap) gap = ahead;
    }
    const tow = Math.max(0, 1 - gap / TOW_RANGE);
    const dirty = Math.max(0, 1 - gap / DIRTY_AIR_RANGE);
    car.airDrag = 1 - 0.3 * tow * tow;
    car.airDownforce = 1 - 0.25 * dirty;
  }

  private damage(car: Car, impact: number, frontal: number): void {
    if (impact < DAMAGE_THRESHOLD || frontal < 0.3) return;
    car.wingDamage = Math.min(1, car.wingDamage + ((impact - DAMAGE_THRESHOLD) / 15) * frontal);
  }

  beginFrame(): void {
    for (const fc of this.cars) fc.impact = 0;
  }

  /**
   * One physics step for every car; `player` controls the player's car. Held cars (on the grid before lights out)
   * stay parked: stepping them with the brake on would, after a moment, select reverse.
   */
  step(dt: number, player: CarControls, held: boolean): void {
    if (this.wasHeld && !held) for (const fc of this.cars) fc.driver?.startReaction();
    this.wasHeld = held;
    if (held) return;
    for (const fc of this.cars) {
      const pitting = this.pitControls(fc, dt);
      if (pitting === 'parked') {
        // Up on the jacks: the car doesn't move while the crew works.
        fc.car.u = 0;
        fc.car.v = 0;
        fc.car.r = 0;
        continue;
      }
      const controls = pitting ?? (fc.driver ? fc.driver.drive(fc.car, dt) : player);
      fc.car.wetness = this.wetness;
      fc.world.wetness = this.wetness;
      fc.world.applyTerrain(fc.car);
      fc.car.step(dt, controls, fc.world.probe);
      const hit = fc.world.constrain(fc.car);
      fc.impact = Math.max(fc.impact, hit.impact);
      this.damage(fc.car, hit.impact, hit.frontal);
      if (fc.driver && !fc.pit) this.checkStuck(fc, dt);
    }
    if (this.cars.length > 1) {
      for (const c of resolveCollisions(this.cars.map((fc) => fc.car))) {
        for (const fc of this.cars) {
          if (fc.car !== c.a && fc.car !== c.b) continue;
          fc.impact = Math.max(fc.impact, c.speed);
          // The wing takes the hit when the contact is at the nose.
          const ahead = (c.x - fc.car.x) * Math.cos(fc.car.yaw) + (c.z - fc.car.z) * Math.sin(fc.car.yaw);
          this.damage(fc.car, c.speed, ahead > 1.2 ? 1 : 0);
        }
      }
    }
  }
}
