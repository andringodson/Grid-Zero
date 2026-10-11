import * as THREE from 'three';
import type { Track } from '../track/Track.ts';
import type { QualitySettings } from './quality.ts';
import { asphaltTextures, barrierTexture, chequerTexture, grassTextures, kerbTexture } from './textures.ts';

/** Ground sits slightly below the asphalt so the two never z-fight at a distance. */
export const GROUND_Y = -0.06;

interface RibbonOptions {
  /** Lateral offsets (positive right) of the two edges at sample i. */
  from: (i: number) => number;
  to: (i: number) => number;
  yFrom?: (i: number) => number;
  yTo?: (i: number) => number;
  /** Metres of track per texture repeat along its length. */
  repeatLength: number;
  /** Only build quads between consecutive samples that both pass. */
  include?: (i: number) => boolean;
  /** Restrict to a range of samples (inclusive start, exclusive end); defaults to the whole loop. */
  range?: [number, number];
  vertical?: boolean;
}

/** Builds a strip that follows the centreline, e.g. the asphalt between two lateral offsets. */
function ribbon(track: Track, o: RibbonOptions): THREE.BufferGeometry {
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  const [start, end] = o.range ?? [0, track.count];
  const closed = !o.range;
  const last = closed ? end : end - 1;
  for (let k = start; k <= last; k++) {
    const i = track.wrap(k);
    const rx = -track.tz[i];
    const rz = track.tx[i];
    const a = o.from(i);
    const b = o.to(i);
    positions.push(track.xs[i] + rx * a, o.yFrom?.(i) ?? 0, track.zs[i] + rz * a);
    positions.push(track.xs[i] + rx * b, o.yTo?.(i) ?? 0, track.zs[i] + rz * b);
    const v = (k * track.spacing) / o.repeatLength;
    uvs.push(0, v, 1, v);
  }
  const n = last - start;
  // Faces point up when `from` is left of `to`; flip the winding when the caller gives them the other way round.
  const flip = o.from(track.wrap(start)) > o.to(track.wrap(start));
  for (let k = 0; k < n; k++) {
    const i = track.wrap(start + k);
    if (o.include && !(o.include(i) && o.include(track.wrap(i + 1)))) continue;
    const a = k * 2;
    if (flip) indices.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
    else indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}

export function buildTrackMeshes(track: Track, q: QualitySettings): THREE.Group {
  const group = new THREE.Group();
  group.name = 'track';
  const hw = track.halfWidth;

  // Asphalt.
  const asphalt = asphaltTextures(q.textureSize, q.anisotropy);
  const asphaltMat = new THREE.MeshStandardMaterial({
    map: asphalt.map,
    roughnessMap: asphalt.roughnessMap,
    normalMap: asphalt.normalMap,
    normalScale: new THREE.Vector2(0.6, 0.6),
    roughness: 1,
    metalness: 0,
  });
  // The texture spans the full width once and repeats every 14 m along the track.
  const road = new THREE.Mesh(
    ribbon(track, { from: (i) => -edgeOf(track, i, -1), to: (i) => edgeOf(track, i, 1), repeatLength: 14 }),
    asphaltMat,
  );
  road.receiveShadow = true;
  group.add(road);

  // White edge lines.
  const lineMat = new THREE.MeshStandardMaterial({
    color: 0xf2f2ee,
    roughness: 0.6,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });
  for (const side of [-1, 1]) {
    const line = new THREE.Mesh(
      ribbon(track, {
        from: () => side * (hw - 0.3),
        to: () => side * (hw - 0.05),
        repeatLength: 10,
      }),
      lineMat,
    );
    line.receiveShadow = true;
    group.add(line);
  }

  // Kerbs: raised and sloped from the white line outward.
  const kerbTex = kerbTexture(q.anisotropy);
  const kerbMat = new THREE.MeshStandardMaterial({ map: kerbTex, roughness: 0.55 });
  for (const side of [-1, 1]) {
    const flags = side > 0 ? track.kerbRight : track.kerbLeft;
    const kerb = new THREE.Mesh(
      ribbon(track, {
        from: () => side * hw,
        to: () => side * (hw + track.kerbWidth),
        yFrom: () => 0.012,
        yTo: () => 0.07,
        repeatLength: 2.4,
        include: (i) => flags[i] === 1,
      }),
      kerbMat,
    );
    kerb.receiveShadow = true;
    group.add(kerb);
  }

  // Barriers: 1.1 m concrete walls with a top cap, facing the track.
  const wallMat = new THREE.MeshStandardMaterial({ map: barrierTexture(q.anisotropy), roughness: 0.85, side: THREE.DoubleSide });
  const capMat = new THREE.MeshStandardMaterial({ color: 0x8c8e90, roughness: 0.9 });
  for (const side of [-1, 1]) {
    const dist = side > 0 ? track.barrierRight : track.barrierLeft;
    const wallGeo = wallRibbon(track, (i) => side * dist[i], 1.1, 4);
    const wall = new THREE.Mesh(wallGeo, wallMat);
    wall.castShadow = q.shadows;
    wall.receiveShadow = true;
    group.add(wall);
    const cap = new THREE.Mesh(
      ribbon(track, {
        from: (i) => side * dist[i] - 0.25,
        to: (i) => side * dist[i] + 0.25,
        yFrom: () => 1.1,
        yTo: () => 1.1,
        repeatLength: 4,
      }),
      capMat,
    );
    group.add(cap);
  }

  // Start/finish line: a 2 m chequered strip across the track.
  const startLine = new THREE.Mesh(
    ribbon(track, {
      from: () => -(hw - 0.05),
      to: () => hw - 0.05,
      yFrom: () => 0.003,
      yTo: () => 0.003,
      repeatLength: track.spacing,
      range: [0, 2],
    }),
    new THREE.MeshStandardMaterial({
      map: chequerTexture(),
      roughness: 0.6,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    }),
  );
  startLine.receiveShadow = true;
  group.add(startLine);

  // Grid boxes: a white bar across each slot, just ahead of where the car's front wheels sit.
  const boxGeo = new THREE.PlaneGeometry(0.25, 2.2);
  for (let slot = 0; slot < 20; slot++) {
    const g = track.gridSlot(slot);
    const box = new THREE.Mesh(boxGeo, lineMat);
    // Laid flat, then turned so its long side runs across the track.
    box.rotation.set(-Math.PI / 2, 0, -g.heading);
    // The bar sits just ahead of the car's front wheels, across the slot.
    box.position.set(g.x + Math.cos(g.heading) * 3.4, 0.003, g.z + Math.sin(g.heading) * 3.4);
    box.receiveShadow = true;
    group.add(box);
  }

  // Ground.
  const grass = grassTextures(q.textureSize, q.anisotropy);
  const groundSize = 8000;
  const repeat = groundSize / 40;
  for (const t of [grass.map, grass.normalMap]) t.repeat.set(repeat, repeat);
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(groundSize, groundSize),
    new THREE.MeshStandardMaterial({
      map: grass.map,
      normalMap: grass.normalMap,
      normalScale: new THREE.Vector2(0.5, 0.5),
      roughness: 0.95,
      metalness: 0,
    }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = GROUND_Y;
  ground.receiveShadow = true;
  group.add(ground);

  return group;
}

/** Asphalt reaches under the kerbs where they exist, so no grass shows through their slope. */
function edgeOf(track: Track, i: number, side: number): number {
  const kerb = side > 0 ? track.kerbRight[i] : track.kerbLeft[i];
  return track.halfWidth + (kerb ? 0.4 : 0.15);
}

/** Vertical wall at a lateral offset with texture repeating every `repeatLength` metres. */
function wallRibbon(track: Track, offset: (i: number) => number, height: number, repeatLength: number): THREE.BufferGeometry {
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  for (let k = 0; k <= track.count; k++) {
    const i = track.wrap(k);
    const rx = -track.tz[i];
    const rz = track.tx[i];
    const d = offset(i);
    const x = track.xs[i] + rx * d;
    const z = track.zs[i] + rz * d;
    positions.push(x, GROUND_Y, z, x, height, z);
    const u = (k * track.spacing) / repeatLength;
    uvs.push(u, 0, u, 1);
  }
  for (let k = 0; k < track.count; k++) {
    const a = k * 2;
    indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}
