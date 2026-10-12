import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { RUNOFF_ASPHALT, RUNOFF_GRAVEL, type Track } from '../track/Track.ts';
import type { QualitySettings } from './quality.ts';
import {
  AD_BRANDS,
  adAtlasTexture,
  beltTexture,
  gravelTextures,
  runoffTexture,
  tyreStackTexture,
  wireMeshTexture,
} from './textures.ts';
import { GROUND_Y, ribbon } from './trackMesh.ts';

/** The gravel and run-off reach to just short of the tyre wall in front of the barrier. */
const TYRE_WALL_INSET = 0.55;
const RUNOFF_END_INSET = 0.95;
const TYRE_RADIUS = 0.31;
const TYRE_SPACING = 0.64;
const FENCE_HEIGHT = 2.9;
const BARRIER_HEIGHT = 1.1;

export interface Trackside {
  group: THREE.Group;
  /** Lights `count` (0-5) columns of the start gantry. */
  setStartLights(count: number): void;
}

/**
 * Everything between the kerb and the spectators: gravel traps and painted run-off, tyre walls with their belts,
 * catch fencing, sponsor boards, marshal posts, and the start-light gantry over the grid.
 */
export function buildTrackside(track: Track, q: QualitySettings): Trackside {
  const group = new THREE.Group();
  group.name = 'trackside';
  group.add(runoff(track, q));
  if (q.tier !== 'low') group.add(tyreWalls(track, q));
  group.add(belts(track));
  if (q.tier !== 'low') group.add(fencing(track, q));
  group.add(adBoards(track, q));
  group.add(marshalPosts(track, q));
  const gantry = startGantry(track, q);
  group.add(gantry.group);
  return { group, setStartLights: gantry.setLit };
}

const sideOf = (track: Track, side: number) => ({
  runoff: side > 0 ? track.runoffRight : track.runoffLeft,
  barrier: side > 0 ? track.barrierRight : track.barrierLeft,
  kerb: side > 0 ? track.kerbRight : track.kerbLeft,
});

/** Where run-off starts: just beyond the kerb, or the track edge where there is no kerb. */
const runoffStart = (track: Track, kerb: Uint8Array, i: number) =>
  track.halfWidth + (kerb[i] ? track.kerbWidth : 0.15);

function runoff(track: Track, q: QualitySettings): THREE.Group {
  const group = new THREE.Group();
  const gravel = gravelTextures(Math.min(512, q.textureSize), q.anisotropy);
  // The ribbon's u spans the run-off once; repeat it so stones stay roughly square across 15-30 m.
  for (const t of [gravel.map, gravel.normalMap]) t.repeat.set(4, 1);
  const gravelMat = new THREE.MeshStandardMaterial({
    map: gravel.map,
    normalMap: gravel.normalMap,
    normalScale: new THREE.Vector2(0.8, 0.8),
    roughness: 0.97,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -1,
  });
  const runoffMat = new THREE.MeshStandardMaterial({
    map: runoffTexture(Math.min(512, q.textureSize), q.anisotropy),
    roughness: 0.9,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -1,
  });
  for (const side of [-1, 1]) {
    const s = sideOf(track, side);
    for (const [kind, mat, repeat, y] of [
      [RUNOFF_GRAVEL, gravelMat, 6, -0.025],
      [RUNOFF_ASPHALT, runoffMat, 10, -0.012],
    ] as const) {
      const mesh = new THREE.Mesh(
        ribbon(track, {
          from: (i) => side * runoffStart(track, s.kerb, i),
          to: (i) => side * (s.barrier[i] - RUNOFF_END_INSET),
          yFrom: () => y,
          yTo: () => y,
          repeatLength: repeat,
          include: (i) => s.runoff[i] === kind,
        }),
        mat,
      );
      mesh.receiveShadow = true;
      group.add(mesh);
    }
  }
  return group;
}

