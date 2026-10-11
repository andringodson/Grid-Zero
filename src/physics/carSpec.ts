import { SLICK, type PacejkaCoefficients } from './tyre.ts';

export interface CarSpec {
  /** Kilograms, including the driver but not fuel. */
  mass: number;
  /** Fuel flow at full throttle and maximum revs, kg per second. */
  fuelBurn: number;
  wheelbase: number;
  /** Distance from the centre of gravity to the front axle. */
  cgToFront: number;
  cgHeight: number;
  trackWidth: number;
  /** Yaw moment of inertia, kg m^2. */
  yawInertia: number;
  wheelRadius: number;

  /** Downforce coefficient times frontal area, m^2. */
  clA: number;
  /** Share of downforce acting on the front axle. */
  aeroBalanceFront: number;
  /** Drag coefficient times frontal area, m^2. */
  cdA: number;
  rollingResistance: number;

  /** Engine torque in Nm at full throttle, as [rpm, Nm] pairs. */
  torqueCurve: readonly (readonly [number, number])[];
  idleRpm: number;
  /** Engine speed held while the clutch slips during a standing start. */
  launchRpm: number;
  limiterRpm: number;
  upshiftRpm: number;
  downshiftRpm: number;
  engineBrakeTorque: number;
  gearRatios: readonly number[];
  reverseRatio: number;
  finalDrive: number;
  drivetrainEfficiency: number;
  /** Seconds of reduced torque while a gear change completes. */
  shiftTime: number;

  maxBrakeForce: number;
  brakeBiasFront: number;

  /** Maximum road-wheel steering angle, radians. */
  maxSteer: number;
  /** Steering rack speed at the road wheels at low speed, radians per second. It slows as speed rises, as a driver's hands do. */
  steerRate: number;

  tyre: PacejkaCoefficients;
  tyreMu: number;
  /** Grip scale per axle. Wider rear tyres give the rear more grip, so the car understeers at the limit instead of spinning. */
  gripFront: number;
  gripRear: number;
  tyreNominalLoad: number;
  /** Distance a tyre rolls before its slip angle catches up with a change in direction. */
  relaxationLength: number;

  /** Tyre surface temperature (deg C) with peak grip, and how far either side grip has fallen by a fifth. */
  tyreOptimalTemp: number;
  tyreTempWindow: number;
}

/**
 * GZ-26: a fictional car built to current top-level open-wheel figures. 770 kg with driver plus fuel,
 * around 750 kW from a turbo-hybrid V6, and enough downforce to pull more than 5 g in fast corners.
 */
export const GZ26: CarSpec = {
  mass: 770,
  // 100 kg an hour at full power, the flow limit of a modern hybrid power unit.
  fuelBurn: 100 / 3600,
  wheelbase: 3.6,
  cgToFront: 1.98,
  cgHeight: 0.28,
  trackWidth: 1.6,
  yawInertia: 1150,
  wheelRadius: 0.36,

  clA: 4.2,
  aeroBalanceFront: 0.42,
  cdA: 1.3,
  rollingResistance: 0.012,

  torqueCurve: [
    [4000, 360],
    [6000, 450],
    [8000, 545],
    [10000, 620],
    [11000, 635],
    [12000, 600],
    [12500, 570],
    [13000, 520],
  ],
  idleRpm: 4000,
  launchRpm: 8500,
  limiterRpm: 12500,
  upshiftRpm: 12100,
  downshiftRpm: 7600,
  engineBrakeTorque: 110,
  gearRatios: [5.4, 4.1, 3.3, 2.75, 2.35, 2.03, 1.77, 1.55],
  reverseRatio: 5.0,
  finalDrive: 3.0,
  drivetrainEfficiency: 0.92,
  shiftTime: 0.05,

  maxBrakeForce: 52000,
  brakeBiasFront: 0.56,

  maxSteer: 0.36,
  steerRate: 1.6,

  tyre: SLICK,
  tyreMu: 1.7,
  gripFront: 0.96,
  gripRear: 1.06,
  tyreNominalLoad: 3000,
  relaxationLength: 0.5,

  tyreOptimalTemp: 100,
  tyreTempWindow: 40,
};
