import type { Car } from '../../physics/Car.ts';

/** Anything that carries a car, such as the field's entries. */
export interface HasCar {
  car: Car;
}

/** Tyre tread widths in metres, front and rear, matching the car model. */
export const TYRE_WIDTH = [0.305, 0.305, 0.405, 0.405];

/**
 * How hard a tyre is being scrubbed across the surface, 0..1: locked under braking, spinning under power (rear
 * wheels only, they are the driven ones) or sliding sideways. The car reports one lockup figure for both axles;
 * the fronts lock first under normal brake balance, so they take the full value.
 */
export function tyreScrub(car: Car, wheel: number): number {
  const front = wheel < 2;
  const lock = car.lockup * (front ? 1 : 0.6);
  const spin = front ? 0 : Math.min(1, car.wheelSpin * 2.2);
  const slide = car.slide * (front ? 0.85 : 1);
  return Math.max(lock, spin, slide);
}

/** World x of a wheel's contact patch, without allocating like `Car.wheelPosition`. */
export function wheelX(car: Car, wheel: number): number {
  const [f, r] = car.wheelOffsets[wheel];
  return car.x + Math.cos(car.yaw) * f - Math.sin(car.yaw) * r;
}

/** World z of a wheel's contact patch. */
export function wheelZ(car: Car, wheel: number): number {
  const [f, r] = car.wheelOffsets[wheel];
  return car.z + Math.sin(car.yaw) * f + Math.cos(car.yaw) * r;
}
