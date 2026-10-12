export interface CircuitDefinition {
  id: string;
  name: string;
  /** Closed loop of control points [x, z] in metres, in driving order. The first point is the start/finish line. */
  points: readonly (readonly [number, number])[];
  /** Full width of the racing surface in metres. */
  width: number;
  /** Height in metres at each control point. Omit for a flat circuit. */
  heights?: readonly number[];
  /** Camber in radians at each control point: positive raises the right-hand edge. Omit for none. */
  camber?: readonly number[];
}

/**
 * Halden Ring: a fictional 4 km circuit. A long main straight into a heavy-braking right-hander,
 * esses and a fast sweeper on the east side, a back straight, then a technical west side with a
 * chicane and a final hairpin onto the main straight. Driven clockwise as seen from above.
 */
export const HALDEN_RING: CircuitDefinition = {
  id: 'halden-ring',
  name: 'Halden Ring',
  width: 14,
  points: [
    [0, 0],
    [450, 0],
    // Turn 1: heavy braking right-hander
    [560, 20],
    [600, 100],
    [590, 220],
    // Turns 2-3: esses
    [520, 300],
    [540, 400],
    [620, 460],
    [740, 470],
    // Turn 4: long fast sweeper
    [840, 520],
    [870, 640],
    [820, 740],
    // Back straight
    [700, 780],
    [300, 790],
    [-100, 790],
    // Turn 5: right-hander up the west side
    [-230, 760],
    [-290, 660],
    [-300, 520],
    // Turns 6-7: chicane
    [-260, 460],
    [-310, 400],
    [-340, 330],
    // Turn 8 and the final hairpin
    [-420, 220],
    [-600, 160],
    [-700, 80],
    [-660, 10],
    [-500, 0],
  ],
  // Downhill into Turn 1, a climb through the esses to a crest before the sweeper, a long descent down the back
  // straight, then up again through the chicane and down to the hairpin. Grades stay under about 6%.
  heights: [0, -1.5, -3, -2, 2, 6, 10, 12.5, 14.5, 14, 11, 8, 5.5, 1.5, 0, 0.5, 3.5, 7.5, 9.5, 10, 9.5, 7, 4, 2, 1.5, 0.8],
  // Banked a little through the final hairpin and the Turn 4 sweeper (both right-handers: left edge higher).
  camber: [0, 0, 0, 0, 0, 0, 0, 0, 0, -0.03, -0.04, -0.03, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, -0.02, -0.05, -0.04, 0],
};
