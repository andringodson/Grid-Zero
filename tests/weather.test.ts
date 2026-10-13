import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Weather } from '../src/game/weather.ts';
import { Car, type CarControls, type SurfaceProbe } from '../src/physics/Car.ts';
import { GZ26 } from '../src/physics/carSpec.ts';
import { COMPOUNDS, compoundGrip } from '../src/physics/tyre.ts';

const run = (w: Weather, seconds: number) => {
  for (let t = 0; t < seconds; t += 0.1) w.update(0.1);
};

test('a dry session stays dry; a wet one starts soaked', () => {
  const dry = new Weather('dry', () => 0.5);
  run(dry, 300);
  assert.equal(dry.rain, 0);
  assert.equal(dry.wetness, 0);
  const wet = new Weather('wet', () => 0.5);
  assert.ok(wet.rain > 0.6 && wet.wetness > 0.8);
});

test('changing weather brings rain partway through, and the track wets gradually', () => {
  const w = new Weather('changing', () => 0.5);
  run(w, w.rainAt - 1);
  assert.equal(w.wetness, 0);
  run(w, 20);
  assert.ok(w.rain > 0.15, `rain ${w.rain}`);
  assert.ok(w.wetness > 0, `wetness ${w.wetness}`);
  run(w, 120);
  // A shower, not a downpour: damp enough to make slicks slide, never flooded (there are no pit stops for wets).
  assert.ok(w.wetness > 0.2 && w.wetness < 0.4, `wetness ${w.wetness}`);
});

test('crossovers: slicks best when dry, intermediates when damp, full wets in standing water', () => {
  const best = (w: number) =>
    Object.values(COMPOUNDS).reduce((a, b) => (compoundGrip(b, w) > compoundGrip(a, w) ? b : a)).id;
  assert.equal(best(0), 'soft');
  assert.equal(best(0.4), 'inter');
  assert.equal(best(1), 'wet');
});

test('slicks on a wet track brake far later than wets', () => {
  const asphalt: SurfaceProbe = () => ({ kind: 'track', grip: 1, drag: 0 });
  const c = (o: Partial<CarControls>): CarControls => ({ throttle: 0, brake: 0, steer: 0, shiftUp: false, shiftDown: false, ...o });
  const stop = (compound: (typeof COMPOUNDS)[keyof typeof COMPOUNDS]) => {
    const car = new Car(GZ26, { steering: true, autoGears: true, tractionControl: true, abs: true });
    car.reset(0, 0, 0);
    car.wetness = 1;
    const hold = () => car.setTyres(compound.optimalTemp, 0, compound);
    // Brake from the same speed: slicks in the wet can't even put their power down.
    for (let t = 0; t < 30 && car.speedKmh < 160; t += 1 / 240) {
      hold();
      car.step(1 / 240, c({ throttle: 1 }), asphalt);
    }
    const x0 = car.x;
    for (let t = 0; t < 10 && car.speedKmh > 5; t += 1 / 240) {
      hold();
      car.step(1 / 240, c({ brake: 1 }), asphalt);
    }
    return car.x - x0;
  };
  const slick = stop(COMPOUNDS.medium);
  const wet = stop(COMPOUNDS.wet);
  assert.ok(slick > wet * 1.3, `from 160 km/h: slick ${slick.toFixed(0)} m vs wet ${wet.toFixed(0)} m`);
});
