import { approach, clamp, damp, interpolateTable } from '../math.ts';
import type { CarSpec } from './carSpec.ts';
import { COMPOUNDS, compoundGrip, loadSensitiveMu, pacejka, peakSlip, tyreCondition, type TyreCompound } from './tyre.ts';

export interface CarControls {
  /** 0..1 */
  throttle: number;
  /** 0..1 */
  brake: number;
  /** -1 (full left) .. 1 (full right) */
  steer: number;
  /** True only on the step the shift was requested. */
  shiftUp: boolean;
  shiftDown: boolean;
}

export interface Assists {
  /** Limits steering lock to what the front tyres can use at the current speed. */
  steering: boolean;
  autoGears: boolean;
  tractionControl: boolean;
  abs: boolean;
}

export type SurfaceKind = 'track' | 'kerb' | 'grass' | 'gravel' | 'runoff';

export interface WheelSurface {
  kind: SurfaceKind;
  /** Grip multiplier relative to dry asphalt. */
  grip: number;
  /** Extra rolling resistance coefficient on top of the tyre's own. */
  drag: number;
}

/** Reports the surface under a wheel at a world position. Wheel order: FL, FR, RL, RR. */
export type SurfaceProbe = (x: number, z: number, wheel: number) => WheelSurface;

export const NEUTRAL_CONTROLS: CarControls = { throttle: 0, brake: 0, steer: 0, shiftUp: false, shiftDown: false };

const G = 9.81;
const AIR_DENSITY = 1.225;
const RPM_PER_RAD_S = 60 / (2 * Math.PI);

/** Below this state of charge the hybrid motor deploys less, so the battery tapers rather than running flat. */
const ERS_TAPER = 0.5;
/** Energy the exhaust turbine recovers at full throttle and maximum revs, W. */
const MGUH_POWER = 60000;

/** Track-day ambient air and tarmac, deg C. */
const AMBIENT = 25;
/** Joules to raise a tyre's working surface layer by 1 deg C. */
const TYRE_HEAT_CAPACITY = 9500;
/** Rear tyres are about 30% wider than the fronts; relative thermal mass of the working layer. */
const REAR_TYRE_MASS = 1.15;
/** Heating from carcass flex, per newton of load per m/s. */
const TYRE_FLEX_HEAT = 5.5e-6;
/** Cooling rate toward ambient at standstill, per second; airflow raises it with speed. */
const TYRE_COOLING = 0.012;
/** Wear per joule of sliding energy: about 1.5% per clean lap of Halden Ring. */
const TYRE_WEAR_PER_JOULE = 3.6e-8;

/**
 * Single-track vehicle model with per-wheel loads. Heading `yaw` points the car along (cos, sin) in the x-z plane;
 * body-frame velocity is `u` forward and `v` to the right; `r` is yaw rate, positive turning right.
 */
export class Car {
  readonly spec: CarSpec;
  assists: Assists;

  x = 0;
  z = 0;
  yaw = 0;
  u = 0;
  v = 0;
  r = 0;

  /** Road-wheel steering angle, radians; positive steers right. */
  steerAngle = 0;
  /** -1 reverse, 1..8 forward. */
  gear = 1;
  rpm: number;
  throttle = 0;
  brake = 0;
  limiter = false;
  /** Rear-wing flap open (DRS): less drag and less rear downforce. Set by race control; closes on braking. */
  drsOpen = false;
  /** Fuel on board, kg. Burned with throttle and revs, so the car gets lighter and quicker through a race. */
  fuel = 30;
  /** Tyre surface temperature per wheel, deg C. */
  readonly tyreTemp = [100, 100, 100, 100];
  /** Water on the track under the car, 0 (dry) to 1 (standing water); set each step from the weather. */
  wetness = 0;
  /** Rubber fitted: softer grips more and wears faster. */
  compound: TyreCompound = COMPOUNDS.medium;
  /** Tyre wear per wheel, 0 (new) to 1 (worn through). */
  readonly tyreWear = [0, 0, 0, 0];
  /**
   * Air the car is driving through, set each frame from the cars around it: below 1 in a slipstream (less drag)
   * or in dirty air behind another car (less downforce).
   */
  airDrag = 1;
  airDownforce = 1;
  /** Front wing damage, 0 (intact) to 1 (wing gone): costs front downforce and adds drag. */
  wingDamage = 0;
  /** Ground under the car, set each step from the track: height (m), slope along the car (rad, nose up
   * positive), slope across it (rad, right side up positive) and the road's vertical curvature (1/m, positive in a
   * dip, negative over a crest). */
  y = 0;
  pitch = 0;
  roll = 0;
  verticalCurvature = 0;
  /** Battery energy, J. */
  ersCharge: number;
  /** Power through the hybrid motor this step, W: positive deploying, negative harvesting. */
  ersFlow = 0;

