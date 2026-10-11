import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Race, type RaceEntrant, type RaceEvent } from '../src/game/Race.ts';

const L = 1000;
const DT = 1 / 60;
const entrant = (id: string, isPlayer = false): RaceEntrant => ({ id, name: id, code: id.toUpperCase(), teamName: 'T', colour: '#fff', isPlayer });

/** Runs the race with constant speeds per car until it ends or time runs out. */
function run(race: Race, speeds: Record<string, number>, startS: Record<string, number>, seconds: number): RaceEvent[] {
  const s = { ...startS };
  const events: RaceEvent[] = [];
  for (let t = 0; t < seconds && race.phase !== 'finished'; t += DT) {
    if (race.phase === 'racing') for (const id of Object.keys(s)) s[id] = (s[id] + speeds[id] * DT) % L;
    events.push(...race.update(DT, (id) => s[id]));
  }
  return events;
}

test('five lights come on a second apart, then go out after a hold', () => {
  const race = new Race(L, 1, [entrant('a')], [L - 10], () => 0.5);
  const events = run(race, { a: 0 }, { a: L - 10 }, 6.5);
  const lights = events.filter((e) => e.type === 'light').map((e) => (e.type === 'light' ? e.count : 0));
  assert.deepEqual(lights, [1, 2, 3, 4, 5]);
  assert.ok(events.some((e) => e.type === 'lightsOut'));
  assert.equal(race.phase, 'racing');
});

test('cars are held on the grid until the lights go out', () => {
  const race = new Race(L, 1, [entrant('a')], [L - 10]);
  assert.equal(race.held, true);
});

test('crossing the line from the grid starts lap 1; the faster car wins', () => {
  const race = new Race(L, 2, [entrant('fast'), entrant('slow', true)], [L - 10, L - 18], () => 0);
  const events = run(race, { fast: 50, slow: 40 }, { fast: L - 10, slow: L - 18 }, 120);
  const finishes = events.filter((e) => e.type === 'finish');
  assert.equal(finishes.length, 2);
  assert.equal(finishes[0].type === 'finish' && finishes[0].entrant.id, 'fast');
  assert.equal(race.phase, 'finished');
  // Two laps of 1000 m from 10 m behind the line at 50 m/s: 40.2 s.
  const winner = race.standing('fast');
  assert.ok(Math.abs(winner.finishTime! - 40.2) < 0.05, `finish ${winner.finishTime}`);
  assert.ok(Math.abs(winner.bestLap! - 20) < 0.05, `best lap ${winner.bestLap}`);
});

test('positions follow distance covered, and gaps reflect time behind', () => {
  const race = new Race(L, 5, [entrant('a'), entrant('b')], [L - 10, L - 18], () => 0);
  run(race, { a: 50, b: 50 }, { a: L - 10, b: L - 18 }, 30);
  assert.equal(race.position('a'), 1);
  assert.equal(race.position('b'), 2);
  // b is 8 m behind at 50 m/s: 0.16 s, measured at 25 m checkpoints.
  assert.ok(Math.abs(race.standing('b').gap - 0.16) < 0.05, `gap ${race.standing('b').gap}`);
});
