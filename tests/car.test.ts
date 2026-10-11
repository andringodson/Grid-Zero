import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Car, type Assists, type CarControls, type SurfaceProbe } from '../src/physics/Car.ts';
import { GZ26 } from '../src/physics/carSpec.ts';
import { pacejka, peakSlip, SLICK } from '../src/physics/tyre.ts';

const DT = 1 / 240;
const ALL_ASSISTS: Assists = { steering: true, autoGears: true, tractionControl: true, abs: true };
const asphalt: SurfaceProbe = () => ({ kind: 'track', grip: 1, drag: 0 });
const grass: SurfaceProbe = () => ({ kind: 'grass', grip: 0.5, drag: 0.3 });

function controls(c: Partial<CarControls>): CarControls {
  return { throttle: 0, brake: 0, steer: 0, shiftUp: false, shiftDown: false, ...c };
}

function run(car: Car, seconds: number, input: CarControls, probe = asphalt, until?: (car: Car) => boolean): number {
  let t = 0;
  while (t < seconds) {
    car.step(DT, input, probe);
    t += DT;
    if (until?.(car)) break;
  }
  return t;
}

function newCar(assists: Partial<Assists> = {}): Car {
  const car = new Car(GZ26, { ...ALL_ASSISTS, ...assists });
  car.reset(0, 0, 0);
  return car;
}

test('slick tyre peaks between 5 and 8 degrees and keeps most of its grip when sliding', () => {
  const peak = peakSlip(SLICK);
  assert.ok(peak > (5 * Math.PI) / 180 && peak < (8 * Math.PI) / 180, `peak at ${((peak * 180) / Math.PI).toFixed(1)} deg`);
  const sliding = pacejka(0.4, SLICK);
  assert.ok(sliding > 0.7 && sliding < 0.95, `sliding grip ${sliding.toFixed(2)}`);
  assert.equal(pacejka(-0.1, SLICK), -pacejka(0.1, SLICK));
});

test('0-100 km/h takes 2.4 to 3.4 seconds with traction control', () => {
  const car = newCar();
  const t = run(car, 10, controls({ throttle: 1 }), asphalt, (c) => c.speedKmh >= 100);
  assert.ok(t > 2.4 && t < 3.4, `0-100 in ${t.toFixed(2)} s`);
});

test('0-200 km/h takes under 6 seconds', () => {
  const car = newCar();
  const t = run(car, 15, controls({ throttle: 1 }), asphalt, (c) => c.speedKmh >= 200);
  assert.ok(t > 4 && t < 6, `0-200 in ${t.toFixed(2)} s`);
});

test('top speed is between 320 and 360 km/h and the gearbox reaches 8th', () => {
  const car = newCar();
  run(car, 60, controls({ throttle: 1 }));
  assert.ok(car.speedKmh > 320 && car.speedKmh < 360, `top speed ${car.speedKmh.toFixed(1)} km/h`);
  assert.equal(car.gear, 8);
});

test('braking from 300 to 100 km/h takes 80 to 150 m, with peak deceleration above 4 g', () => {
  const car = newCar();
  run(car, 30, controls({ throttle: 1 }), asphalt, (c) => c.speedKmh >= 300);
  const startX = car.x;
  let peakG = 0;
  run(car, 10, controls({ brake: 1 }), asphalt, (c) => {
    peakG = Math.max(peakG, -c.gLong);
    return c.speedKmh <= 100;
  });
  const distance = car.x - startX;
  assert.ok(distance > 80 && distance < 150, `braking distance ${distance.toFixed(1)} m`);
  assert.ok(peakG > 4, `peak deceleration ${peakG.toFixed(2)} g`);
});

test('the car comes to rest under braking and does not roll backwards', () => {
  const car = newCar();
  run(car, 5, controls({ throttle: 1 }));
  run(car, 10, controls({ brake: 1 }), asphalt, (c) => c.u === 0);
  // Shorter than the hold that selects reverse.
  run(car, 0.4, controls({ brake: 1 }));
  assert.equal(car.u, 0);
  assert.equal(car.gear, 1);
});

test('a car at rest stays at rest', () => {
  const car = newCar();
  run(car, 5, controls({}));
  assert.equal(car.x, 0);
  assert.equal(car.z, 0);
});

test('fast cornering pulls more than 3.5 g at 250 km/h without spinning', () => {
  const car = newCar();
  run(car, 30, controls({ throttle: 1 }), asphalt, (c) => c.speedKmh >= 250);
  let peakLat = 0;
  // Hold speed roughly constant with part throttle while turning in on full assisted lock.
  run(car, 3, controls({ throttle: 0.6, steer: 1 }), asphalt, (c) => {
    peakLat = Math.max(peakLat, c.gLat);
    return false;
  });
  assert.ok(peakLat > 3.5, `peak lateral ${peakLat.toFixed(2)} g`);
  const sideslip = Math.abs(Math.atan2(car.v, car.u));
  assert.ok(sideslip < 0.15, `sideslip ${((sideslip * 180) / Math.PI).toFixed(1)} deg`);
});

test('steering right turns the car right (heading increases)', () => {
  const car = newCar();
  run(car, 3, controls({ throttle: 0.5 }));
  const yaw0 = car.yaw;
  run(car, 1, controls({ throttle: 0.3, steer: 1 }));
  assert.ok(car.yaw > yaw0 + 0.2, `yaw went from ${yaw0.toFixed(2)} to ${car.yaw.toFixed(2)}`);
  assert.ok(car.z > 0, 'car should have moved toward +z, its right');
});

test('without traction control, full throttle in first gear spins the rear wheels', () => {
  const car = newCar({ tractionControl: false });
  let peakSpin = 0;
  run(car, 1.5, controls({ throttle: 1 }), asphalt, (c) => {
    peakSpin = Math.max(peakSpin, c.wheelSpin);
    return false;
  });
  assert.ok(peakSpin > 0.1, `peak wheelspin ${peakSpin.toFixed(2)}`);
});

test('without ABS, a stamp on the brakes at low speed locks the wheels', () => {
  const car = newCar({ abs: false });
  run(car, 3, controls({ throttle: 1 }));
  let peakLock = 0;
  run(car, 0.5, controls({ brake: 1 }), asphalt, (c) => {
    peakLock = Math.max(peakLock, c.lockup);
    return false;
  });
  assert.ok(peakLock > 0.5, `peak lockup ${peakLock.toFixed(2)}`);
});

test('grass slows the car much faster than asphalt', () => {
  const onTrack = newCar();
  const onGrass = newCar();
  run(onTrack, 4, controls({ throttle: 1 }));
  run(onGrass, 4, controls({ throttle: 1 }));
  run(onTrack, 2, controls({}));
  run(onGrass, 2, controls({}), grass);
  assert.ok(onGrass.u < onTrack.u - 5, `grass ${onGrass.u.toFixed(1)} m/s vs track ${onTrack.u.toFixed(1)} m/s`);
});

test('holding the brake at a standstill selects reverse, and the brake pedal then backs up', () => {
  const car = newCar();
  run(car, 1, controls({ brake: 1 }));
  assert.equal(car.gear, -1);
  run(car, 2, controls({ brake: 1 }));
  assert.ok(car.x < -1, `reversed to x=${car.x.toFixed(2)}`);
  run(car, 2, controls({ throttle: 1 }));
  assert.equal(car.gear >= 1, true);
});
