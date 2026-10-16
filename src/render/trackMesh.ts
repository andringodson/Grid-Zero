import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { RacingLine } from '../ai/racingLine.ts';
import { seededRandom } from '../math.ts';
import type { Track } from '../track/Track.ts';
import type { QualitySettings } from './quality.ts';
import { asphaltTextures, barrierTexture, chequerTexture, kerbTexture } from './textures.ts';
import { addRoadReflection } from './roadReflection.ts';
import { markWettable } from './wet.ts';

/** Ground sits slightly below the asphalt so the two never z-fight at a distance. */
export const GROUND_Y = -0.06;

export interface RibbonOptions {
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
  /** Adds a `lateral` attribute holding each vertex's offset from the centreline. */
  lateral?: boolean;
}

/** Builds a strip that follows the centreline, e.g. the asphalt between two lateral offsets. */
export function ribbon(track: Track, o: RibbonOptions): THREE.BufferGeometry {
  const positions: number[] = [];
  const uvs: number[] = [];
  const laterals: number[] = [];
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
    // Heights given are relative to the track surface, which follows the circuit's elevation and camber.
    positions.push(track.xs[i] + rx * a, (o.yFrom?.(i) ?? 0) + track.surfaceY(i, a), track.zs[i] + rz * a);
    positions.push(track.xs[i] + rx * b, (o.yTo?.(i) ?? 0) + track.surfaceY(i, b), track.zs[i] + rz * b);
    const v = (k * track.spacing) / o.repeatLength;
    uvs.push(0, v, 1, v);
    laterals.push(a, b);
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
  if (o.lateral) geo.setAttribute('lateral', new THREE.Float32BufferAttribute(laterals, 1));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}

/** The rubber mask spans this far either side of the centreline, past the asphalt's widest edge. */
const RUBBER_HALF = 7.5;
const RUBBER_COLUMNS = 256;

/**
 * Where tyres have laid rubber down: a mask with one row per track sample and columns across the track. The
 * darkest rubber follows the racing line in two bands, one per side of the car, widest and heaviest where the
 * line brakes hard and through the corners; on the straights, where cars spread out, it is faint.
 */
function rubberTexture(track: Track, line: RacingLine, anisotropy: number): THREE.DataTexture {
  const n = track.count;
  const lookAhead = Math.max(1, Math.round(24 / track.spacing));
  const raw = new Float32Array(n);
  const spread = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const v = line.speed[i];
    const braking = Math.min(1, Math.max(0, v - line.speed[track.wrap(i + lookAhead)]) / 18);
    const cornering = Math.min(1, Math.abs(line.curvature[i]) * 70);
    raw[i] = Math.min(1, 0.22 + braking * 0.7 + cornering * 0.35);
    spread[i] = braking;
  }
  // Smooth along the track so the rubber fades in and out over tens of metres, as it does on a real circuit.
  const radius = Math.round(10 / track.spacing);
  const intensity = new Float32Array(n);
  const width = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let a = 0;
    let b = 0;
    for (let d = -radius; d <= radius; d++) {
      a += raw[track.wrap(i + d)];
      b += spread[track.wrap(i + d)];
    }
    intensity[i] = a / (2 * radius + 1);
    width[i] = b / (2 * radius + 1);
  }

  // Fine streaks run with the direction of travel: a fixed random weight per lateral position relative to the line.
  const rand = seededRandom(61);
  const streaks = new Float32Array(64);
  for (let k = 0; k < streaks.length; k++) streaks[k] = 0.7 + rand() * 0.6;
  // One row per sample, unless that would pass the smallest texture size WebGL 2 guarantees.
  const rows = Math.min(n, 2048);
  const data = new Uint8Array(RUBBER_COLUMNS * rows);
  const g = (x: number, sigma: number) => Math.exp(-(x * x) / (2 * sigma * sigma));
  for (let r = 0; r < rows; r++) {
    const i = Math.floor((r * n) / rows);
    const offset = line.offset[i];
    // Cars brake on slightly different lines, which smears the rubber wider into the braking zones.
    const broad = 1.0 + width[i] * 0.8;
    const tyre = 0.32 + width[i] * 0.2;
    for (let c = 0; c < RUBBER_COLUMNS; c++) {
      const lat = ((c + 0.5) / RUBBER_COLUMNS) * 2 * RUBBER_HALF - RUBBER_HALF - offset;
      const bands = g(lat - 0.8, tyre) + g(lat + 0.8, tyre);
      const streak = streaks[((Math.floor(lat * 12) % 64) + 64) % 64];
      const v = intensity[i] * (0.55 * g(lat, broad) + 0.6 * bands * streak);
      data[r * RUBBER_COLUMNS + c] = Math.min(255, v * 255);
    }
  }
  const tex = new THREE.DataTexture(data, RUBBER_COLUMNS, rows, THREE.RedFormat, THREE.UnsignedByteType);
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  // Seen from the cockpit the mask is squeezed hard along the track; without anisotropy it blurs away.
  tex.anisotropy = anisotropy;
  tex.needsUpdate = true;
  return tex;
}

