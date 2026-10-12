import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { seededRandom } from '../math.ts';
import type { Track } from '../track/Track.ts';
import type { QualitySettings } from './quality.ts';
import { boardTexture, crowdTexture } from './textures.ts';
import { GROUND_Y } from './trackMesh.ts';

/** Rotation about Y that points an object's local +x along a track heading. */
const alongTrack = (heading: number) => -heading;

/** `groundAt` gives the terrain height anywhere, for placing things that stand on the land. */
export function buildScenery(track: Track, q: QualitySettings, groundAt: (x: number, z: number) => number): THREE.Group {
  const group = new THREE.Group();
  group.name = 'scenery';
  group.add(grandstands(track, q));
  group.add(pitBuilding(track, q));
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

/** Pit and paddock building on the inside of the main straight, with a glazed upper floor that reflects the sky. */
function pitBuilding(track: Track, q: QualitySettings): THREE.Group {
  const group = new THREE.Group();
  const s = track.length - 200;
  const i = Math.floor(s / track.spacing);
  const p = track.pointAt(s, track.barrierRight[i] + 14);
  const length = 260;

  const base = new THREE.Mesh(
    new THREE.BoxGeometry(length, 6, 18),
    new THREE.MeshStandardMaterial({ color: 0xe4e6e8, roughness: 0.7 }),
  );
  base.position.y = 3;
  const glass = new THREE.Mesh(
    new THREE.BoxGeometry(length, 5, 16),
    new THREE.MeshStandardMaterial({ color: 0x1b2633, roughness: 0.08, metalness: 0.9 }),
  );
  glass.position.set(0, 8.5, 1);
  const roof = new THREE.Mesh(
    new THREE.BoxGeometry(length + 4, 0.6, 22),
    new THREE.MeshStandardMaterial({ color: 0xf2f4f6, roughness: 0.5 }),
  );
  roof.position.y = 11.3;
  // Dark garage openings facing the track.
  const doors = new THREE.Mesh(
    new THREE.BoxGeometry(length - 10, 4.2, 0.2),
    new THREE.MeshStandardMaterial({ color: 0x15181c, roughness: 0.8 }),
  );
  doors.position.set(0, 2.3, -9.05);
  for (const m of [base, glass, roof, doors]) {
    m.castShadow = q.shadows;
    m.receiveShadow = true;
    group.add(m);
  }
  group.position.set(p.x, p.y + GROUND_Y, p.z);
  // Local -z faces the track, which is on the building's left.
  group.rotation.y = alongTrack(p.heading);
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
  while (spots.length < q.trees && attempts < q.trees * 6) {
    attempts++;
    const x = minX - margin + rand() * (maxX - minX + 2 * margin);
    const z = minZ - margin + rand() * (maxZ - minZ + 2 * margin);
    const p = track.project(x, z);
    if (Math.abs(p.lateral) < track.barrierAt(p) + 14) continue;
    // Keep the main straight open for the stands and pit building.
    const nearStraight = p.s < 520 || p.s > track.length - 420;
    if (nearStraight && Math.abs(p.lateral) < 110) continue;
    // Sunk a little so trunks never float on a slope.
    spots.push({ x, y: groundAt(x, z) - 0.3, z, scale: 0.7 + rand() * 0.7, kind: rand() < 0.55 ? 0 : 1 });
  }

  const trunkGeo = new THREE.CylinderGeometry(0.22, 0.42, 4, 7);
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
      ].map(([r, h, y]) => new THREE.ConeGeometry(r, h, 14, 2).translate(0, y, 0)),
    )!,
    0.22,
    7,
  );
  // Broadleaf: a canopy of overlapping lobes rather than one ball.
  const broadGeo = roughen(
    mergeGeometries(
      [
        [0, 7.6, 0, 3.3],
        [1.9, 6.6, 0.6, 2.5],
        [-1.6, 6.9, -0.9, 2.6],
        [0.3, 6.4, 2.0, 2.3],
        [-0.4, 9.0, -0.3, 2.4],
      ].map(([x, y, z, r]) => new THREE.IcosahedronGeometry(r, 2).translate(x, y, z)),
    )!,
    0.28,
    11,
  );

  const trunkMat = new THREE.MeshStandardMaterial({ color: 0x4a3626, roughness: 0.95 });
  const leafMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.85 });

  const make = (geo: THREE.BufferGeometry, mat: THREE.Material, list: Spot[]) => {
    const mesh = new THREE.InstancedMesh(geo, mat, list.length);
    mesh.castShadow = q.shadows;
    mesh.receiveShadow = true;
    return mesh;
  };
  const pines = spots.filter((s) => s.kind === 0);
  const broads = spots.filter((s) => s.kind === 1);
  const trunks = make(trunkGeo, trunkMat, spots);
  const pineMesh = make(pineGeo, leafMat, pines);
  const broadMesh = make(broadGeo, leafMat, broads);

  const m = new THREE.Matrix4();
  const quat = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0);
  const colour = new THREE.Color();
  spots.forEach((s, idx) => {
    quat.setFromAxisAngle(up, rand() * Math.PI * 2);
    m.compose(new THREE.Vector3(s.x, s.y, s.z), quat, new THREE.Vector3(s.scale, s.scale, s.scale));
    trunks.setMatrixAt(idx, m);
  });
  const place = (mesh: THREE.InstancedMesh, list: Spot[], hue: number) => {
    list.forEach((s, idx) => {
      quat.setFromAxisAngle(up, rand() * Math.PI * 2);
      m.compose(new THREE.Vector3(s.x, s.y, s.z), quat, new THREE.Vector3(s.scale, s.scale * (0.9 + rand() * 0.3), s.scale));
      mesh.setMatrixAt(idx, m);
      colour.setHSL(hue + (rand() - 0.5) * 0.05, 0.45 + rand() * 0.15, 0.17 + rand() * 0.08);
      mesh.setColorAt(idx, colour);
    });
  };
  place(pineMesh, pines, 0.33);
  place(broadMesh, broads, 0.25);
  group.add(trunks, pineMesh, broadMesh);
  return group;
}