/** Stacks of three tyres in front of the barrier wherever there is run-off: the corners cars can reach. */
function tyreWalls(track: Track, q: QualitySettings): THREE.InstancedMesh {
  const spots: THREE.Vector3[] = [];
  for (const side of [-1, 1]) {
    const s = sideOf(track, side);
    for (let d = 0; d < track.length; d += TYRE_SPACING) {
      const i = Math.floor(d / track.spacing) % track.count;
      if (s.runoff[i] === 0) continue;
      const p = track.pointAt(d, side * (s.barrier[i] - TYRE_WALL_INSET));
      spots.push(new THREE.Vector3(p.x, p.y + GROUND_Y, p.z));
    }
  }
  const geo = new THREE.CylinderGeometry(TYRE_RADIUS, TYRE_RADIUS, 0.72, 10, 1, true);
  geo.translate(0, 0.36, 0);
  const tex = tyreStackTexture();
  tex.repeat.set(3, 1);
  const mesh = new THREE.InstancedMesh(geo, new THREE.MeshStandardMaterial({ map: tex, roughness: 0.85, side: THREE.DoubleSide }), spots.length);
  const m = new THREE.Matrix4();
  spots.forEach((p, k) => mesh.setMatrixAt(k, m.makeTranslation(p.x, p.y, p.z)));
  mesh.castShadow = q.shadows;
  mesh.receiveShadow = true;
  return mesh;
}

/**
 * A vertical strip following the track at a lateral offset, built only where `include` holds at both ends of a
 * segment. u runs along the track in units of `repeatLength`, v from bottom to top.
 */
