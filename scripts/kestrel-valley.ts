// Generates Kestrel Valley's control points, heights and camber for src/track/circuits.ts.
// Run: node --experimental-strip-types scripts/kestrel-valley.ts
//
// The lap is described as straights and arcs of set radii. Two straights (X, Y) are solved so the loop closes
// exactly; the last (Z) is the run to the line. Heights and banking are given by position along the lap.

type Seg = { len?: number; turn?: number; r?: number; adj?: 'X' | 'Y' | 'Z' };
const D = Math.PI / 180;
const Z_LEN = 260;

// Clockwise: right turns positive. Heading 0 is east (+x), 90 is south (+z).
const SEGS: Seg[] = [
  { len: 520 }, // 0 main straight after the line
  { turn: 95, r: 32 }, // 1 T1, heavy-braking right
  { len: 170 }, // 2
  { turn: -70, r: 60 }, // 3 T2, left
  { len: 120 }, // 4
  { turn: 80, r: 115 }, // 5 T3, fast right, downhill
  { len: 210 }, // 6
  { turn: -35, r: 90 }, // 7 T4-T5, esses on the valley floor
  { turn: 50, r: 80 }, // 8
  { turn: -25, r: 100 }, // 9
  { len: 150 }, // 10
  { turn: 110, r: 75 }, // 11 T6, banked carousel
  { len: 0, adj: 'X' }, // 12 back straight, uphill
  { turn: -55, r: 22 }, // 13 T7-T8 chicane
  { turn: 55, r: 22 }, // 14
  { len: 160 }, // 15
  { turn: 65, r: 55 }, // 16 T9, crest
  { len: 0, adj: 'Y' }, // 17
  { turn: -30, r: 80 }, // 18 T10, left kink
  { len: 120 }, // 19
  { turn: 120, r: 55 }, // 20 T11, long final corner
  { len: Z_LEN, adj: 'Z' }, // 21 to the line
];

function walk(vals: Record<string, number>) {
  let x = 0;
  let z = 0;
  let h = 0;
  let s = 0;
  const pts: [number, number][] = [[0, 0]];
  const ends: number[] = [];
  for (const g of SEGS) {
    if (g.turn !== undefined) {
      const ang = g.turn * D;
      const n = Math.max(2, Math.ceil((Math.abs(ang) * g.r!) / 22));
      for (let k = 1; k <= n; k++) {
        const dh = ang / n;
        const chord = 2 * g.r! * Math.sin(Math.abs(dh) / 2);
        x += chord * Math.cos(h + dh / 2);
        z += chord * Math.sin(h + dh / 2);
        h += dh;
        s += g.r! * Math.abs(dh);
        pts.push([x, z]);
      }
    } else {
      const len = g.adj ? vals[g.adj] : g.len!;
      const n = Math.max(1, Math.round(len / 45));
      for (let k = 1; k <= n; k++) {
        x += (len / n) * Math.cos(h);
        z += (len / n) * Math.sin(h);
        s += len / n;
        pts.push([x, z]);
      }
    }
    ends.push(s);
  }
  return { x, z, pts, ends };
}

// The end position is linear in X and Y: solve the 2x2 system that brings it back to the start.
const base = walk({ X: 0, Y: 0, Z: Z_LEN });
const ux = walk({ X: 1, Y: 0, Z: Z_LEN });
const uy = walk({ X: 0, Y: 1, Z: Z_LEN });
const ax = [ux.x - base.x, ux.z - base.z];
const ay = [uy.x - base.x, uy.z - base.z];
const det = ax[0] * ay[1] - ax[1] * ay[0];
const X = (-base.x * ay[1] + base.z * ay[0]) / det;
const Y = (-ax[0] * base.z + ax[1] * base.x) / det;
const lap = walk({ X, Y, Z: Z_LEN });
const pts = lap.pts.slice(0, -1).map(([a, b]) => [Math.round(a), Math.round(b)] as [number, number]);

const sOf: number[] = [0];
for (let i = 1; i < pts.length; i++) sOf.push(sOf[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
const L = sOf[sOf.length - 1] + Math.hypot(pts[0][0] - pts[pts.length - 1][0], pts[0][1] - pts[pts.length - 1][1]);
const e = lap.ends;

// Height in metres at the end of each segment, linear between: down into the valley, up the back straight to the crest.
const profile: [number, number][] = [
  [0, 30], [e[0], 31], [e[1], 31], [e[2], 29], [e[3], 27], [e[4], 22], [e[5], 14], [e[6], 4.5], [e[8], 1.2], [e[9], 0.4],
  [e[10], 0.8], [e[11], 3], [e[12], 25], [e[14], 26.5], [e[15], 31], [e[16], 32.3], [e[17], 33.5], [e[18], 33],
  [e[19], 32], [e[20], 31], [L, 30],
];
const heightAt = (v: number) => {
  for (let i = 1; i < profile.length; i++) {
    if (v > profile[i][0]) continue;
    const [a, ya] = profile[i - 1];
    const [b, yb] = profile[i];
    return ya + ((yb - ya) * (v - a)) / (b - a);
  }
  return profile[0][1];
};
// Banking by corner: right-handers raise the left edge (negative camber).
const banks: [number, number, number][] = [[e[0], e[1], -0.02], [e[4], e[5], -0.03], [e[10], e[11], -0.07], [e[19], e[20], -0.03]];
const camberAt = (v: number) => banks.find(([a, b]) => v >= a - 30 && v <= b + 30)?.[2] ?? 0;

console.log(`// X ${X.toFixed(0)} m, Y ${Y.toFixed(0)} m, lap ${L.toFixed(0)} m`);
console.log(`points: ${JSON.stringify(pts)}`);
console.log(`heights: ${JSON.stringify(sOf.map((v) => Math.round(heightAt(v) * 10) / 10))}`);
console.log(`camber: ${JSON.stringify(sOf.map(camberAt))}`);
