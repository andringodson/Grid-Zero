import { test } from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../src/game/World.ts';
import { Car } from '../src/physics/Car.ts';
import { GZ26 } from '../src/physics/carSpec.ts';
import { HALDEN_RING } from '../src/track/circuits.ts';
import { Track } from '../src/track/Track.ts';
import { computeRacingLine } from '../src/ai/racingLine.ts';
import { Field, type FieldCar } from '../src/game/Field.ts';
import { aiPitCall, limitEnd, PIT_SPEED, pitU } from '../src/game/pits.ts';
import { COMPOUNDS } from '../src/physics/tyre.ts';

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

const line = computeRacingLine(track, GZ26);
const DT = 1 / 240;
const NEUTRAL = { throttle: 0, brake: 0, steer: 0, shiftUp: false, shiftDown: false };

/** Puts a car at distance s and lateral offset, stopped, facing along the track. */
function place(fc: FieldCar, s: number, lateral: number): void {
  const p = track.pointAt(s, lateral);
  fc.car.reset(p.x, p.z, p.heading);
  fc.world.forgetPosition();
  fc.world.projection = track.project(p.x, p.z);
}

/** Runs until the car passes `until` metres after the pit entry; returns what happened on the way. */
function drive(field: Field, fc: FieldCar, until: number, limit = 120) {
  const A = track.pitDistance(pit.wallStart);
  const B = track.pitDistance(pit.wallEnd);
  let t = 0;
  let maxInLimit = 0;
  let stopped = false;
  let maxImpact = 0;
  let passedEntry = false;
  while (t < limit) {
    field.beginFrame();
    field.plan();
    for (let k = 0; k < 8; k++) field.step(DT, NEUTRAL, false);
    t += 8 * DT;
    const u = pitU(track, fc.world.projection.s);
    if (u > A - 5 && u < B + 5 && fc.pit) maxInLimit = Math.max(maxInLimit, fc.car.speed);
    if (fc.pit?.phase === 'service') stopped = true;
    maxImpact = Math.max(maxImpact, fc.impact);
    if (u > 0 && u < 100) passedEntry = true;
    if (passedEntry && u > until) break;
  }
  return { t, maxInLimit, stopped, maxImpact };
}

test('an AI car called in drives through the pits at the limit, stops in its box for new tyres, and rejoins', () => {
  const field = new Field(track, line);
  const fc = field.addAI('ai', GZ26, { pace: 0.95, laneOffset: 0 }, 0);
  fc.box = pit.boxes[3];
  place(fc, pit.entry - 350, line.offset[0]);
  fc.car.setTyres(90, 0.3, COMPOUNDS.medium);
  assert.ok(field.requestPit(fc, COMPOUNDS.inter));
  const end = track.pitDistance(pit.exit) + 200;
  const r = drive(field, fc, end);
  assert.ok(r.stopped, 'stopped in the box');
  assert.equal(fc.car.compound.id, 'inter');
  assert.ok(fc.car.tyreWear.every((w) => w < 0.05), 'fresh tyres');
  assert.equal(fc.pit, null, 'back racing');
  assert.ok(r.maxInLimit < PIT_SPEED + 0.3, `${(r.maxInLimit * 3.6).toFixed(1)} km/h in the pit lane`);
  assert.ok(r.maxImpact < 2, `hit something at ${r.maxImpact.toFixed(1)} m/s`);
  assert.ok(Math.abs(fc.world.projection.lateral) < track.halfWidth, 'back on the track');

  // The same run without stopping: a stop costs what it does in a real race, about 20 seconds.
  const clean = new Field(track, line);
  const other = clean.addAI('ai', GZ26, { pace: 0.95, laneOffset: 0 }, 0);
  place(other, pit.entry - 350, line.offset[0]);
  other.car.setTyres(90, 0.3, COMPOUNDS.medium);
  const base = drive(clean, other, end);
  const loss = r.t - base.t;
  assert.ok(loss > 12 && loss < 32, `pit stop costs ${loss.toFixed(1)} s`);
});

test('driving onto the pit road commits the player to a stop; control comes back at the end of the limit', () => {
  const field = new Field(track, line);
  const car = new Car(GZ26, { steering: true, autoGears: true, tractionControl: true, abs: true });
  const fc = field.addPlayer('player', car, new World(track, car));
  fc.box = pit.boxes[0];
  field.pitTyres = () => COMPOUNDS.soft;
  car.setTyres(90, 0.5, COMPOUNDS.hard);
  place(fc, pit.entry + 40, pit.side * (track.halfWidth + 3));
  const r = drive(field, fc, limitEnd(track) + 5);
  assert.ok(r.stopped, 'stopped in the box');
  assert.equal(car.compound.id, 'soft');
  assert.equal(fc.pit, null, 'the player drives again');
  assert.ok(r.maxImpact < 2, `hit something at ${r.maxImpact.toFixed(1)} m/s`);
});

test('rain on slicks: rivals come in for intermediates over a lap, use their own boxes, and nobody crashes', () => {
  const field = new Field(track, line);
  field.wetness = 0.35;
  const cars = [0, 1, 2, 3].map((k) => {
    const fc = field.addAI(`ai-${k}`, GZ26, { pace: 0.9, laneOffset: 0, consistency: 0.9, seed: k + 1 }, 0);
    fc.box = pit.boxes[k * 2];
    place(fc, pit.entry - 420 - k * 40, line.offset[0]);
    fc.car.setTyres(95, 0.1, COMPOUNDS.soft);
    return fc;
  });
  let maxImpact = 0;
  for (let t = 0; t < 110; t += 8 * DT) {
    field.beginFrame();
    field.plan();
    for (const fc of cars) {
      const u = pitU(track, fc.world.projection.s);
      if (!fc.pit && !fc.pitRequest && u > -210 && u < -150) {
        const tyres = aiPitCall(fc.id, fc.car, field.wetness);
        if (tyres) field.requestPit(fc, tyres);
      }
    }
    for (let k = 0; k < 8; k++) field.step(DT, NEUTRAL, false);
    for (const fc of cars) maxImpact = Math.max(maxImpact, fc.impact);
  }
  for (const fc of cars) assert.equal(fc.car.compound.id, 'inter', `${fc.id} on ${fc.car.compound.id}`);
  assert.ok(maxImpact < 6, `hardest hit ${maxImpact.toFixed(1)} m/s`);
});
