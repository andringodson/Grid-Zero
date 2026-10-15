import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeRacingLine } from '../src/ai/racingLine.ts';
import { Field } from '../src/game/Field.ts';
import { aiLapTime, gridSlots, idealLap } from '../src/game/grid.ts';
import { LapTimer } from '../src/game/LapTimer.ts';
import { GZ26 } from '../src/physics/carSpec.ts';
import { COMPOUNDS } from '../src/physics/tyre.ts';
import { HALDEN_RING } from '../src/track/circuits.ts';
import { Track } from '../src/track/Track.ts';

test('the grid lines up by qualifying time, and a car without a time starts from the back', () => {
  assert.deepEqual(gridSlots([68.2, 66.9, Infinity, 67.5]), [2, 0, 3, 1]);
});

test("rivals' qualifying times match what the AI really laps at that pace", () => {
  const track = new Track(HALDEN_RING);
  const line = computeRacingLine(track, GZ26);
  const ideal = idealLap(track, line);
  const pace = 0.93;
  const field = new Field(track, line);
  const fc = field.addAI('ai', GZ26, { pace, laneOffset: 0 }, 0);
  fc.car.setTyres(95, 0, COMPOUNDS.medium);
  fc.car.fuel = 10;
  const timer = new LapTimer(track.length, track.sectorStarts, null);
  const NEUTRAL = { throttle: 0, brake: 0, steer: 0, shiftUp: false, shiftDown: false };
  const laps: number[] = [];
  for (let t = 0; t < 200 && laps.length < 2; t += 1 / 240) {
    field.beginFrame();
    if (Math.round(t * 240) % 8 === 0) field.plan();
    field.step(1 / 240, NEUTRAL, false);
    for (const e of timer.update(fc.world.projection.s, 1 / 240, false)) if (e.type === 'lap') laps.push(e.record.time);
  }
  // The second lap is the flying one.
  const predicted = aiLapTime(ideal, pace);
  assert.ok(Math.abs(laps[1] - predicted) < 1, `flying lap ${laps[1].toFixed(2)} s, predicted ${predicted.toFixed(2)} s`);
});