/** Darkens the asphalt and polishes it a little wherever the rubber mask says tyres have run. */
function addRubber(mat: THREE.MeshStandardMaterial, track: Track, line: RacingLine, repeatLength: number, anisotropy: number): void {
  const rubberMap = rubberTexture(track, line, anisotropy);
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.rubberMap = { value: rubberMap };
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
        attribute float lateral;
        varying vec2 vRubberUv;`,
      )
      .replace(
        '#include <uv_vertex>',
        `#include <uv_vertex>
        vRubberUv = vec2((lateral + ${RUBBER_HALF.toFixed(2)}) / ${(2 * RUBBER_HALF).toFixed(2)}, uv.y * ${(repeatLength / track.length).toFixed(8)});`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        uniform sampler2D rubberMap;
        varying vec2 vRubberUv;`,
      )
      .replace(
        '#include <map_fragment>',
        `#include <map_fragment>
        float rubber = texture2D(rubberMap, vRubberUv).r;
        diffuseColor.rgb *= 1.0 - 0.72 * rubber;`,
      )
      .replace(
        '#include <roughnessmap_fragment>',
        `#include <roughnessmap_fragment>
        roughnessFactor *= 1.0 - 0.16 * rubber;`,
      );
  };
}

export function buildTrackMeshes(track: Track, q: QualitySettings, line?: RacingLine): THREE.Group {
  const group = new THREE.Group();
  group.name = 'track';
  const hw = track.halfWidth;

  // Asphalt.
  const asphalt = asphaltTextures(q.textureSize, q.anisotropy);
  const asphaltMat = new THREE.MeshStandardMaterial({
    map: asphalt.map,
    roughnessMap: asphalt.roughnessMap,
    normalMap: asphalt.normalMap,
    normalScale: new THREE.Vector2(0.4, 0.4),
    // Polished by tyres: a sheen toward the sun, not a matte grey.
    roughness: 0.82,
    metalness: 0,
  });
  // The texture spans the full width once and repeats every 14 m along the track.
  const asphaltRepeat = 14;
  const road = new THREE.Mesh(
    ribbon(track, {
      from: (i) => -edgeOf(track, i, -1),
      to: (i) => edgeOf(track, i, 1),
      repeatLength: asphaltRepeat,
      lateral: true,
    }),
    asphaltMat,
  );
  if (line) addRubber(asphaltMat, track, line, asphaltRepeat, q.anisotropy);
  road.receiveShadow = true;
  group.add(road);

  // White edge lines.
  const lineMat = new THREE.MeshStandardMaterial({
    color: 0xf2f2ee,
    roughness: 0.42,
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
  const kerbMat = new THREE.MeshStandardMaterial({ map: kerbTex, roughness: 0.38 });
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
  const wallMat = new THREE.MeshStandardMaterial({ map: barrierTexture(q.anisotropy), roughness: 0.6, side: THREE.DoubleSide });
  markWettable(1, asphaltMat, lineMat, kerbMat);
  if (q.roadReflection > 0) addRoadReflection(asphaltMat);
  markWettable(0.4, wallMat);
  const capMat = new THREE.MeshStandardMaterial({ color: 0x8c8e90, roughness: 0.9 });
  for (const side of [-1, 1]) {
    const dist = side > 0 ? track.barrierRight : track.barrierLeft;
    // Alongside the pit lane the garages are the barrier.
    const open = (i: number) => side !== track.pit?.side || !track.pitWallAt(i * track.spacing);
    const wallGeo = wallRibbon(track, (i) => side * dist[i], 1.1, 4, open);
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
        include: open,
      }),
      capMat,
    );
    group.add(cap);
  }
  if (track.pit) group.add(pitLane(track, q, asphalt, lineMat, wallMat, capMat));

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
    box.position.set(g.x + Math.cos(g.heading) * 3.4, g.y + 0.003, g.z + Math.sin(g.heading) * 3.4);
    box.receiveShadow = true;
    group.add(box);
  }

  return group;
}

/**
 * The pit lane: the pit road's asphalt, the pit wall with its nose at each end, the line between the fast lane and
 * the boxes, speed-limit lines across the lane, and a painted outline for each team's box.
 */