  /** 0..1 indicators for audio, HUD and effects. */
  wheelSpin = 0;
  lockup = 0;
  slide = 0;
  /** Longitudinal and lateral acceleration in g, for the HUD and body motion. */
  gLong = 0;
  gLat = 0;
  /** Accumulated rotation of each wheel, radians. */
  readonly wheelRotation = [0, 0, 0, 0];
  readonly wheelSurface: SurfaceKind[] = ['track', 'track', 'track', 'track'];
  /** Body-frame [forward, right] offsets of each wheel from the centre of gravity. */
  readonly wheelOffsets: readonly (readonly [number, number])[];

  private alphaF = 0;
  private alphaR = 0;
  private ax = 0;
  private ay = 0;
  private shiftTimer = 0;
  private reverseTimer = 0;
  private readonly peakAlpha: number;

  constructor(spec: CarSpec, assists: Assists) {
    this.spec = spec;
    this.assists = assists;
    this.rpm = spec.idleRpm;
    this.ersCharge = spec.ersCapacity;
    this.peakAlpha = peakSlip(spec.tyre);
    const a = spec.cgToFront;
    const b = spec.wheelbase - a;
    const h = spec.trackWidth / 2;
    this.wheelOffsets = [
      [a, -h],
      [a, h],
      [-b, -h],
      [-b, h],
    ];
  }

  get speed(): number {
    return Math.hypot(this.u, this.v);
  }

  get speedKmh(): number {
    return Math.abs(this.u) * 3.6;
  }

  /** Total mass: car and driver plus fuel. */
  get mass(): number {
    return this.spec.mass + this.fuel;
  }

  /** Fits a set of tyres at a temperature (e.g. off the blankets) and wear, optionally of another compound. */
  setTyres(temp: number, wear = 0, compound: TyreCompound = this.compound): void {
    this.compound = compound;
    this.tyreTemp.fill(temp);
    this.tyreWear.fill(wear);
  }

  /** Grip multiplier of one tyre from its temperature and wear. */
  tyreGrip(wheel: number): number {
    const condition = tyreCondition(this.tyreTemp[wheel], this.tyreWear[wheel], this.compound.optimalTemp, this.spec.tyreTempWindow);
    return condition * compoundGrip(this.compound, this.wetness);
  }

  reset(x: number, z: number, yaw: number): void {
    this.x = x;
    this.z = z;
    this.yaw = yaw;
    this.u = this.v = this.r = 0;
    this.alphaF = this.alphaR = 0;
    this.ax = this.ay = 0;
    this.steerAngle = 0;
    this.gear = 1;
    this.rpm = this.spec.idleRpm;
    this.wheelSpin = this.lockup = this.slide = 0;
    this.shiftTimer = this.reverseTimer = 0;
  }

  /** Ground height at a body-frame offset from the centre, assuming the ground under the car is a plane. */
  groundY(forward: number, right: number): number {
    return this.y + forward * Math.tan(this.pitch) + right * Math.tan(this.roll);
  }

  /** World position of a wheel. */
  wheelPosition(wheel: number): [number, number] {
    const [f, rt] = this.wheelOffsets[wheel];
    const c = Math.cos(this.yaw);
    const s = Math.sin(this.yaw);
    return [this.x + c * f - s * rt, this.z + s * f + c * rt];
  }

  /**
   * Steering lock the front tyres can actually use at this speed: the geometric angle for the tightest line the
   * car's grip allows, plus the difference between front and rear slip angles when the front tyres are at their
   * peak. Beyond that, more lock only scrubs speed.
   */
  maxSteerAt(speed: number): number {
    const s = this.spec;
    const v = Math.max(speed, 1);
    const downforce = (0.5 * AIR_DENSITY * s.clA * v * v) / this.mass;
    const lateralGrip = s.tyreMu * s.gripFront * 0.9 * (G + downforce);
    return Math.min(s.maxSteer, (s.wheelbase * lateralGrip) / (v * v) + this.peakAlpha * 0.5);
  }

