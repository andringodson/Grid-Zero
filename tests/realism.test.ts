import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Car, type CarControls, type SurfaceProbe } from '../src/physics/Car.ts';
import { GZ26 } from '../src/physics/carSpec.ts';
import { COMPOUNDS, tyreCondition } from '../src/physics/tyre.ts';

const DT = 1 / 240;
const asphalt: SurfaceProbe = () => ({ kind: 'track', grip: 1, drag: 0 });
const assists = { steering: true, autoGears: true, tractionControl: true, abs: true };
const controls = (c: Partial<CarControls>): CarControls => ({ throttle: 0, brake: 0, steer: 0, shiftUp: false, shiftDown: false, ...c });

function newCar(): Car {
  const car = new Car(GZ26, assists);
  car.reset(0, 0, 0);
  return car;
}

function run(car: Car, seconds: number, input: CarControls, each?: (car: Car) => void): void {
  for (let t = 0; t < seconds; t += DT) {
    each?.(car);
    car.step(DT, input, asphalt);
  }
}

function topSpeed(setup: (car: Car) => void): number {
  const car = newCar();
  run(car, 40, controls({ throttle: 1 }), setup);
  return car.speedKmh;
}

test('tyres grip best in their window and lose grip cold, overheated or worn', () => {
  const at = (t: number, w = 0) => tyreCondition(t, w, COMPOUNDS.medium.optimalTemp, GZ26.tyreTempWindow);
  assert.equal(at(100), 1);
  assert.ok(at(60) < 0.85, `cold ${at(60)}`);
  assert.ok(at(140) < 0.85, `hot ${at(140)}`);
  assert.ok(at(95) > 0.99);
  assert.ok(Math.abs(at(100, 1) - 0.88) < 1e-9);
});

test('soft tyres grip more but wear faster than hards', () => {
  const stint = (compound: (typeof COMPOUNDS)[keyof typeof COMPOUNDS]) => {
    const car = newCar();
    car.setTyres(compound.optimalTemp, 0, compound);
    const grip = car.tyreGrip(0);
    run(car, 8, controls({ throttle: 1 }));
    run(car, 6, controls({ throttle: 0.6, steer: 1 }));
    return { grip, wear: car.tyreWear[0] };
  };
  const soft = stint(COMPOUNDS.soft);
  const hard = stint(COMPOUNDS.hard);
  assert.ok(soft.grip > hard.grip + 0.03, `grip soft ${soft.grip} hard ${hard.grip}`);
  assert.ok(soft.wear > hard.wear * 2.5, `wear soft ${soft.wear} hard ${hard.wear}`);
});

test('cold tyres brake later: the same stop takes longer than on warm tyres', () => {
  const stop = (temp: number) => {
    const car = newCar();
    run(car, 10, controls({ throttle: 1 }), (c) => c.setTyres(temp));
    const x0 = car.x;
    run(car, 10, controls({ brake: 1 }), (c) => c.setTyres(temp));
    return car.x - x0;
  };
  const warm = stop(100);
  const cold = stop(55);
  assert.ok(cold > warm * 1.1, `cold ${cold.toFixed(1)} m vs warm ${warm.toFixed(1)} m`);
});

test('tyres warm up when worked, the loaded outside ones most', () => {
  const car = newCar();
  car.setTyres(60);
  run(car, 8, controls({ throttle: 1 }));
  // A long right-hander: the left-hand tyres are on the outside and carry the load.
  run(car, 4, controls({ throttle: 0.6, steer: 1 }));
  const [fl, fr, rl, rr] = car.tyreTemp;
  const temps = car.tyreTemp.map((t) => t.toFixed(0)).join('/');
  assert.ok(car.tyreTemp.every((t) => t > 62), `temps ${temps}`);
  assert.ok(fl > fr + 8 && rl > rr + 8, `outside tyres should run hotter: ${temps}`);
  assert.ok(car.tyreWear.every((w) => w > 0));
});

test('fuel burns with throttle, and a lighter car accelerates harder', () => {
  const car = newCar();
  car.fuel = 100;
  run(car, 20, controls({ throttle: 1 }));
  assert.ok(car.fuel < 100 && car.fuel > 99, `fuel ${car.fuel.toFixed(3)}`);

  const accel = (fuel: number) => {
    const c = newCar();
    c.fuel = fuel;
    run(c, 6, controls({ throttle: 1 }));
    return c.speedKmh;
  };
  assert.ok(accel(5) > accel(100) + 2, 'full tanks should be slower');
});

test('an empty tank stops the engine pulling', () => {
  const car = newCar();
  car.fuel = 0;
  run(car, 3, controls({ throttle: 1 }));
  assert.ok(car.speedKmh < 1, `moved to ${car.speedKmh.toFixed(1)} km/h with no fuel`);
});

test('DRS and a slipstream each raise top speed', () => {
  const normal = topSpeed(() => {});
  const drs = topSpeed((c) => (c.drsOpen = true));
  const tow = topSpeed((c) => (c.airDrag = 0.75));
  assert.ok(drs > normal + 8, `DRS ${drs.toFixed(1)} vs ${normal.toFixed(1)} km/h`);
  assert.ok(tow > normal + 10, `tow ${tow.toFixed(1)} vs ${normal.toFixed(1)} km/h`);
});

test('the hybrid battery adds pace while charged and recharges under braking', () => {
  const at = (charge: number) => {
    const car = newCar();
    car.ersCharge = charge;
    run(car, 12, controls({ throttle: 1 }));
    return car;
  };
  const charged = at(GZ26.ersCapacity);
  const flat = at(0);
  assert.ok(charged.speedKmh > flat.speedKmh + 5, `charged ${charged.speedKmh.toFixed(1)} vs flat ${flat.speedKmh.toFixed(1)} km/h`);
  assert.ok(charged.ersCharge < GZ26.ersCapacity, 'deploying should drain the battery');

  const before = flat.ersCharge;
  run(flat, 3, controls({ brake: 0.8 }));
  assert.ok(flat.ersCharge > before + 1e5, `harvested ${(flat.ersCharge - before).toFixed(0)} J`);
});

test('braking closes the DRS flap', () => {
  const car = newCar();
  run(car, 5, controls({ throttle: 1 }));
  car.drsOpen = true;
  run(car, 0.1, controls({ brake: 0.5 }));
  assert.equal(car.drsOpen, false);
});

test('dirty air and wing damage cost cornering grip', () => {
  const peakLat = (setup: (c: Car) => void) => {
    const car = newCar();
    run(car, 30, controls({ throttle: 1 }), (c) => {
      setup(c);
      c.setTyres(100);
    });
    let peak = 0;
    run(car, 2, controls({ throttle: 0.6, steer: 1 }), (c) => {
      setup(c);
      c.setTyres(100);
      peak = Math.max(peak, Math.abs(c.gLat));
    });
    return peak;
  };
  const clean = peakLat(() => {});
  const dirty = peakLat((c) => (c.airDownforce = 0.75));
  const damaged = peakLat((c) => (c.wingDamage = 1));
  assert.ok(dirty < clean - 0.2, `dirty air ${dirty.toFixed(2)} g vs clean ${clean.toFixed(2)} g`);
  assert.ok(damaged < clean - 0.1, `damaged ${damaged.toFixed(2)} g vs clean ${clean.toFixed(2)} g`);
});
