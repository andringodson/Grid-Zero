import { test } from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../src/game/World.ts';
import { Car } from '../src/physics/Car.ts';
import { GZ26 } from '../src/physics/carSpec.ts';
import { HALDEN_RING } from '../src/track/circuits.ts';
import { Track } from '../src/track/Track.ts';

const track = new Track(HALDEN_RING);
const pit = track.pit!;
const at = (s: number, lateral: number) => {
  const p = track.pointAt(s, lateral);
  return track.project(p.x, p.z);
};

test('the pit lane is asphalt alongside the pit wall, and grass beyond its ends', () => {
  const mid = (pit.wallStart + track.pitDistance(pit.wallEnd) / 2) % track.length;
  assert.equal(track.surfaceAt(at(mid, pit.lane)), 'track');
  assert.equal(track.surfaceAt(at(mid, pit.box)), 'track');
  assert.ok(track.pitWallAt(mid));
  assert.ok(track.barrierAt(at(mid, pit.lane)) <= pit.garage + 1e-9, 'the garages are the barrier');
  // Before the entry and after the exit there is no pit road.
  assert.equal(track.surfaceAt(at(pit.entry - 30, pit.lane)), 'grass');
  assert.equal(track.surfaceAt(at(pit.exit + 30, pit.lane)), 'grass');
  // Every box is on the pit lane.
  for (const b of pit.boxes) assert.ok(track.pitWallAt(b), `box at ${b.toFixed(0)}`);
});

test('the pit wall is solid from both sides', () => {
  const mid = (pit.wallStart + track.pitDistance(pit.wallEnd) / 2) % track.length;
  for (const [lateral, pushedTo] of [[pit.wallInner + 0.2, -1], [pit.wallOuter - 0.2, 1]] as const) {
    const p = track.pointAt(mid, lateral);
    const car = new Car(GZ26, { steering: true, autoGears: true, tractionControl: true, abs: true });
    car.reset(p.x, p.z, p.heading);
    const world = new World(track, car);
    world.constrain(car);
    const after = track.project(car.x, car.z).lateral;
    if (pushedTo < 0) assert.ok(after <= pit.wallInner - 0.99, `track side: ${after.toFixed(2)}`);
    else assert.ok(after >= pit.wallOuter + 0.99, `pit side: ${after.toFixed(2)}`);
  }
});
