import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { seededRandom } from '../math.ts';
import type { Track } from '../track/Track.ts';
import type { QualitySettings } from './quality.ts';
import { boardTexture, crowdTexture, foliageTexture } from './textures.ts';
import { GROUND_Y } from './trackMesh.ts';

/** Rotation about Y that points an object's local +x along a track heading. */
const alongTrack = (heading: number) => -heading;

/** `groundAt` gives the terrain height anywhere, for placing things that stand on the land. */
export function buildScenery(track: Track, q: QualitySettings, groundAt: (x: number, z: number) => number): THREE.Group {
  const group = new THREE.Group();
  group.name = 'scenery';
  group.add(grandstands(track, q));
  group.add(brakingBoards(track));
  group.add(trees(track, q, groundAt));
  return group;
}

/** Tiered stands with a roof, along the outside of the main straight. */
function grandstands(track: Track, q: QualitySettings): THREE.Group {
  const group = new THREE.Group();
  const crowd = crowdTexture();
  crowd.repeat.set(6, 1);
  const crowdMat = new THREE.MeshStandardMaterial({ map: crowd, roughness: 0.9 });
  const steelMat = new THREE.MeshStandardMaterial({ color: 0xd8dde2, roughness: 0.45, metalness: 0.6 });
  const roofMat = new THREE.MeshStandardMaterial({ color: 0xeef1f4, roughness: 0.5, metalness: 0.2 });

  const length = 60;
  const tiers = 10;
  const stepDepth = 0.9;
  const stepRise = 0.55;
  const steps: THREE.BufferGeometry[] = [];
  for (let k = 0; k < tiers; k++) {
    const g = new THREE.BoxGeometry(length, stepRise * (k + 1), stepDepth);
    // Steps climb away from the track, which is on the stand's +z side.
    g.translate(0, (stepRise * (k + 1)) / 2, -k * stepDepth);
    steps.push(g);
  }
  const standGeo = mergeGeometries(steps)!;
  const depth = tiers * stepDepth;
  const height = tiers * stepRise;

  const roofGeo = new THREE.BoxGeometry(length + 2, 0.3, depth + 3);
  roofGeo.translate(0, height + 4.2, -depth / 2 + 1);
  const pillarGeo = new THREE.CylinderGeometry(0.18, 0.18, height + 4.2, 8);

  const placements = [80, 150, 220, track.length - 120, track.length - 190];
  for (const s of placements) {
    const i = Math.floor(track.wrapS(s) / track.spacing);
    const lateral = -(track.barrierLeft[i] + 6);
    const p = track.pointAt(s, lateral);
    const stand = new THREE.Group();
    const body = new THREE.Mesh(standGeo, crowdMat);
    body.castShadow = q.shadows;
    body.receiveShadow = true;
    stand.add(body);
    const roof = new THREE.Mesh(roofGeo, roofMat);
    roof.castShadow = q.shadows;
    stand.add(roof);
    for (const px of [-length / 2 + 1, 0, length / 2 - 1]) {
      const pillar = new THREE.Mesh(pillarGeo, steelMat);
      pillar.position.set(px, (height + 4.2) / 2, -depth + 0.5);
      stand.add(pillar);
    }
    stand.position.set(p.x, p.y + GROUND_Y, p.z);
    // Local +z must point at the track (to the right of the stand's +x, which runs with the track).
    stand.rotation.y = alongTrack(p.heading);
    group.add(stand);
  }
  return group;
}

