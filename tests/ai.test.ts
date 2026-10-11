import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Driver } from '../src/ai/Driver.ts';
import { computeRacingLine } from '../src/ai/racingLine.ts';
import { LapTimer } from '../src/game/LapTimer.ts';
import { World } from '../src/game/World.ts';
import { Car } from '../src/physics/Car.ts';
import { GZ26 } from '../src/physics/carSpec.ts';
import { HALDEN_RING } from '../src/track/circuits.ts';
import { Track } from '../src/track/Track.ts';

const track = new Track(HALDEN_RING);
const line = computeRacingLine(track, GZ26);
const DT = 1 / 240;

test('the racing line stays inside the white lines and uses the track width', () => {
  let maxAbs = 0;
  for (let i = 0; i < track.count; i++) {
    assert.ok(Math.abs(line.offset[i]) <= track.halfWidth - 1.5, `offset ${line.offset[i].toFixed(2)} at ${i}`);
    maxAbs = Math.max(maxAbs, Math.abs(line.offset[i]));
  }
  assert.ok(maxAbs > track.halfWidth - 2.5, `line never goes wide: max offset ${maxAbs.toFixed(2)} m`);
});

test('the speed profile brakes for corners and is fast on the straights', () => {
  let min = Infinity;
  let max = 0;
  for (let i = 0; i < track.count; i++) {
    min = Math.min(min, line.speed[i]);
    max = Math.max(max, line.speed[i]);
  }
  // The final hairpin: real tight hairpins are taken at 45-70 km/h.
  assert.ok(min * 3.6 > 45 && min * 3.6 < 90, `slowest corner ${(min * 3.6).toFixed(0)} km/h`);
  assert.ok(max * 3.6 > 300, `fastest point ${(max * 3.6).toFixed(0)} km/h`);
});

test('an AI driver laps Halden Ring cleanly in a realistic time', () => {
  const car = new Car(GZ26, { steering: true, autoGears: true, tractionControl: true, abs: true });
  const grid = track.gridSlot(0);
  car.reset(grid.x, grid.z, grid.heading);
  const world = new World(track, car);
  const driver = new Driver(track, line, { pace: 0.97, laneOffset: 0 });
  const timer = new LapTimer(track.length, track.sectorStarts);

  let impacts = 0;
  let offTrackSteps = 0;
  let lapTime: number | null = null;
  let valid = false;
  // An out-lap from the grid, then one flying lap.
  for (let step = 0; step < 240 * 300 && lapTime === null; step++) {
    const controls = driver.drive(car);
    car.step(DT, controls, world.probe);
    if (world.constrain(car).impact > 0) impacts++;
    if (world.allWheelsOff(car)) offTrackSteps++;
    for (const e of timer.update(world.projection.s, DT, world.allWheelsOff(car))) {
      if (e.type === 'lap') {
        lapTime = e.record.time;
        valid = e.record.valid;
      }
    }
  }
  assert.ok(lapTime !== null, 'the AI never completed a lap');
  assert.equal(impacts, 0, 'the AI hit a barrier');
  assert.equal(offTrackSteps, 0, 'the AI put all four wheels off the track');
  assert.ok(valid, 'the lap was invalid');
  // About 4.3 km of Grand Prix circuit: a modern car laps at roughly 190-230 km/h average.
  assert.ok(lapTime! > 60 && lapTime! < 95, `lap time ${lapTime!.toFixed(3)} s`);
});
