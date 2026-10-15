import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeRacingLine } from '../src/ai/racingLine.ts';
import { Field } from '../src/game/Field.ts';
import { aiLapTime, idealLap } from '../src/game/grid.ts';
import { LapTimer } from '../src/game/LapTimer.ts';
import { pitU } from '../src/game/pits.ts';
import { GZ26 } from '../src/physics/carSpec.ts';
import { COMPOUNDS } from '../src/physics/tyre.ts';
import { CIRCUITS } from '../src/track/circuits.ts';
import { Track } from '../src/track/Track.ts';

// What every circuit must satisfy for the game to work on it: geometry, elevation, a pit lane, and a clean AI lap.
for (const def of CIRCUITS) {
  const track = new Track(def);

  test(`${def.name}: a Grand Prix length, corners a car can take, and no part overlapping another`, () => {
    assert.ok(track.length > 3000 && track.length < 7000, `length ${track.length.toFixed(0)} m`);
    let maxCurv = 0;
    for (let k = 0; k < track.count; k++) maxCurv = Math.max(maxCurv, Math.abs(track.curvature[k]));
    assert.ok(1 / maxCurv > 14, `tightest radius ${(1 / maxCurv).toFixed(1)} m`);
    const clearance = track.width + 2 * track.kerbWidth + 10;
    for (let a = 0; a < track.count; a += 2) {
      for (let b = 0; b < track.count; b += 2) {
        if (track.cyclicDistance(a * track.spacing, b * track.spacing) < 150) continue;
        const d = Math.hypot(track.xs[a] - track.xs[b], track.zs[a] - track.zs[b]);
        assert.ok(d > clearance, `samples ${a} and ${b} are only ${d.toFixed(1)} m apart`);
      }
    }
    const edge = track.halfWidth + track.kerbWidth;
    for (let k = 0; k < track.count; k++) {
      assert.ok(Math.min(track.barrierLeft[k], track.barrierRight[k]) > edge + 2, `barrier too close at sample ${k}`);
    }
  });

  test(`${def.name}: a closed, smooth elevation profile with realistic gradients and crests`, () => {
    let maxGrade = 0;
    let maxVert = 0;
    for (let k = 0; k < track.count; k++) {
      maxGrade = Math.max(maxGrade, Math.abs(track.grade[k]));
      maxVert = Math.max(maxVert, Math.abs(track.verticalCurvature[k]));
    }
    assert.ok(maxGrade < 0.07, `grade ${(maxGrade * 100).toFixed(1)}%`);
    assert.ok(maxVert < 1 / 1500, `vertical curvature 1/${(1 / maxVert).toFixed(0)} m`);
    assert.ok(Math.abs(track.ys[0] - track.ys[track.count - 1]) < 0.1, 'the lap must close on itself');
  });

  test(`${def.name}: a pit lane alongside a straight, with every box on it`, () => {
    const pit = track.pit!;
    assert.ok(pit, 'no pit lane');
    for (const b of pit.boxes) assert.ok(track.pitWallAt(b - 30) && track.pitWallAt(b + 30), `box at ${b.toFixed(0)} too near the wall's end`);
    // The pit road runs where the track is straight, so it can sit beside it.
    for (let u = 0; u <= track.pitDistance(pit.exit); u += track.spacing) {
      const i = Math.floor(track.wrapS(pit.entry + u) / track.spacing) % track.count;
      assert.ok(Math.abs(track.curvature[i]) < 1 / 300, `pit road beside a corner, ${u.toFixed(0)} m from the entry`);
    }
  });

  test(`${def.name}: an AI driver laps cleanly in a realistic time`, () => {
    const line = computeRacingLine(track, GZ26);
    const field = new Field(track, line);
    const fc = field.addAI('ai', GZ26, { pace: 0.95, laneOffset: 0 }, 0);
    fc.car.setTyres(95, 0, COMPOUNDS.medium);
    fc.car.fuel = 10;
    const timer = new LapTimer(track.length, track.sectorStarts, null);
    const NEUTRAL = { throttle: 0, brake: 0, steer: 0, shiftUp: false, shiftDown: false };
    const laps: { time: number; valid: boolean }[] = [];
    let hardest = 0;
    let offSteps = 0;
    // An out-lap from the grid, then a flying lap.
    for (let t = 0; t < 260 && laps.length < 2; t += 1 / 240) {
      field.beginFrame();
      if (Math.round(t * 240) % 8 === 0) field.plan();
      field.step(1 / 240, NEUTRAL, false);
      hardest = Math.max(hardest, fc.impact);
      if (fc.world.allWheelsOff(fc.car)) offSteps++;
      for (const e of timer.update(fc.world.projection.s, 1 / 240, fc.world.allWheelsOff(fc.car))) {
        if (e.type === 'lap') laps.push({ time: e.record.time, valid: e.record.valid });
      }
    }
    assert.equal(laps.length, 2, 'the AI never completed a flying lap');
    assert.equal(hardest, 0, `the AI hit a barrier at ${hardest.toFixed(1)} m/s`);
    assert.equal(offSteps, 0, 'the AI put all four wheels off the track');
    assert.ok(laps[1].valid, 'the flying lap was invalid');
    // A modern Grand Prix car averages roughly 190-240 km/h over a lap.
    const avg = (track.length / laps[1].time) * 3.6;
    assert.ok(avg > 180 && avg < 250, `flying lap ${laps[1].time.toFixed(2)} s, ${avg.toFixed(0)} km/h average`);
    // Rivals' qualifying times come from this model; it must match how they really lap here.
    const predicted = aiLapTime(idealLap(track, line), 0.95, def.lapScale);
    assert.ok(Math.abs(laps[1].time - predicted) < 1, `flying lap ${laps[1].time.toFixed(2)} s, qualifying model ${predicted.toFixed(2)} s`);
  });

  test(`${def.name}: an AI car called in stops in its box, changes tyres and rejoins cleanly`, () => {
    const pit = track.pit!;
    const line = computeRacingLine(track, GZ26);
    const field = new Field(track, line);
    const fc = field.addAI('ai', GZ26, { pace: 0.95, laneOffset: 0 }, 0);
    fc.box = pit.boxes[pit.boxes.length - 1];
    const start = track.pointAt(pit.entry - 400, line.offset[0]);
    fc.car.reset(start.x, start.z, start.heading);
    fc.world.forgetPosition();
    fc.world.projection = track.project(start.x, start.z);
    fc.car.setTyres(90, 0.4, COMPOUNDS.hard);
    field.requestPit(fc, COMPOUNDS.soft);
    const NEUTRAL = { throttle: 0, brake: 0, steer: 0, shiftUp: false, shiftDown: false };
    let stopped = false;
    let hardest = 0;
    for (let t = 0; t < 120; t += 1 / 240) {
      field.beginFrame();
      if (Math.round(t * 240) % 8 === 0) field.plan();
      field.step(1 / 240, NEUTRAL, false);
      hardest = Math.max(hardest, fc.impact);
      if (fc.pit?.phase === 'service') stopped = true;
      const u = pitU(track, fc.world.projection.s);
      if (stopped && !fc.pit && u > track.pitDistance(pit.exit) + 200) break;
    }
    assert.ok(stopped, 'never stopped in the box');
    assert.equal(fc.car.compound.id, 'soft');
    assert.equal(fc.pit, null, 'still in the pits');
    assert.ok(hardest < 2, `hit something at ${hardest.toFixed(1)} m/s`);
  });
}