/** 300, 200 and 100 m boards before every corner that follows a long straight. */
function brakingBoards(track: Track): THREE.Group {
  const group = new THREE.Group();
  const postMat = new THREE.MeshStandardMaterial({ color: 0x777b80, roughness: 0.6, metalness: 0.5 });
  const postGeo = new THREE.CylinderGeometry(0.06, 0.06, 1.6, 6);
  const boardGeo = new THREE.PlaneGeometry(1.1, 1.1);
  const mats = new Map<string, THREE.MeshStandardMaterial>();
  const matFor = (label: string) => {
    let m = mats.get(label);
    if (!m) {
      m = new THREE.MeshStandardMaterial({ map: boardTexture(label), roughness: 0.6, side: THREE.DoubleSide });
      mats.set(label, m);
    }
    return m;
  };

  const straightSamples = Math.round(250 / track.spacing);
  for (let i = 0; i < track.count; i++) {
    const k = Math.abs(track.curvature[i]);
    if (k < 1 / 150) continue;
    let straight = true;
    for (let d = 1; d <= straightSamples && straight; d++) {
      if (Math.abs(track.curvature[track.wrap(i - d)]) > 1 / 600) straight = false;
    }
    if (!straight) continue;
    // Boards go on the outside of the corner, where the driver is lined up before turning in.
    const outside = track.curvature[i] > 0 ? -1 : 1;
    for (const d of [100, 200, 300]) {
      const s = i * track.spacing - d;
      const lateral = outside * (track.halfWidth + track.kerbWidth + 3);
      const p = track.pointAt(s, lateral);
      const post = new THREE.Mesh(postGeo, postMat);
      post.position.set(p.x, p.y + GROUND_Y + 0.8, p.z);
      const board = new THREE.Mesh(boardGeo, matFor(String(d)));
      board.position.set(p.x, p.y + GROUND_Y + 1.9, p.z);
      // Face oncoming cars.
      board.rotation.y = Math.atan2(-Math.cos(p.heading), -Math.sin(p.heading));
      board.castShadow = true;
      group.add(post, board);
    }
  }
  return group;
}

/**
 * Pushes each vertex in or out along its direction from the trunk axis by a pseudo-random amount keyed on its
 * position, so coincident vertices on seams move together and the surface never cracks. Breaks up the perfect
 * outline of a primitive into something leafy.
 */
function roughen(geo: THREE.BufferGeometry, amount: number, seed: number): THREE.BufferGeometry {
  const pos = geo.getAttribute('position') as THREE.BufferAttribute;
  const v = new THREE.Vector3();
  for (let k = 0; k < pos.count; k++) {
    v.fromBufferAttribute(pos, k);
    const h = Math.sin(v.x * 12.9898 + v.y * 78.233 + v.z * 37.719 + seed) * 43758.5453;
    const n = (h - Math.floor(h)) * 2 - 1;
    const radial = Math.hypot(v.x, v.z);
    if (radial < 1e-4) continue;
    const scale = 1 + n * amount;
    pos.setXYZ(k, v.x * scale, v.y + n * amount * 0.6, v.z * scale);
  }
  geo.computeVertexNormals();
  return geo;
}

/**
 * Soft shading for a canopy: normals point out from the crown's axis (and, for a conifer, tilt up the cone) instead
 * of following each facet, so a tree shades like a mass of leaves lit from one side, not like a polyhedron.
 */
function foliageNormals(geo: THREE.BufferGeometry, axisY: number, cone: boolean): THREE.BufferGeometry {
  const pos = geo.getAttribute('position') as THREE.BufferAttribute;
  const normals = new Float32Array(pos.count * 3);
  const n = new THREE.Vector3();
  for (let k = 0; k < pos.count; k++) {
    n.set(pos.getX(k), cone ? 0.55 * Math.hypot(pos.getX(k), pos.getZ(k)) : pos.getY(k) - axisY, pos.getZ(k));
    // On the axis (a cone's tip) there is no outward direction: point up rather than normalise zero into NaN.
    if (n.lengthSq() < 1e-8) n.set(0, 1, 0);
    n.normalize();
    normals.set([n.x, n.y, n.z], k * 3);
  }
  geo.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  return geo;
}

/** Trees are grouped into tiles this size, so whole tiles can be culled. */
const TREE_TILE = 400;

