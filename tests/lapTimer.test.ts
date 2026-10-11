import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatDelta, formatLapTime, LapTimer, type TimingEvent } from '../src/game/LapTimer.ts';

const L = 3000;
const SECTORS = [0, 1000, 2000];
const DT = 1 / 240;

/** Drives a constant speed from `fromS` for `seconds`, wrapping at the line; returns all events. */
function drive(timer: LapTimer, fromS: number, speed: number, seconds: number, offTrackAt?: (s: number) => boolean): { s: number; events: TimingEvent[] } {
  let s = fromS;
  const events: TimingEvent[] = [];
  for (let t = 0; t < seconds - 1e-9; t += DT) {
    s = (s + speed * DT) % L;
    events.push(...timer.update(s, DT, offTrackAt?.(s) ?? false));
  }
  return { s, events };
}

test('the out-lap is not timed; the first crossing starts lap 1', () => {
  const timer = new LapTimer(L, SECTORS);
  const { events } = drive(timer, L - 100, 50, 1);
  assert.equal(events.length, 0);
  assert.equal(timer.started, false);
  drive(timer, L - 50, 50, 2);
  assert.equal(timer.started, true);
  assert.equal(timer.lap, 1);
});

test('a lap at constant speed is timed to within a physics step, with three sectors', () => {
  const timer = new LapTimer(L, SECTORS);
  timer.update(L - 1, DT, false);
  const { events } = drive(timer, L - 1, 60, 51);
  const lap = events.find((e) => e.type === 'lap');
  assert.ok(lap && lap.type === 'lap');
  assert.ok(Math.abs(lap.record.time - 50) < DT, `lap time ${lap.record.time}`);
  assert.equal(lap.record.sectors.length, 3);
  for (const sector of lap.record.sectors) assert.ok(Math.abs(sector - 50 / 3) < DT, `sector ${sector}`);
  assert.equal(lap.personalBest, true);
  assert.equal(timer.best?.time, lap.record.time);
});

test('leaving the track invalidates the lap, and an invalid lap is never a personal best', () => {
  const timer = new LapTimer(L, SECTORS);
  timer.update(L - 1, DT, false);
  const { events } = drive(timer, L - 1, 60, 51, (s) => s > 1500 && s < 1510);
  assert.ok(events.some((e) => e.type === 'invalidated'));
  const lap = events.find((e) => e.type === 'lap');
  assert.ok(lap && lap.type === 'lap');
  assert.equal(lap.record.valid, false);
  assert.equal(lap.personalBest, false);
  assert.equal(timer.best, null);
});

test('crossing the line without completing the lap does not count', () => {
  const timer = new LapTimer(L, SECTORS);
  timer.update(L - 1, DT, false);
  drive(timer, L - 1, 60, 2);
  // Teleport back behind the line, as a reset might.
  timer.update(L - 20, DT, false);
  const { events } = drive(timer, L - 20, 60, 1);
  assert.equal(events.some((e) => e.type === 'lap'), false);
});

test('the live delta is negative when ahead of the best lap', () => {
  const timer = new LapTimer(L, SECTORS);
  timer.update(L - 1, DT, false);
  drive(timer, L - 1, 60, 51);
  // Second lap, faster.
  const { s } = drive(timer, (60 * 51 - 1) % L, 75, 10);
  const d = timer.delta(s);
  assert.ok(d !== null && d < -1, `delta ${d}`);
});

test('formatting', () => {
  assert.equal(formatLapTime(83.456), '1:23.456');
  assert.equal(formatLapTime(9.5), '0:09.500');
  assert.equal(formatLapTime(null), '--:--.---');
  assert.equal(formatDelta(-0.1234), '-0.123');
  assert.equal(formatDelta(0.5), '+0.500');
});
