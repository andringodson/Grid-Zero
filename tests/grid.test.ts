import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gridSlots } from '../src/game/grid.ts';

test('the grid lines up by qualifying time, and a car without a time starts from the back', () => {
  assert.deepEqual(gridSlots([68.2, 66.9, Infinity, 67.5]), [2, 0, 3, 1]);
});