function strip(
  track: Track,
  offset: (i: number) => number,
  y0: number,
  y1: number,
  repeatLength: number,
  include: (i: number) => boolean = () => true,
): THREE.BufferGeometry {
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  let n = 0;
  for (let k = 0; k < track.count; k++) {
    const i = k;
    const j = track.wrap(k + 1);
    if (!include(i) || !include(j)) continue;
    const corners = [i, j].map((m) => {
      const d = offset(m);
      return [track.xs[m] - track.tz[m] * d, track.zs[m] + track.tx[m] * d];
    });
    const u0 = (k * track.spacing) / repeatLength;
    const u1 = ((k + 1) * track.spacing) / repeatLength;
    // y0 and y1 are relative to the ground beside the track at each end.
    const g0 = track.surfaceY(i, offset(i));
    const g1 = track.surfaceY(j, offset(j));
    positions.push(corners[0][0], g0 + y0, corners[0][1], corners[0][0], g0 + y1, corners[0][1]);
    positions.push(corners[1][0], g1 + y0, corners[1][1], corners[1][0], g1 + y1, corners[1][1]);
    uvs.push(u0, 0, u0, 1, u1, 0, u1, 1);
    indices.push(n, n + 2, n + 1, n + 1, n + 2, n + 3);
    n += 4;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}

/** The conveyor belt strapped across the front of each tyre wall, which stops a car burrowing into the tyres. */
function belts(track: Track): THREE.Group {
  const group = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({ map: beltTexture(), roughness: 0.7, side: THREE.DoubleSide });
  for (const side of [-1, 1]) {
    const s = sideOf(track, side);
    const mesh = new THREE.Mesh(
      strip(track, (i) => side * (s.barrier[i] - TYRE_WALL_INSET - TYRE_RADIUS - 0.03), GROUND_Y, 0.78, 4, (i) => s.runoff[i] !== 0),
      mat,
    );
    mesh.receiveShadow = true;
    group.add(mesh);
  }
  return group;
}

/** Catch fencing on top of every barrier: alpha-tested wire mesh on steel posts. */
function fencing(track: Track, q: QualitySettings): THREE.Group {
  const group = new THREE.Group();
  const wire = wireMeshTexture();
  // One diamond is about 0.25 m across.
  wire.repeat.set(1, FENCE_HEIGHT / 0.25);
  // Soft transparency rather than alpha testing: at a distance the mesh averages into the grey haze a real catch
  // fence makes, where an alpha-tested one would vanish.
  const mesh = new THREE.MeshStandardMaterial({
    map: wire,
    transparent: true,
    depthWrite: false,
    alphaTest: 0.02,
    metalness: 0.6,
    roughness: 0.45,
    side: THREE.DoubleSide,
  });
  const postGeo = new THREE.BoxGeometry(0.09, FENCE_HEIGHT + 0.2, 0.09);
  postGeo.translate(0, BARRIER_HEIGHT + (FENCE_HEIGHT + 0.2) / 2, 0);
  const postSpots: THREE.Vector3[] = [];
  for (const side of [-1, 1]) {
    const s = sideOf(track, side);
    group.add(new THREE.Mesh(strip(track, (i) => side * (s.barrier[i] + 0.05), BARRIER_HEIGHT, BARRIER_HEIGHT + FENCE_HEIGHT, 0.25), mesh));
    if (q.tier === 'medium') continue;
    for (let d = 0; d < track.length; d += 4) {
      const i = Math.floor(d / track.spacing) % track.count;
      const p = track.pointAt(d, side * (s.barrier[i] + 0.12));
      postSpots.push(new THREE.Vector3(p.x, p.y, p.z));
    }
  }
  if (postSpots.length > 0) {
    const posts = new THREE.InstancedMesh(postGeo, new THREE.MeshStandardMaterial({ color: 0x8d9296, metalness: 0.7, roughness: 0.4 }), postSpots.length);
    const m = new THREE.Matrix4();
    postSpots.forEach((p, k) => posts.setMatrixAt(k, m.makeTranslation(p.x, p.y, p.z)));
    posts.castShadow = q.shadows;
    group.add(posts);
  }
  return group;
}

/** Sponsor boards along the straights, on the face of the barrier, all sharing one atlas texture. */
function adBoards(track: Track, q: QualitySettings): THREE.Mesh {
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  const rows = AD_BRANDS.length;
  let brand = 0;
  let n = 0;
  const half = 3;
  for (const side of [-1, 1]) {
    const s = sideOf(track, side);
    for (let d = 20; d < track.length - 20; d += 34) {
      // Only on straight, run-off-free stretches, where boards are seen square on.
      let straight = true;
      for (let e = -16; e <= 16 && straight; e += track.spacing) {
        const i = Math.floor(track.wrapS(d + e) / track.spacing) % track.count;
        if (Math.abs(track.curvature[i]) > 1 / 700 || s.runoff[i] !== 0) straight = false;
      }
      if (!straight) continue;
      const i = Math.floor(d / track.spacing) % track.count;
      const lateral = side * (s.barrier[i] - 0.06);
      const a = track.pointAt(d - half, lateral);
      const b = track.pointAt(d + half, lateral);
      // Text reads left to right for someone on the track looking at the board.
      const [p0, p1] = side < 0 ? [a, b] : [b, a];
      positions.push(p0.x, p0.y + 0.12, p0.z, p1.x, p1.y + 0.12, p1.z, p1.x, p1.y + 1.0, p1.z, p0.x, p0.y + 1.0, p0.z);
      const k = brand++ % rows;
      const v0 = 1 - (k + 1) / rows;
      const v1 = 1 - k / rows;
      uvs.push(0, v0, 1, v0, 1, v1, 0, v1);
      indices.push(n, n + 1, n + 2, n, n + 2, n + 3);
      n += 4;
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ map: adAtlasTexture(q.anisotropy), roughness: 0.55, side: THREE.DoubleSide }));
  mesh.receiveShadow = true;
  return mesh;
}

