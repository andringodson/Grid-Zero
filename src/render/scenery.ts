import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { seededRandom } from '../math.ts';
import type { Track } from '../track/Track.ts';
import type { QualitySettings } from './quality.ts';
import { boardTexture, crowdTexture } from './textures.ts';
import { GROUND_Y } from './trackMesh.ts';

/** Rotation about Y that points an object's local +x along a track heading. */
const alongTrack = (heading: number) => -heading;

export function buildScenery(track: Track, q: QualitySettings): THREE.Group {
  const group = new THREE.Group();
  group.name = 'scenery';
  group.add(grandstands(track, q));
  group.add(pitBuilding(track, q));
  group.add(brakingBoards(track));
  group.add(trees(track, q));
  group.add(hills(track));
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
    stand.position.set(p.x, GROUND_Y, p.z);
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
  group.position.set(p.x, GROUND_Y, p.z);
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
      post.position.set(p.x, GROUND_Y + 0.8, p.z);
      const board = new THREE.Mesh(boardGeo, matFor(String(d)));
      board.position.set(p.x, GROUND_Y + 1.9, p.z);
      // Face oncoming cars.
      board.rotation.y = Math.atan2(-Math.cos(p.heading), -Math.sin(p.heading));
      board.castShadow = true;
      group.add(post, board);
    }
  }
  return group;
}

/** Instanced conifers and broadleaf trees, kept well clear of the barriers and the paddock. */
function trees(track: Track, q: QualitySettings): THREE.Group {
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

  type Spot = { x: number; z: number; scale: number; kind: number };
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
    spots.push({ x, z, scale: 0.7 + rand() * 0.7, kind: rand() < 0.55 ? 0 : 1 });
  }

  const trunkGeo = new THREE.CylinderGeometry(0.25, 0.4, 4, 6);
  trunkGeo.translate(0, 2, 0);
  const pineGeo = mergeGeometries([
    new THREE.ConeGeometry(3.2, 7, 8).translate(0, 6.5, 0),
    new THREE.ConeGeometry(2.5, 6, 8).translate(0, 9.5, 0),
    new THREE.ConeGeometry(1.6, 5, 8).translate(0, 12.5, 0),
  ])!;
  const broadGeo = new THREE.IcosahedronGeometry(4.2, 1);
  broadGeo.scale(1, 0.85, 1);
  broadGeo.translate(0, 7.5, 0);

  const trunkMat = new THREE.MeshStandardMaterial({ color: 0x4a3626, roughness: 0.95 });
  const leafMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9, flatShading: true });

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
    m.compose(new THREE.Vector3(s.x, GROUND_Y, s.z), quat, new THREE.Vector3(s.scale, s.scale, s.scale));
    trunks.setMatrixAt(idx, m);
  });
  const place = (mesh: THREE.InstancedMesh, list: Spot[], hue: number) => {
    list.forEach((s, idx) => {
      quat.setFromAxisAngle(up, rand() * Math.PI * 2);
      m.compose(new THREE.Vector3(s.x, GROUND_Y, s.z), quat, new THREE.Vector3(s.scale, s.scale * (0.9 + rand() * 0.3), s.scale));
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

/** A ring of distant hills, softened by haze, so the horizon isn't a flat edge. */
function hills(track: Track): THREE.Group {
  const group = new THREE.Group();
  const rand = seededRandom(101);
  let cx = 0;
  let cz = 0;
  for (let i = 0; i < track.count; i++) {
    cx += track.xs[i];
    cz += track.zs[i];
  }
  cx /= track.count;
  cz /= track.count;
  const mat = new THREE.MeshStandardMaterial({ color: 0x4f6046, roughness: 1, flatShading: true });
  for (let k = 0; k < 36; k++) {
    const angle = (k / 36) * Math.PI * 2 + rand() * 0.1;
    const dist = 2600 + rand() * 700;
    const radius = 350 + rand() * 450;
    const hill = new THREE.Mesh(new THREE.ConeGeometry(radius, 120 + rand() * 260, 7, 1), mat);
    hill.position.set(cx + Math.cos(angle) * dist, GROUND_Y, cz + Math.sin(angle) * dist);
    hill.rotation.y = rand() * Math.PI;
    group.add(hill);
  }
  return group;
}
