import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RUNOFF_ASPHALT, RUNOFF_GRAVEL, Track } from '../src/track/Track.ts';
import { HALDEN_RING } from '../src/track/circuits.ts';

const track = new Track(HALDEN_RING);

test('Halden Ring is a realistic Grand Prix length', () => {
  assert.ok(track.length > 3500 && track.length < 5500, `length ${track.length.toFixed(0)} m`);
});

test('no corner is tighter than a hairpin a race car can take', () => {
  let maxCurv = 0;
  for (let k = 0; k < track.count; k++) maxCurv = Math.max(maxCurv, Math.abs(track.curvature[k]));
  assert.ok(1 / maxCurv > 14, `tightest radius ${(1 / maxCurv).toFixed(1)} m`);
});

test('separate parts of the circuit never overlap', () => {
  const clearance = track.width + 2 * track.kerbWidth + 10;
  for (let a = 0; a < track.count; a += 2) {
    for (let b = 0; b < track.count; b += 2) {
      if (track.cyclicDistance(a * track.spacing, b * track.spacing) < 150) continue;
      const d = Math.hypot(track.xs[a] - track.xs[b], track.zs[a] - track.zs[b]);
      assert.ok(d > clearance, `samples ${a} and ${b} are only ${d.toFixed(1)} m apart`);
    }
  }
});

test('barriers always leave room beyond the kerbs', () => {
  const edge = track.halfWidth + track.kerbWidth;
  for (let k = 0; k < track.count; k++) {
    assert.ok(track.barrierLeft[k] > edge + 2, `left barrier at sample ${k} is ${track.barrierLeft[k].toFixed(1)} m`);
    assert.ok(track.barrierRight[k] > edge + 2, `right barrier at sample ${k} is ${track.barrierRight[k].toFixed(1)} m`);
  }
});

test('the circuit is driven clockwise, so it turns right overall by one full turn', () => {
  let total = 0;
  for (let k = 0; k < track.count; k++) total += track.curvature[k] * track.spacing;
  assert.ok(Math.abs(total - 2 * Math.PI) < 0.05, `total turning ${total.toFixed(3)} rad`);
});

test('projecting a point recovers its distance and lateral offset', () => {
  for (const s of [5, 600, 1500, 2222, track.length - 30]) {
    for (const lateral of [-6, 0, 4.5]) {
      const p = track.pointAt(s, lateral);
      const proj = track.project(p.x, p.z);
      assert.ok(track.cyclicDistance(proj.s, s) < 0.5, `s ${s} came back as ${proj.s.toFixed(2)}`);
      assert.ok(Math.abs(proj.lateral - lateral) < 0.2, `lateral ${lateral} came back as ${proj.lateral.toFixed(2)}`);
    }
  }
});

test('a hinted projection agrees with a full search', () => {
  const p = track.pointAt(1000, 3);
  const full = track.project(p.x, p.z);
  const hinted = track.project(p.x, p.z, full.index + 5);
  assert.equal(hinted.index, full.index);
});

test('surfaces: track inside the white lines, grass well outside', () => {
  const mid = track.project(track.pointAt(300, 0).x, track.pointAt(300, 0).z);
  assert.equal(track.surfaceAt(mid), 'track');
  const off = track.pointAt(300, track.halfWidth + 6);
  assert.equal(track.surfaceAt(track.project(off.x, off.z)), 'grass');
});

test('grid slots sit on the track behind the line', () => {
  for (let slot = 0; slot < 20; slot++) {
    const g = track.gridSlot(slot);
    const p = track.project(g.x, g.z);
    assert.equal(track.surfaceAt(p), 'track');
    assert.ok(p.s > track.length - 200, `slot ${slot} is at ${p.s.toFixed(0)} m`);
  }
});

test('run-off: gravel outside faster corners, asphalt outside the tight ones, none on the straights', () => {
  let gravel = 0;
  let asphalt = 0;
  for (let k = 0; k < track.count; k++) {
    for (const side of [track.runoffLeft, track.runoffRight]) {
      if (side[k] === RUNOFF_GRAVEL) gravel++;
      if (side[k] === RUNOFF_ASPHALT) asphalt++;
    }
  }
  assert.ok(gravel * track.spacing > 200, `${gravel * track.spacing} m of gravel`);
  assert.ok(asphalt * track.spacing > 200, `${asphalt * track.spacing} m of asphalt run-off`);
  // The middle of the main straight is grass on both sides.
  const mid = Math.round(200 / track.spacing);
  assert.equal(track.runoffLeft[mid] + track.runoffRight[mid], 0);
  // Run-off is on the outside: at the tightest point of the final hairpin (a right-hander), the left side.
  let tightest = 0;
  for (let k = 0; k < track.count; k++) if (Math.abs(track.curvature[k]) > Math.abs(track.curvature[tightest])) tightest = k;
  const outside = track.curvature[tightest] > 0 ? track.runoffLeft : track.runoffRight;
  assert.equal(outside[tightest], RUNOFF_ASPHALT);
});

test('surfaces beyond the kerb follow the run-off', () => {
  for (let k = 0; k < track.count; k += 7) {
    for (const [sideSign, side] of [[-1, track.runoffLeft], [1, track.runoffRight]] as const) {
      const lateral = sideSign * (track.halfWidth + track.kerbWidth + 3);
      if (lateral * sideSign >= (sideSign > 0 ? track.barrierRight[k] : track.barrierLeft[k])) continue;
      const p = track.pointAt(k * track.spacing, lateral);
      const proj = track.project(p.x, p.z, k);
      const want = side[proj.index] === RUNOFF_GRAVEL ? 'gravel' : side[proj.index] === RUNOFF_ASPHALT ? 'runoff' : 'grass';
      assert.equal(track.surfaceAt(proj), want);
    }
  }
});