function pitLane(
  track: Track,
  q: QualitySettings,
  asphalt: ReturnType<typeof asphaltTextures>,
  lineMat: THREE.Material,
  wallMat: THREE.Material,
  capMat: THREE.Material,
): THREE.Group {
  const pit = track.pit!;
  const side = pit.side;
  const group = new THREE.Group();
  group.name = 'pit lane';
  const along = (s: number) => Math.round(track.pitDistance(s) / track.spacing);
  const start = Math.floor(pit.entry / track.spacing);
  const wall = (i: number) => track.pitWallAt(i * track.spacing);

  // No rubbered line here: the pit road gets plain asphalt.
  const roadMat = new THREE.MeshStandardMaterial({
    map: asphalt.map,
    roughnessMap: asphalt.roughnessMap,
    normalMap: asphalt.normalMap,
    normalScale: new THREE.Vector2(0.6, 0.6),
    roughness: 1,
  });
  markWettable(1, roadMat);
  if (q.roadReflection > 0) addRoadReflection(roadMat);
  const road = new THREE.Mesh(
    ribbon(track, {
      from: (i) => side * edgeOf(track, i, side),
      to: (i) => side * Math.max(edgeOf(track, i, side) + 0.01, track.pitOuter(i * track.spacing)),
      yFrom: () => -0.005,
      yTo: () => -0.005,
      repeatLength: 14,
      range: [start, start + along(pit.exit) + 1],
    }),
    roadMat,
  );
  road.receiveShadow = true;
  group.add(road);

  // Fast lane | boxes.
  const divider = pit.wallOuter + (pit.lane - pit.wallOuter) * 2;
  group.add(
    new THREE.Mesh(
      ribbon(track, { from: () => side * (divider - 0.08), to: () => side * (divider + 0.08), yFrom: () => 0.002, yTo: () => 0.002, repeatLength: 10, include: wall }),
      lineMat,
    ),
  );

  // Painted marks, laid flat: speed-limit lines across the lane and an outline round each box.
  const paint = new THREE.MeshStandardMaterial({ color: 0xf2c400, roughness: 0.6, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
  markWettable(1, paint);
  const marks: THREE.BufferGeometry[] = [];
  const mark = (s: number, lateral: number, length: number, width: number) => {
    const p = track.pointAt(s, side * lateral);
    marks.push(new THREE.PlaneGeometry(length, width).rotateX(-Math.PI / 2).rotateY(-p.heading).translate(p.x, p.y + 0.003, p.z));
  };
  const laneWidth = pit.garage - pit.wallOuter;
  for (const s of [pit.wallStart, pit.wallEnd]) mark(s, pit.wallOuter + laneWidth / 2, 0.4, laneWidth);
  for (const b of pit.boxes) {
    mark(b - 3, pit.box, 0.15, 3.4);
    mark(b + 3, pit.box, 0.15, 3.4);
    mark(b, pit.box - 1.7, 6, 0.15);
    mark(b, pit.box + 1.7, 6, 0.15);
  }
  group.add(new THREE.Mesh(mergeGeometries(marks)!, paint));

  // The pit wall: concrete faces on both sides, a cap, and a closed nose at each end.
  for (const lateral of [pit.wallInner, pit.wallOuter]) {
    const face = new THREE.Mesh(wallRibbon(track, () => side * lateral, 1.1, 4, wall), wallMat);
    face.castShadow = q.shadows;
    face.receiveShadow = true;
    group.add(face);
  }
  group.add(
    new THREE.Mesh(
      ribbon(track, { from: () => side * pit.wallInner, to: () => side * pit.wallOuter, yFrom: () => 1.1, yTo: () => 1.1, repeatLength: 4, include: wall }),
      capMat,
    ),
  );
  const thickness = pit.wallOuter - pit.wallInner;
  for (const s of [pit.wallStart, pit.wallEnd]) {
    const p = track.pointAt(s, side * (pit.wallInner + thickness / 2));
    const nose = new THREE.Mesh(new THREE.BoxGeometry(0.3, 1.7, thickness), wallMat);
    nose.position.set(p.x, p.y + 0.25, p.z);
    nose.rotation.y = -p.heading;
    group.add(nose);
  }
  return group;
}

/** Asphalt reaches under the kerbs where they exist, so no grass shows through their slope. */
function edgeOf(track: Track, i: number, side: number): number {
  const kerb = side > 0 ? track.kerbRight[i] : track.kerbLeft[i];
  return track.halfWidth + (kerb ? 0.4 : 0.15);
}

/** Vertical wall at a lateral offset with texture repeating every `repeatLength` metres. */
function wallRibbon(
  track: Track,
  offset: (i: number) => number,
  height: number,
  repeatLength: number,
  include: (i: number) => boolean = () => true,
): THREE.BufferGeometry {
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
    // From below the ground (so no gap shows on a slope) to barrier height above the run-off beside it.
    const base = track.surfaceY(i, d);
    positions.push(x, base - 0.6, z, x, base + height, z);
    const u = (k * track.spacing) / repeatLength;
    uvs.push(u, 0, u, 1);
  }
  for (let k = 0; k < track.count; k++) {
    if (!include(k) || !include(track.wrap(k + 1))) continue;
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
