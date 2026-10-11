import { Driver, type DriverSkill } from '../ai/Driver.ts';
import { planTraffic, type TrafficCar } from '../ai/racecraft.ts';
import type { RacingLine } from '../ai/racingLine.ts';
import { Car, type Assists, type CarControls } from '../physics/Car.ts';
import type { CarSpec } from '../physics/carSpec.ts';
import { resolveCollisions } from '../physics/collisions.ts';
import type { Track } from '../track/Track.ts';
import { World } from './World.ts';

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
}

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

  constructor(track: Track, line: RacingLine) {
    this.track = track;
    this.line = line;
  }

  addPlayer(id: string, car: Car, world: World): FieldCar {
    world.setRacingLine(this.line.offset);
    const fc: FieldCar = { id, car, world, driver: null, impact: 0, stuck: 0 };
    this.cars.push(fc);
    return fc;
  }

  addAI(id: string, spec: CarSpec, skill: DriverSkill, slot: number): FieldCar {
    const car = new Car(spec, AI_ASSISTS);
    const g = this.track.gridSlot(slot);
    car.reset(g.x, g.z, g.heading);
    const world = new World(this.track, car);
    world.setRacingLine(this.line.offset);
    const fc: FieldCar = { id, car, world, driver: new Driver(this.track, this.line, skill), impact: 0, stuck: 0 };
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
      if (fc.driver) planTraffic(fc.driver, self, traffic, this.track);
      this.updateAir(fc.car, self, traffic);
    });
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
    if (held) return;
    for (const fc of this.cars) {
      const controls = fc.driver ? fc.driver.drive(fc.car, dt) : player;
      fc.car.step(dt, controls, fc.world.probe);
      const hit = fc.world.constrain(fc.car);
      fc.impact = Math.max(fc.impact, hit.impact);
      this.damage(fc.car, hit.impact, hit.frontal);
      if (fc.driver) this.checkStuck(fc, dt);
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
