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
  const race = new Race(L, 1, [entrant('a')], [L - 10], { random: () => 0.5 });
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
  const race = new Race(L, 2, [entrant('fast'), entrant('slow', true)], [L - 10, L - 18], { random: () => 0 });
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

test('DRS is enabled only within a second of the car ahead at the detection point, and only from the set lap', () => {
  const zone = { detection: 400, start: 450, end: 700 };
  const race = new Race(L, 5, [entrant('lead'), entrant('near'), entrant('far')], [L - 10, L - 18, L - 200], {
    random: () => 0,
    drsZones: [zone],
    drsFromLap: 2,
  });
  const s = { lead: L - 10, near: L - 18, far: L - 200 };
  // Lap 1: nobody may use DRS yet.
  run(race, { lead: 50, near: 50, far: 50 }, s, 15);
  assert.equal(race.drsAvailable('near', 500), false);
  // Lap 2: 'near' is 0.16 s behind at detection, 'far' is several seconds back.
  const events = run(race, { lead: 50, near: 50, far: 50 }, { lead: 750, near: 742, far: 560 }, 15);
  assert.ok(events.some((e) => e.type === 'drs' && e.entrant.id === 'near' && e.enabled));
  assert.equal(race.drsAvailable('near', 500), true);
  assert.equal(race.drsAvailable('near', 800), false, 'outside the zone');
  assert.equal(race.drsAvailable('far', 500), false);
  assert.equal(race.drsAvailable('lead', 500), false);
});

test('three track-limits warnings, then a 5 s penalty that counts in the classification', () => {
  const race = new Race(L, 1, [entrant('a'), entrant('b')], [L - 10, L - 12], { random: () => 0 });
  run(race, { a: 0, b: 0 }, { a: L - 10, b: L - 12 }, 6.1);
  const offences = [1, 2, 3, 4].flatMap(() => race.trackLimits('a'));
  const last = offences[offences.length - 1];
  assert.ok(last.type === 'trackLimits' && last.warnings === 4 && last.penalty === 5);
  // 'a' crosses the line 2 m ahead of 'b' but loses the win to the penalty.
  run(race, { a: 50, b: 50 }, { a: L - 10, b: L - 12 }, 30);
  assert.equal(race.standings()[0].entrant.id, 'b');
});

test('positions follow distance covered, and gaps reflect time behind', () => {
  const race = new Race(L, 5, [entrant('a'), entrant('b')], [L - 10, L - 18], { random: () => 0 });
  run(race, { a: 50, b: 50 }, { a: L - 10, b: L - 18 }, 30);
  assert.equal(race.position('a'), 1);
  assert.equal(race.position('b'), 2);
  // b is 8 m behind at 50 m/s: 0.16 s, measured at 25 m checkpoints.
  assert.ok(Math.abs(race.standing('b').gap - 0.16) < 0.05, `gap ${race.standing('b').gap}`);
});
