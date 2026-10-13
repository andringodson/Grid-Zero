import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GhostRecorder, ghostPose, isGhostLap, type GhostPose } from '../src/game/ghost.ts';
import { Car } from '../src/physics/Car.ts';
import { GZ26 } from '../src/physics/carSpec.ts';

const car = new Car(GZ26, { steering: true, autoGears: true, tractionControl: true, abs: true });
const pose = (): GhostPose => ({ x: 0, y: 0, z: 0, yaw: 0, pitch: 0, roll: 0 });

function recordLine(): ReturnType<GhostRecorder['finish']> {
  const rec = new GhostRecorder();
  // A car moving along x at 50 m/s, recorded at 60 fps for 2 s.
  for (let t = 0; t <= 2; t += 1 / 60) {
    car.x = 50 * t;
    car.z = 0;
    car.yaw = 0;
    rec.add(t, car);
  }
  return rec.finish(2);
}

test('the recorder samples 20 times a second, not every frame', () => {
  const lap = recordLine();
  const n = lap.samples.length / 7;
  assert.ok(n >= 40 && n <= 42, `${n} samples for 2 s`);
  assert.ok(isGhostLap(lap));
});

test('playback interpolates between samples', () => {
  const lap = recordLine();
  const p = ghostPose(lap, 1.234, pose());
  assert.ok(p && Math.abs(p.x - 61.7) < 0.3, `x ${p?.x}`);
});

test('no pose before the lap starts or after it ends', () => {
  const lap = recordLine();
  assert.equal(ghostPose(lap, -0.1, pose()), null);
  assert.equal(ghostPose(lap, 5, pose()), null);
});

test('heading interpolates the short way across ±pi', () => {
  const lap = { time: 1, samples: [0, 0, 0, 0, Math.PI - 0.1, 0, 0, 1, 0, 0, 0, -Math.PI + 0.1, 0, 0] };
  const p = ghostPose(lap, 0.5, pose())!;
  assert.ok(Math.abs(Math.abs(p.yaw) - Math.PI) < 0.01, `yaw ${p.yaw}`);
});

test('bad saved data is rejected', () => {
  assert.equal(isGhostLap({ time: 1, samples: [1, 2, 3] }), false);
  assert.equal(isGhostLap(null), false);
});