  /** Engine speed the wheels would drive in a given gear at the current road speed. */
  rpmInGear(gear: number): number {
    const s = this.spec;
    const ratio = gear < 0 ? s.reverseRatio : s.gearRatios[gear - 1];
    return (Math.abs(this.u) / s.wheelRadius) * ratio * s.finalDrive * RPM_PER_RAD_S;
  }

  step(dt: number, input: CarControls, probe: SurfaceProbe): void {
    const s = this.spec;
    const m = this.mass;
    const a = s.cgToFront;
    const b = s.wheelbase - a;
    const L = s.wheelbase;

    // Surfaces under each wheel.
    const surfaces: WheelSurface[] = [];
    for (let w = 0; w < 4; w++) {
      const [wx, wz] = this.wheelPosition(w);
      const surf = probe(wx, wz, w);
      surfaces.push(surf);
      this.wheelSurface[w] = surf.kind;
    }

    this.updateGearbox(dt, input);

    // In reverse the pedals swap, so "brake" backs the car up and "throttle" stops it.
    const reversing = this.gear < 0;
    const throttle = clamp(reversing ? input.brake : input.throttle, 0, 1);
    const brakeIn = clamp(reversing ? input.throttle : input.brake, 0, 1);
    this.throttle = throttle;
    this.brake = brakeIn;
    // Touching the brakes closes the DRS flap, as on the real system.
    if (brakeIn > 0.05) this.drsOpen = false;

    // Steering rack.
    const lock = this.assists.steering ? this.maxSteerAt(Math.abs(this.u)) : s.maxSteer;
    const rackSpeed = s.steerRate / (1 + Math.abs(this.u) / 30);
    this.steerAngle = approach(this.steerAngle, clamp(input.steer, -1, 1) * lock, rackSpeed * dt);
    const delta = this.steerAngle;
    const cosD = Math.cos(delta);
    const sinD = Math.sin(delta);

    // Vertical loads: static weight, downforce, then longitudinal and lateral weight transfer.
    // Dirty air costs downforce at both ends; a damaged front wing costs the front most; an open DRS flap sheds
    // rear-wing downforce.
    const u2 = this.u * this.u;
    const baseDownforce = 0.5 * AIR_DENSITY * s.clA * u2 * this.airDownforce;
    const dfFront = baseDownforce * s.aeroBalanceFront * (1 - 0.45 * this.wingDamage);
    const dfRear = baseDownforce * (1 - s.aeroBalanceFront) * (this.drsOpen ? 0.72 : 1);
    const downforce = dfFront + dfRear;
    // Weight presses on the tyres less on a slope, less still over a crest (the car goes light) and more in a
    // compression, by the speed squared times the road's vertical curvature.
    const gEff = Math.max(0, G * Math.cos(this.pitch) * Math.cos(this.roll) + u2 * this.verticalCurvature);
    const transferLong = (m * this.ax * s.cgHeight) / L;
    const fzFront = Math.max(0, (m * gEff * b) / L + dfFront - transferLong);
    const fzRear = Math.max(0, (m * gEff * a) / L + dfRear + transferLong);
    // Cornering to the right (ay > 0) loads the left-hand wheels.
    const transferLat = (m * this.ay * s.cgHeight) / s.trackWidth / 2;
    const loads = [
      Math.max(0, fzFront / 2 + transferLat),
      Math.max(0, fzFront / 2 - transferLat),
      Math.max(0, fzRear / 2 + transferLat),
      Math.max(0, fzRear / 2 - transferLat),
    ];
    const grip = loads.map(
      (fz, w) =>
        loadSensitiveMu(s.tyreMu * (w < 2 ? s.gripFront : s.gripRear) * surfaces[w].grip * this.tyreGrip(w), fz, s.tyreNominalLoad) * fz,
    );
    const gripFront = Math.max(grip[0] + grip[1], 1);
    const gripRear = Math.max(grip[2] + grip[3], 1);

    // Slip angles, lagged by the tyre's relaxation length.
    const vFront = this.v + a * this.r;
    const wheelLong = this.u * cosD + vFront * sinD;
    const wheelLat = -this.u * sinD + vFront * cosD;
    const alphaFss = Math.atan2(wheelLat, Math.max(Math.abs(wheelLong), 0.5));
    const alphaRss = Math.atan2(this.v - b * this.r, Math.max(Math.abs(this.u), 0.5));
    const relax = Math.min(1, ((Math.abs(this.u) + 1) * dt) / s.relaxationLength);
    this.alphaF += (alphaFss - this.alphaF) * relax;
    this.alphaR += (alphaRss - this.alphaR) * relax;

    // Engine and gearbox.
    const ratio = (this.gear < 0 ? s.reverseRatio : s.gearRatios[this.gear - 1]) * s.finalDrive;
    const wheelRpm = this.rpmInGear(this.gear);
    let baseRpm = Math.max(wheelRpm, s.idleRpm);
    if (Math.abs(this.gear) === 1 && wheelRpm < s.launchRpm) {
      // Clutch slipping off the line: the engine sits at launch revs while the car catches up.
      baseRpm = Math.max(wheelRpm, s.idleRpm + (s.launchRpm - s.idleRpm) * throttle);
    }
    const targetRpm = Math.min(baseRpm * (1 + this.wheelSpin), s.limiterRpm + 150);
    this.rpm = damp(this.rpm, targetRpm, 0.04, dt);
    this.limiter = this.rpm >= s.limiterRpm;

    const fuelled = this.fuel > 0;
    let torque = this.limiter || !fuelled ? 0 : interpolateTable(s.torqueCurve, this.rpm) * throttle;
    torque -= (1 - throttle) * s.engineBrakeTorque * (this.rpm / s.limiterRpm) * Math.min(1, Math.abs(this.u) / 3);
    if (this.shiftTimer > 0) {
      this.shiftTimer -= dt;
      torque *= 0.4;
    }
    let drive = (torque * ratio * s.drivetrainEfficiency) / s.wheelRadius;

    // Hybrid system. At full throttle the motor deploys (force from a fixed power falls with speed, capped low down by
    // the motor's torque), tapering as the battery runs low so energy lasts down a straight instead of cutting out
    // all at once; the exhaust turbine (MGU-H) keeps recovering a little meanwhile. Braking and lifting recharge it.
    const speedAbs = Math.abs(this.u);
    const soc = this.ersCharge / s.ersCapacity;
    let ersIn = 0;
    let ersOut = 0;
    if (this.gear > 0 && throttle > 0.85 && speedAbs > 8 && fuelled) {
      ersOut = Math.min(s.ersPower * throttle * clamp(soc / ERS_TAPER, 0, 1), this.ersCharge / dt);
      drive += ersOut / Math.max(speedAbs, 25);
      ersIn = MGUH_POWER * (this.rpm / s.limiterRpm);
    } else if (speedAbs > 5 && (brakeIn > 0.05 || throttle < 0.1)) {
      ersIn = s.ersHarvest * Math.max(brakeIn, 0.5);
    }
    ersIn = Math.min(ersIn, (s.ersCapacity - this.ersCharge) / dt + ersOut);
    this.ersCharge = clamp(this.ersCharge + (ersIn - ersOut) * dt, 0, s.ersCapacity);
    this.ersFlow = ersOut - ersIn;
    if (this.gear < 0) drive = -drive;

    // Traction: drive force beyond what the rear tyres can carry becomes wheelspin.
    let spinTarget = 0;
    // Traction control keeps drive within what the rear tyres can carry alongside the cornering they're already doing.
    const rearLatUse = Math.min(0.95, Math.abs(pacejka(this.alphaR, s.tyre)));
    const tcLimit = gripRear * Math.sqrt(1 - rearLatUse * rearLatUse) * 0.92;
    if (this.assists.tractionControl && Math.abs(drive) > tcLimit) {
      drive = Math.sign(drive) * tcLimit;
      spinTarget = 0.02;
    } else if (Math.abs(drive) > gripRear) {
      spinTarget = clamp((Math.abs(drive) / gripRear - 1) * 0.6, 0, 0.6);
      drive = Math.sign(drive) * gripRear * (1 - 0.25 * spinTarget);
    }
    this.wheelSpin = damp(this.wheelSpin, spinTarget, 0.12, dt);

    // Brakes oppose the direction of travel; beyond the tyres' grip the wheels lock.
    const dirU = this.u > 0.05 ? 1 : this.u < -0.05 ? -1 : 0;
    const brakeForce = brakeIn * s.maxBrakeForce;
    let brakeFront = brakeForce * s.brakeBiasFront;
    let brakeRear = brakeForce - brakeFront;
    let lockFront = 0;
    let lockRear = 0;
    if (brakeFront > gripFront) {
      lockFront = this.assists.abs ? 0 : 1;
      brakeFront = gripFront * (this.assists.abs ? 0.97 : 0.85);
    }
    if (brakeRear > gripRear) {
      lockRear = this.assists.abs ? 0 : 1;
      brakeRear = gripRear * (this.assists.abs ? 0.97 : 0.85);
    }
    this.lockup = damp(this.lockup, Math.max(lockFront, lockRear) * (dirU !== 0 ? 1 : 0), 0.05, dt);

    const fxFront = -brakeFront * dirU;
    const fxRear = clamp(drive - brakeRear * dirU, -gripRear, gripRear);

    // Friction circle: longitudinal force uses up grip that would otherwise go to cornering.
    let latFront = Math.sqrt(Math.max(0, 1 - (fxFront / gripFront) ** 2));
    let latRear = Math.sqrt(Math.max(0, 1 - (fxRear / gripRear) ** 2));
    if (lockFront) latFront = Math.min(latFront, 0.3);
    if (lockRear) latRear = Math.min(latRear, 0.3);
    latRear *= Math.max(0.15, 1 - this.wheelSpin * 1.2);

    const fyFront = -gripFront * latFront * pacejka(this.alphaF, s.tyre);
    const fyRear = -gripRear * latRear * pacejka(this.alphaR, s.tyre);

    // Sum forces in the body frame.
    let fx = fxFront * cosD - fyFront * sinD + fxRear;
    let fy = fxFront * sinD + fyFront * cosD + fyRear;
    const cdA = s.cdA * this.airDrag * (this.drsOpen ? 0.86 : 1) * (1 + 0.08 * this.wingDamage);
    fx -= 0.5 * AIR_DENSITY * cdA * this.u * Math.abs(this.u);
    // Gravity along a slope: climbing slows the car, descending speeds it up; camber pulls it toward the low side.
    fx -= m * G * Math.sin(this.pitch);
    fy -= m * G * Math.sin(this.roll);
    let rolling = s.rollingResistance * (m * gEff + downforce);
    for (let w = 0; w < 4; w++) rolling += surfaces[w].drag * loads[w];
    fx -= rolling * clamp(this.u / 0.5, -1, 1);
    const yawMoment = a * (fxFront * sinD + fyFront * cosD) - b * fyRear - 300 * this.r;

    // Weight transfer follows the tyre forces with a little lag, as the suspension takes a moment to settle.
    this.ax = damp(this.ax, fx / m, 0.03, dt);
    this.ay = damp(this.ay, fy / m, 0.03, dt);
    this.gLong = this.ax / G;
    this.gLat = this.ay / G;

    // Integrate.
    const prevU = this.u;
    this.u += (fx / m + this.v * this.r) * dt;
    this.v += (fy / m - this.u * this.r) * dt;
    this.r += (yawMoment / s.yawInertia) * dt;
    // Brakes and rolling resistance stop the car; they never push it backwards.
    if (prevU !== 0 && Math.sign(this.u) !== Math.sign(prevU) && throttle < 0.05) this.u = 0;
    // At a crawl, applied brakes clamp the wheels and hold the car still.
    if (brakeIn > 0.05 && throttle < 0.05 && Math.abs(this.u) < 0.5) {
      this.u *= Math.exp(-dt * 12);
      if (Math.abs(this.u) < 0.01) this.u = 0;
    }
    if (Math.abs(this.u) < 0.3 && throttle < 0.05) {
      const settle = Math.exp(-dt * 8);
      this.v *= settle;
      this.r *= settle;
    }

    this.yaw += this.r * dt;
    const c = Math.cos(this.yaw);
    const sn = Math.sin(this.yaw);
    this.x += (this.u * c - this.v * sn) * dt;
    this.z += (this.u * sn + this.v * c) * dt;

    // Wheel rotation for rendering.
    const frontSpin = lockFront ? 0 : wheelLong / s.wheelRadius;
    const rearSpin = lockRear ? 0 : (this.u / s.wheelRadius) * (1 + this.wheelSpin * 3);
    this.wheelRotation[0] += frontSpin * dt;
    this.wheelRotation[1] += frontSpin * dt;
    this.wheelRotation[2] += rearSpin * dt;
    this.wheelRotation[3] += rearSpin * dt;

    const slip = Math.max(Math.abs(this.alphaF), Math.abs(this.alphaR)) / this.peakAlpha;
    this.slide = Math.abs(this.u) > 3 ? clamp(slip - 0.7, 0, 1) : 0;

    if (fuelled) this.fuel = Math.max(0, this.fuel - s.fuelBurn * throttle * (this.rpm / s.limiterRpm) * dt);

    // Tyre temperature and wear. Sliding is what heats a tyre: force times slip speed at the contact patch, shared
    // across an axle by load. Flexing under load adds a little; airflow cools it toward ambient.
    const speed = Math.abs(this.u);
    const latSlipFront = Math.abs(wheelLat);
    const latSlipRear = Math.abs(this.v - b * this.r);
    // Longitudinal slip under braking or drive is a few percent of road speed; locking or real wheelspin is far more.
    const longSlipFront = lockFront ? speed : 0.02 * speed * (brakeFront / gripFront);
    const spinning = Math.max(0, this.wheelSpin - 0.03);
    const longSlipRear = lockRear ? speed : speed * (spinning + (0.012 * Math.abs(fxRear)) / gripRear);
    const axleLoadFront = Math.max(loads[0] + loads[1], 1);
    const axleLoadRear = Math.max(loads[2] + loads[3], 1);
    // Spray and standing water cool tyres hard: slicks in the rain fall out of their window.
    const cooling = TYRE_COOLING * (1 + speed / 40) * (1 + 1.5 * this.wetness);
    for (let w = 0; w < 4; w++) {
      const front = w < 2;
      const share = loads[w] / (front ? axleLoadFront : axleLoadRear);
      const power =
        share *
        (front
          ? Math.abs(fyFront) * latSlipFront + Math.abs(fxFront) * longSlipFront
          : Math.abs(fyRear) * latSlipRear + Math.abs(fxRear) * longSlipRear);
      // The wider rear tyres carry more rubber, so the same energy warms them less.
      const mass = front ? 1 : REAR_TYRE_MASS;
      const heat = (power / TYRE_HEAT_CAPACITY + TYRE_FLEX_HEAT * loads[w] * speed) / mass;
      // Above its window a tyre sheds heat faster (conduction into the track and carcass), which keeps a driver who
      // overworks the tyres on the edge rather than in a runaway.
      const over = Math.max(0, this.tyreTemp[w] - this.compound.optimalTemp) / 25;
      this.tyreTemp[w] += (heat - cooling * (1 + over) * (this.tyreTemp[w] - AMBIENT)) * dt;
      // Overheated rubber wears faster.
      const hot = this.tyreTemp[w] > this.compound.optimalTemp + 15 ? 1.8 : 1;
      this.tyreWear[w] = Math.min(1, this.tyreWear[w] + power * TYRE_WEAR_PER_JOULE * this.compound.wear * hot * dt);
    }
  }

