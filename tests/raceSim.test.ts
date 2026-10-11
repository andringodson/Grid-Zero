import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeRacingLine } from '../src/ai/racingLine.ts';
import { Field } from '../src/game/Field.ts';
import { Race, type RaceEntrant } from '../src/game/Race.ts';
import { GZ26 } from '../src/physics/carSpec.ts';
import { HALDEN_RING } from '../src/track/circuits.ts';
import { Track } from '../src/track/Track.ts';
import { seededRandom } from '../src/math.ts';

const track = new Track(HALDEN_RING);
const line = computeRacingLine(track, GZ26);
const DT = 1 / 240;
const NEUTRAL = { throttle: 0, brake: 0, steer: 0, shiftUp: false, shiftDown: false };

test('a car close behind another gets a tow and dirty air; the leader runs in clean air', () => {
  const field = new Field(track, line);
  const lead = field.addAI('lead', GZ26, { pace: 0.9, laneOffset: 0 }, 0);
  const chase = field.addAI('chase', GZ26, { pace: 0.9, laneOffset: 0 }, 0);
  // Same lateral position, 12 m apart on the main straight.
  const a = track.pointAt(300, 0);
  const b = track.pointAt(288, 0);
  lead.car.reset(a.x, a.z, a.heading);
  chase.car.reset(b.x, b.z, b.heading);
  lead.world.projection = track.project(a.x, a.z);
  chase.world.projection = track.project(b.x, b.z);
  field.plan();
  assert.equal(lead.car.airDrag, 1);
  assert.equal(lead.car.airDownforce, 1);
  assert.ok(chase.car.airDrag < 0.85, `tow ${chase.car.airDrag.toFixed(3)}`);
  assert.ok(chase.car.airDownforce < 0.95, `dirty air ${chase.car.airDownforce.toFixed(3)}`);
});

test('eight AI cars race three laps: everyone finishes, with overtakes and no big crashes', () => {
  const field = new Field(track, line);
  const rand = seededRandom(5);
  const entrants: RaceEntrant[] = [];
  // Slowest at the front so the faster cars have to get past.
  for (let slot = 0; slot < 8; slot++) {
    const id = `ai${slot}`;
    field.addAI(id, GZ26, { pace: 0.9 + slot * 0.01 + rand() * 0.004, laneOffset: 0 }, slot);
    entrants.push({ id, name: id, code: id, teamName: 't', colour: '#fff', isPlayer: false });
  }
  const race = new Race(track.length, 3, entrants, field.cars.map((fc) => fc.world.projection.s), rand);
  const startOrder = field.cars.map((fc) => fc.id);

  // Distinct heavy incidents: one per car per second at most, since a single contact spans several steps.
  const incidents = new Set<string>();
  for (let step = 0; step < 240 * 300 && race.phase !== 'finished'; step++) {
    if (step % 4 === 0) {
      field.plan();
      field.beginFrame();
    }
    field.step(DT, NEUTRAL, race.held);
    for (const fc of field.cars) if (fc.impact > 12) incidents.add(`${fc.id}@${Math.floor(step / 240)}`);
    race.update(DT, (id) => field.cars.find((fc) => fc.id === id)!.world.projection.s);
  }

  const results = race.standings();
  assert.equal(race.phase, 'finished', `only ${results.filter((r) => r.finished).length} of 8 finished`);
  const finishOrder = results.map((r) => r.entrant.id);
  const changed = finishOrder.filter((id, i) => startOrder[i] !== id).length;
  assert.ok(changed >= 2, `no overtaking: finish order ${finishOrder.join(' ')}`);
  // A few scrapes in 24 car-laps is racing; a pile-up every lap is not.
  assert.ok(incidents.size <= 12, `${incidents.size} heavy incidents: ${[...incidents].join(', ')}`);
  const winner = results[0];
  // Three laps of ~66-72 s plus the run from the grid.
  assert.ok(winner.finishTime! > 190 && winner.finishTime! < 240, `winning time ${winner.finishTime!.toFixed(1)} s`);
});
