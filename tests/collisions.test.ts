import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Car } from '../src/physics/Car.ts';
import { GZ26 } from '../src/physics/carSpec.ts';
import { resolveCollisions } from '../src/physics/collisions.ts';

const assists = { steering: true, autoGears: true, tractionControl: true, abs: true };
const carAt = (x: number, z: number, yaw: number, u = 0) => {
  const c = new Car(GZ26, assists);
  c.reset(x, z, yaw);
  c.u = u;
  return c;
};
const momentumX = (cars: Car[]) => cars.reduce((sum, c) => sum + c.u * Math.cos(c.yaw) - c.v * Math.sin(c.yaw), 0);

test('cars far apart do not interact', () => {
  const a = carAt(0, 0, 0, 30);
  const b = carAt(20, 0, 0, 10);
  assert.equal(resolveCollisions([a, b]).length, 0);
  assert.equal(a.u, 30);
});

test('a rear-end hit pushes the car ahead, conserves momentum and separates the cars', () => {
  const a = carAt(0, 0, 0, 40);
  const b = carAt(4.6, 0, 0, 20);
  const before = momentumX([a, b]);
  const contacts = resolveCollisions([a, b]);
  assert.equal(contacts.length, 1);
  assert.ok(Math.abs(contacts[0].speed - 20) < 1e-6);
  assert.ok(b.u > 20 && a.u < 40, `a ${a.u.toFixed(1)}, b ${b.u.toFixed(1)}`);
  assert.ok(Math.abs(momentumX([a, b]) - before) < 1e-6);
  // a's front disc and b's rear disc no longer overlap.
  assert.ok(b.x - 1.45 - (a.x + 1.45) >= 2 * 0.95 - 1e-9, 'cars still overlap');
});

test('a side impact on the nose turns the struck car away', () => {
  // a is stationary facing +x; b drives in from -z (a's left) and hits a's front disc.
  const a = carAt(0, 0, 0, 0);
  const b = carAt(1.45, -3.05, Math.PI / 2, 10);
  const contacts = resolveCollisions([a, b]);
  assert.equal(contacts.length, 1);
  // Pushed toward +z at the nose: a yaws to the right (positive).
  assert.ok(a.r > 0.05, `a yaw rate ${a.r}`);
});

test('cars moving apart are separated but get no impulse', () => {
  const a = carAt(0, 0, 0, 10);
  const b = carAt(3.5, 0, 0, 30);
  resolveCollisions([a, b]);
  assert.equal(a.u, 10);
  assert.equal(b.u, 30);
});