  private updateGearbox(dt: number, input: CarControls): void {
    const s = this.spec;
    const top = s.gearRatios.length;
    const stopped = Math.abs(this.u) < 0.5;

    if (input.shiftUp) {
      if (this.gear < 0) this.gear = 1;
      else if (this.gear < top) this.shiftTo(this.gear + 1);
    }
    if (input.shiftDown) {
      if (this.gear === 1 && stopped) this.gear = -1;
      else if (this.gear > 1 && this.rpmInGear(this.gear - 1) < s.limiterRpm) this.shiftTo(this.gear - 1);
    }

    if (!this.assists.autoGears) return;

    if (this.gear > 0) {
      if (this.rpm > s.upshiftRpm && this.gear < top && this.shiftTimer <= 0 && this.wheelSpin < 0.2) {
        this.shiftTo(this.gear + 1);
      } else if (this.gear > 1 && this.rpm < s.downshiftRpm && this.rpmInGear(this.gear - 1) < s.upshiftRpm - 900) {
        this.shiftTo(this.gear - 1);
      }
      // Hold the brake at a standstill to engage reverse.
      if (stopped && input.brake > 0.5 && input.throttle < 0.1) {
        this.reverseTimer += dt;
        if (this.reverseTimer > 0.6) {
          this.gear = -1;
          this.reverseTimer = 0;
        }
      } else {
        this.reverseTimer = 0;
      }
    } else if (stopped && input.throttle > 0.1) {
      this.gear = 1;
    }
  }

  private shiftTo(gear: number): void {
    this.gear = gear;
    this.shiftTimer = this.spec.shiftTime;
  }
}