/** Instanced conifers and broadleaf trees, kept well clear of the barriers and the paddock. */
function trees(track: Track, q: QualitySettings, groundAt: (x: number, z: number) => number): THREE.Group {
  const group = new THREE.Group();
  const rand = seededRandom(91);

  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (let i = 0; i < track.count; i++) {
    minX = Math.min(minX, track.xs[i]);
    maxX = Math.max(maxX, track.xs[i]);
    minZ = Math.min(minZ, track.zs[i]);
    maxZ = Math.max(maxZ, track.zs[i]);
  }
  const margin = 700;

  type Spot = { x: number; y: number; z: number; scale: number; kind: number };
  const spots: Spot[] = [];
  let attempts = 0;
  while (spots.length < q.trees && attempts < q.trees * 12) {
    attempts++;
    const x = minX - margin + rand() * (maxX - minX + 2 * margin);
    const z = minZ - margin + rand() * (maxZ - minZ + 2 * margin);
    const p = track.project(x, z);
    const beyond = Math.abs(p.lateral) - track.barrierAt(p);
    if (beyond < 14) continue;
    // Woods line the circuit, where drivers see them; the open country beyond is sparser.
    if (beyond > 250 && rand() > 0.2) continue;
    // Keep the main straight open for the stands and pit building.
    const nearStraight = p.s < 520 || p.s > track.length - 420;
    if (nearStraight && Math.abs(p.lateral) < 110) continue;
    // Sunk a little so trunks never float on a slope.
    spots.push({ x, y: groundAt(x, z) - 0.3, z, scale: 0.7 + rand() * 0.7, kind: rand() < 0.55 ? 0 : 1 });
  }

  const trunkGeo = new THREE.CylinderGeometry(0.22, 0.42, 4, 6);
  trunkGeo.translate(0, 2, 0);
  // Conifer: five drooping tiers, each edge broken up into branch tips.
  const pineGeo = roughen(
    mergeGeometries(
      [
        [3.4, 4.2, 4.6],
        [2.9, 4, 6.8],
        [2.3, 3.6, 8.9],
        [1.7, 3.2, 10.8],
        [1.0, 2.8, 12.6],
      ].map(([r, h, y]) => new THREE.ConeGeometry(r, h, 10, 1).translate(0, y, 0)),
    )!,
    0.22,
    7,
  );
  foliageNormals(pineGeo, 0, true);
  // Broadleaf: a canopy of overlapping lobes rather than one ball.
  const broadGeo = roughen(
    mergeGeometries(
      [
        [0, 7.6, 0, 3.3],
        [1.9, 6.6, 0.6, 2.5],
        [-1.6, 6.9, -0.9, 2.6],
        [0.3, 6.4, 2.0, 2.3],
        [-0.4, 9.0, -0.3, 2.4],
      ].map(([x, y, z, r]) => new THREE.IcosahedronGeometry(r, 1).translate(x, y, z)),
    )!,
    0.28,
    11,
  );
  foliageNormals(broadGeo, 7.4, false);

  const trunkMat = new THREE.MeshStandardMaterial({ color: 0x4a3626, roughness: 0.95 });
  // Leaf clusters in light and shade over the canopy. Solid rather than cut out: cut-out leaves thin to bare twigs in
  // the distance, where the texture's mipmaps average the gaps away.
  const foliage = (needles: boolean, repeat: number) => {
    const map = foliageTexture(needles);
    map.repeat.set(repeat, repeat);
    return new THREE.MeshStandardMaterial({ map, roughness: 0.82 });
  };
  const pineLeaves = foliage(true, 5);
  const broadLeaves = foliage(false, 4);

  // The forest is split into tiles, each its own instanced meshes with a bounding sphere, so tiles outside the
  // view (and outside the small shadow area around the car) are skipped instead of drawing every tree twice.
  const tiles = new Map<string, Spot[]>();
  for (const s of spots) {
    const key = `${Math.floor(s.x / TREE_TILE)},${Math.floor(s.z / TREE_TILE)}`;
    const tile = tiles.get(key);
    if (tile) tile.push(s);
    else tiles.set(key, [s]);
  }
  const m = new THREE.Matrix4();
  const quat = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0);
  const position = new THREE.Vector3();
  const scale = new THREE.Vector3();
  const colour = new THREE.Color();
  const instanced = (geo: THREE.BufferGeometry, mat: THREE.Material, list: Spot[], hue: number | null) => {
    const mesh = new THREE.InstancedMesh(geo, mat, list.length);
    list.forEach((s, idx) => {
      quat.setFromAxisAngle(up, rand() * Math.PI * 2);
      const stretch = hue === null ? 1 : 0.9 + rand() * 0.3;
      m.compose(position.set(s.x, s.y, s.z), quat, scale.set(s.scale, s.scale * stretch, s.scale));
      mesh.setMatrixAt(idx, m);
      if (hue !== null) {
        colour.setHSL(hue + (rand() - 0.5) * 0.05, 0.45 + rand() * 0.15, 0.17 + rand() * 0.08);
        mesh.setColorAt(idx, colour);
      }
    });
    mesh.computeBoundingSphere();
    mesh.castShadow = q.shadows;
    mesh.receiveShadow = true;
    group.add(mesh);
  };
  for (const tile of tiles.values()) {
    instanced(trunkGeo, trunkMat, tile, null);
    const pines = tile.filter((s) => s.kind === 0);
    const broads = tile.filter((s) => s.kind === 1);
    if (pines.length) instanced(pineGeo, pineLeaves, pines, 0.33);
    if (broads.length) instanced(broadGeo, broadLeaves, broads, 0.25);
  }
  return group;
}