/** Marshal posts every few hundred metres behind the barrier, each with a marshal in orange. */
function marshalPosts(track: Track, q: QualitySettings): THREE.Group {
  const huts: THREE.BufferGeometry[] = [];
  const roofs: THREE.BufferGeometry[] = [];
  const people: THREE.BufferGeometry[] = [];
  for (let d = 150; d < track.length - 100; d += 420) {
    const i = Math.floor(d / track.spacing) % track.count;
    // Behind the barrier on the side with more room.
    const side = track.barrierLeft[i] > track.barrierRight[i] ? -1 : 1;
    const barrier = side > 0 ? track.barrierRight[i] : track.barrierLeft[i];
    const p = track.pointAt(d, side * (barrier + 3));
    const yaw = -p.heading;
    const place = (g: THREE.BufferGeometry, dx: number, dy: number, dz: number) =>
      g.rotateY(yaw).translate(p.x + Math.cos(p.heading) * dx - Math.sin(p.heading) * dz, p.y + GROUND_Y + dy, p.z + Math.sin(p.heading) * dx + Math.cos(p.heading) * dz);
    huts.push(place(new THREE.BoxGeometry(1.8, 2.3, 1.6), 0, 1.15, 0));
    roofs.push(place(new THREE.BoxGeometry(2.1, 0.18, 1.9), 0, 2.38, 0));
    // The marshal stands beside the hut, toward the track.
    const toTrack = -side * 1.2;
    people.push(place(new THREE.CapsuleGeometry(0.22, 1.0, 4, 8), 1.4, 0.75, toTrack));
    people.push(place(new THREE.SphereGeometry(0.15, 8, 6), 1.4, 1.62, toTrack));
  }
  const group = new THREE.Group();
  const add = (geos: THREE.BufferGeometry[], mat: THREE.Material) => {
    const mesh = new THREE.Mesh(mergeGeometries(geos)!, mat);
    mesh.castShadow = q.shadows;
    mesh.receiveShadow = true;
    group.add(mesh);
  };
  add(huts, new THREE.MeshStandardMaterial({ color: 0xeceef0, roughness: 0.8 }));
  add(roofs, new THREE.MeshStandardMaterial({ color: 0xf47a20, roughness: 0.6 }));
  add(people, new THREE.MeshStandardMaterial({ color: 0xff7a1a, roughness: 0.75 }));
  return group;
}

/** The start-light gantry spanning the track over the line: five columns of two red lamps facing the grid. */
function startGantry(track: Track, q: QualitySettings): { group: THREE.Group; setLit: (count: number) => void } {
  const group = new THREE.Group();
  const p = track.pointAt(0);
  group.position.set(p.x, p.y + GROUND_Y, p.z);
  // Local +x along the track, +z to the right.
  group.rotation.y = -p.heading;
  const steel = new THREE.MeshStandardMaterial({ color: 0x2b2e33, metalness: 0.6, roughness: 0.45 });
  const span = track.halfWidth + 2.5;
  for (const side of [-1, 1]) {
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.45, 7.2, 0.45), steel);
    post.position.set(0, 3.6, side * span);
    group.add(post);
  }
  const beam = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.7, span * 2 + 0.5), steel);
  beam.position.set(0, 6.9, 0);
  group.add(beam);
  const panel = new THREE.Mesh(new THREE.BoxGeometry(0.35, 1.5, 4.2), new THREE.MeshStandardMaterial({ color: 0x0c0c0e, roughness: 0.6 }));
  panel.position.set(0, 5.75, 0);
  group.add(panel);

  const off = new THREE.MeshStandardMaterial({ color: 0x2a0606, roughness: 0.3 });
  const on = new THREE.MeshStandardMaterial({ color: 0xff2020, emissive: 0xff1010, emissiveIntensity: 2.5, roughness: 0.3 });
  const lampGeo = new THREE.CircleGeometry(0.22, 20);
  const columns: THREE.Mesh[][] = [];
  for (let c = 0; c < 5; c++) {
    const column: THREE.Mesh[] = [];
    for (const y of [5.4, 6.1]) {
      const lamp = new THREE.Mesh(lampGeo, off);
      // On the face toward the grid, which sits behind the line (-x).
      lamp.position.set(-0.18, y, (c - 2) * 0.8);
      lamp.rotation.y = -Math.PI / 2;
      group.add(lamp);
      column.push(lamp);
    }
    columns.push(column);
  }
  group.traverse((o) => {
    if (o instanceof THREE.Mesh) o.castShadow = q.shadows;
  });
  return {
    group,
    setLit(count: number) {
      columns.forEach((column, c) => {
        for (const lamp of column) lamp.material = c < count ? on : off;
      });
    },
  };
}
