import * as THREE from 'three';
import { DecalGeometry } from 'three/examples/jsm/geometries/DecalGeometry.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Car } from '../physics/Car.ts';
import type { Livery } from '../game/teams.ts';
import { AD_BRANDS, carbonWeaveTexture, raceNumberTexture, sidewallTexture, sponsorAtlas } from './textures.ts';

/**
 * Procedural open-wheel car. Local axes: +x forward, +y up, +z right; the origin is the centre of gravity on the
 * ground, matching the physics model so wheels sit exactly where the simulation puts them.
 */

interface Section {
  x: number;
  y: number;
  /** Full width (z) and height (y) of the cross-section. */
  w: number;
  h: number;
  z?: number;
}

/** Superellipse exponent: higher is boxier. 2.6 reads as a modern carbon body. */
const SQUARENESS = 2.6;
const RING = 24;

/** Smooth body through a series of rounded-rectangle cross-sections, capped at both ends. */
function loft(sections: Section[]): THREE.BufferGeometry {
  const positions: number[] = [];
  const indices: number[] = [];
  const e = 2 / SQUARENESS;
  for (const s of sections) {
    for (let k = 0; k < RING; k++) {
      const t = (k / RING) * Math.PI * 2;
      const c = Math.cos(t);
      const sn = Math.sin(t);
      positions.push(s.x, s.y + (s.h / 2) * Math.sign(sn) * Math.abs(sn) ** e, (s.z ?? 0) + (s.w / 2) * Math.sign(c) * Math.abs(c) ** e);
    }
  }
  for (let i = 0; i < sections.length - 1; i++) {
    for (let k = 0; k < RING; k++) {
      const a = i * RING + k;
      const b = i * RING + ((k + 1) % RING);
      const c = a + RING;
      const d = b + RING;
      // Sections run nose to tail (decreasing x); this winding makes the faces point outward.
      indices.push(a, b, c, b, d, c);
    }
  }
  // End caps as fans around a centre vertex, facing forward at the nose and backward at the tail.
  const capStart = positions.length / 3;
  const first = sections[0];
  positions.push(first.x, first.y, first.z ?? 0);
  for (let k = 0; k < RING; k++) indices.push(capStart, (k + 1) % RING, k);
  const capEnd = positions.length / 3;
  const last = sections[sections.length - 1];
  const base = (sections.length - 1) * RING;
  positions.push(last.x, last.y, last.z ?? 0);
  for (let k = 0; k < RING; k++) indices.push(capEnd, base + k, base + ((k + 1) % RING));

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}

function box(w: number, h: number, d: number, x: number, y: number, z: number, mat: THREE.Material, rx = 0, rz = 0): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  m.position.set(x, y, z);
  m.rotation.set(rx, 0, rz);
  return m;
}

/**
 * A wing element: a cambered NACA-style aerofoil, inverted for downforce, extruded across the car. The leading
 * edge sits at the origin with the chord running backward (-x); `angle` lifts the trailing edge.
 */
function wing(chord: number, span: number, thickness: number, camber: number, angle: number): THREE.BufferGeometry {
  const n = 14;
  const upper: [number, number][] = [];
  const lower: [number, number][] = [];
  const p = 0.4;
  for (let i = 0; i <= n; i++) {
    // Cosine spacing packs points around the rounded leading edge.
    const x = (1 - Math.cos((i / n) * Math.PI)) / 2;
    const t = 5 * thickness * (0.2969 * Math.sqrt(x) - 0.126 * x - 0.3516 * x * x + 0.2843 * x ** 3 - 0.1015 * x ** 4);
    const yc = x < p ? (camber / (p * p)) * (2 * p * x - x * x) : (camber / ((1 - p) * (1 - p))) * (1 - 2 * p + 2 * p * x - x * x);
    // Inverted: the camber bows downward, so the wing pushes the car onto the road.
    upper.push([x, -yc + t]);
    lower.push([x, -yc - t]);
  }
  const shape = new THREE.Shape();
  shape.moveTo(-upper[n][0] * chord, upper[n][1] * chord);
  for (let i = n - 1; i >= 0; i--) shape.lineTo(-upper[i][0] * chord, upper[i][1] * chord);
  for (let i = 1; i <= n; i++) shape.lineTo(-lower[i][0] * chord, lower[i][1] * chord);
  const geo = new THREE.ExtrudeGeometry(shape, { depth: span, bevelEnabled: false, curveSegments: 1 });
  geo.translate(0, 0, -span / 2);
  geo.rotateZ(-angle);
  return geo;
}

/** A flat plate from an outline in the car's side view (x forward, y up), `thickness` across. */
function endplate(outline: [number, number][], thickness = 0.02): THREE.BufferGeometry {
  const shape = new THREE.Shape();
  shape.moveTo(outline[0][0], outline[0][1]);
  for (let i = 1; i < outline.length; i++) shape.lineTo(outline[i][0], outline[i][1]);
  shape.closePath();
  const geo = new THREE.ExtrudeGeometry(shape, { depth: thickness, bevelEnabled: false });
  geo.translate(0, 0, -thickness / 2);
  return geo;
}

/** A thin rod between two points: suspension arms, wing pylons. */
function rod(a: THREE.Vector3, b: THREE.Vector3, radius: number, mat: THREE.Material): THREE.Mesh {
  const dir = b.clone().sub(a);
  const geo = new THREE.CylinderGeometry(radius, radius, dir.length(), 6);
  const m = new THREE.Mesh(geo, mat);
  m.position.copy(a).add(b).multiplyScalar(0.5);
  m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
  return m;
}

/**
 * Collapses a group's direct child meshes into one mesh per material. A car is built from ~80 parts; drawing them
 * separately would cost ~80 draw calls per car, which a phone can't afford with a full grid on screen.
 */
function mergeByMaterial(group: THREE.Group): void {
  const buckets = new Map<THREE.Material, THREE.BufferGeometry[]>();
  const keep: THREE.Object3D[] = [];
  for (const child of [...group.children]) {
    if (!(child instanceof THREE.Mesh) || Array.isArray(child.material)) {
      keep.push(child);
      continue;
    }
    child.updateMatrix();
    let geo = child.geometry.clone().applyMatrix4(child.matrix);
    if (geo.index) geo = geo.toNonIndexed();
    // Only position and normal are needed: the car's materials are untextured.
    for (const name of Object.keys(geo.attributes)) if (name !== 'position' && name !== 'normal') geo.deleteAttribute(name);
    const list = buckets.get(child.material) ?? [];
    list.push(geo);
    buckets.set(child.material, list);
    group.remove(child);
  }
  for (const [mat, geos] of buckets) {
    const merged = mergeGeometries(geos);
    if (merged) group.add(new THREE.Mesh(merged, mat));
  }
  for (const k of keep) group.add(k);
}

/** One weave texture shared by every car. */
let sharedWeave: THREE.Texture | null = null;
function carbonWeave(): THREE.Texture {
  sharedWeave ??= carbonWeaveTexture();
  sharedWeave.wrapS = sharedWeave.wrapT = THREE.RepeatWrapping;
  return sharedWeave;
}

function contactShadowTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const ctx = c.getContext('2d')!;
  const g = ctx.createRadialGradient(64, 64, 8, 64, 64, 64);
  g.addColorStop(0, 'rgba(0,0,0,0.6)');
  g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(c);
}

/**
 * Carbon-fibre twill on a material, projected from the body's own coordinates on three axes and blended by the
 * surface normal. Merged car parts have no texture coordinates, so a triplanar projection is what lets every
 * part share the weave at the same scale.
 */
function applyCarbonWeave(material: THREE.MeshPhysicalMaterial, weave: THREE.Texture): void {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.weaveMap = { value: weave };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        varying vec3 vObjPos;
        varying vec3 vObjNormal;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        vObjPos = position;
        vObjNormal = normal;`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform sampler2D weaveMap;
        varying vec3 vObjPos;
        varying vec3 vObjNormal;`)
      .replace(
        '#include <map_fragment>',
        `#include <map_fragment>
        vec3 bw = pow(abs(normalize(vObjNormal)), vec3(4.0));
        bw /= bw.x + bw.y + bw.z;
        vec3 wp = vObjPos * 18.0;
        float weave = texture2D(weaveMap, wp.yz).r * bw.x + texture2D(weaveMap, wp.xz).r * bw.y + texture2D(weaveMap, wp.xy).r * bw.z;
        diffuseColor.rgb *= mix(0.45, 1.6, weave);`,
      );
  };
  // Shares one compiled program across every car's carbon.
  material.customProgramCacheKey = () => 'carbon-weave';
}

export interface CarVisual {
  root: THREE.Group;
  /** Built with a broken front wing. */
  wingBroken?: boolean;
  /** Places the model on the car; `dt` (game seconds since the last update) drives brake heat and the DRS flap. */
  update(car: Car, dt?: number): void;
}

/**
 * Sponsors on the bodywork, projected onto it so the lettering follows the curves: on the sidepods, the engine cover,
 * the top of the nose and the rear-wing endplates. Three brands per team, picked from its colours; white lettering on
 * dark paint, near-black on light. One mesh for all of them.
 */
function sponsorDecals(livery: Livery, mono: THREE.Mesh, pods: THREE.Mesh[], plates: THREE.Mesh[], a: number, rwX: number): THREE.Mesh {
  const r = (livery.primary >> 16) & 255;
  const g = (livery.primary >> 8) & 255;
  const b = livery.primary & 255;
  const light = 0.299 * r + 0.587 * g + 0.114 * b > 150;
  const rows = AD_BRANDS.length;
  const brand = (k: number) => ((livery.primary >> 4) + k * 3) % rows;
  const geos: THREE.BufferGeometry[] = [];
  const project = (target: THREE.Mesh, at: THREE.Vector3, facing: THREE.Euler, w: number, h: number, depth: number, row: number) => {
    target.updateMatrixWorld(true);
    const geo = new DecalGeometry(target, at, facing, new THREE.Vector3(w, h, depth));
    // The decal's v runs 0..1 over its height: squeeze it into the brand's row of the atlas.
    const uv = geo.getAttribute('uv') as THREE.BufferAttribute;
    for (let k = 0; k < uv.count; k++) uv.setY(k, 1 - (row + 1 - uv.getY(k)) / rows);
    geos.push(geo);
  };
  for (const side of [-1, 1]) {
    // Facing outward from each side, so the lettering reads front to back on both.
    const out = new THREE.Euler(0, side > 0 ? 0 : Math.PI, 0);
    project(pods[side > 0 ? 1 : 0], new THREE.Vector3(-0.05, 0.36, side * 0.8), out, 0.8, 0.15, 0.3, brand(0));
    project(mono, new THREE.Vector3(-1.3, 0.62, side * 0.22), out, 0.42, 0.085, 0.2, brand(1));
    // The endplate is 2 cm thick: a shallow box takes its outer face only, not the inside.
    project(plates[side > 0 ? 1 : 0], new THREE.Vector3(rwX, 0.74, side * 0.52), out, 0.5, 0.16, 0.03, brand(2));
  }
  project(mono, new THREE.Vector3(a - 0.1, 0.56, 0), new THREE.Euler(-Math.PI / 2, 0, 0), 0.42, 0.09, 0.3, brand(1));
  const material = new THREE.MeshStandardMaterial({
    map: sponsorAtlas(light),
    transparent: true,
    depthWrite: false,
    roughness: 0.25,
    polygonOffset: true,
    polygonOffsetFactor: -4,
    polygonOffsetUnits: -4,
  });
  const mesh = new THREE.Mesh(mergeGeometries(geos)!, material);
  mesh.name = 'sponsors';
  return mesh;
}

/** Front wing damage beyond this shows on the model: the wing bent down on one side, its endplate gone. */
export const BROKEN_WING = 0.25;

/**
 * `reflections`, when given, is what the car's glossy surfaces mirror (a live cube of its surroundings); otherwise they
 * reflect the scene's sky.
 */
export function buildCarModel(
  car: Car,
  livery: Livery,
  castShadows: boolean,
  wingBroken = false,
  reflections: THREE.Texture | null = null,
): CarVisual {
  const root = new THREE.Group();
  root.name = 'car';
  const body = new THREE.Group();
  root.add(body);

  // Metallic paint under a deep, smooth clear coat: the coat mirrors the world and the sun, the metal flake gives the
  // colour its sheen.
  const paint = new THREE.MeshPhysicalMaterial({
    color: livery.primary,
    roughness: 0.22,
    metalness: 0.3,
    clearcoat: 1,
    clearcoatRoughness: 0.02,
    // Racing-game paint mirrors more than a real car's does: that's the look.
    envMapIntensity: 1.35,
  });
  const accent = new THREE.MeshPhysicalMaterial({
    color: livery.accent,
    roughness: 0.22,
    metalness: 0.3,
    clearcoat: 1,
    clearcoatRoughness: 0.03,
    envMapIntensity: 1.35,
  });
  const carbon = new THREE.MeshPhysicalMaterial({
    color: 0x16181b,
    roughness: 0.35,
    metalness: 0.3,
    clearcoat: 1,
    clearcoatRoughness: 0.08,
    envMapIntensity: 1.4,
  });
  applyCarbonWeave(carbon, carbonWeave());
  const black = new THREE.MeshStandardMaterial({ color: 0x050607, roughness: 0.5 });
  const titanium = new THREE.MeshStandardMaterial({ color: 0x8a8f96, roughness: 0.3, metalness: 1 });

  const spec = car.spec;
  const a = spec.cgToFront;
  const b = spec.wheelbase - a;
  const wheelZ = spec.trackWidth / 2 + 0.03;
  const R = spec.wheelRadius;

  // Monocoque, nose and engine cover as one smooth body.
  const mono = new THREE.Mesh(
    loft([
      { x: a + 1.07, y: 0.3, w: 0.16, h: 0.1 },
      { x: a + 0.72, y: 0.33, w: 0.26, h: 0.18 },
      { x: a + 0.22, y: 0.38, w: 0.36, h: 0.26 },
      { x: a - 0.38, y: 0.43, w: 0.5, h: 0.36 },
      { x: a - 0.98, y: 0.47, w: 0.62, h: 0.44 },
      { x: 0.45, y: 0.5, w: 0.74, h: 0.5 },
      { x: -0.1, y: 0.5, w: 0.8, h: 0.5 },
      { x: -0.55, y: 0.62, w: 0.62, h: 0.74 },
      { x: -0.9, y: 0.66, w: 0.42, h: 0.8 },
      { x: -1.4, y: 0.54, w: 0.42, h: 0.6 },
      { x: -2.0, y: 0.42, w: 0.3, h: 0.36 },
      { x: -b - 0.83, y: 0.36, w: 0.18, h: 0.2 },
    ]),
    paint,
  );
  body.add(mono);
  const pods: THREE.Mesh[] = [];
  const plates: THREE.Mesh[] = [];

  // Accent stripe along the nose.
  const noseTip = new THREE.Mesh(
    loft([
      { x: a + 1.08, y: 0.3, w: 0.165, h: 0.105 },
      { x: a + 0.72, y: 0.33, w: 0.265, h: 0.185 },
      { x: a + 0.45, y: 0.355, w: 0.31, h: 0.22 },
    ]),
    accent,
  );
  body.add(noseTip);

  // Sidepods, mirrored.
  for (const side of [-1, 1]) {
    const pod = new THREE.Mesh(
      loft([
        { x: 0.55, y: 0.34, w: 0.42, h: 0.36, z: side * 0.56 },
        { x: 0.1, y: 0.34, w: 0.5, h: 0.42, z: side * 0.58 },
        { x: -0.6, y: 0.32, w: 0.46, h: 0.38, z: side * 0.55 },
        { x: -1.3, y: 0.28, w: 0.3, h: 0.26, z: side * 0.45 },
        { x: -1.85, y: 0.24, w: 0.14, h: 0.14, z: side * 0.32 },
      ]),
      paint,
    );
    body.add(pod);
    pods.push(pod);
    // Dark cooling inlet.
    const inlet = box(0.04, 0.3, 0.36, 0.56, 0.35, side * 0.56, black);
    body.add(inlet);
    // Mirror on a stalk.
    body.add(rod(new THREE.Vector3(0.55, 0.6, side * 0.38), new THREE.Vector3(0.5, 0.7, side * 0.5), 0.012, carbon));
    body.add(box(0.06, 0.06, 0.14, 0.5, 0.72, side * 0.52, carbon));
  }

  // Floor: wide in the middle, tapering toward the nose.
  const floorShape = new THREE.Shape();
  floorShape.moveTo(1.5, -0.3);
  floorShape.lineTo(0.9, -0.9);
  floorShape.lineTo(-1.95, -0.85);
  floorShape.lineTo(-2.2, -0.45);
  floorShape.lineTo(-2.2, 0.45);
  floorShape.lineTo(-1.95, 0.85);
  floorShape.lineTo(0.9, 0.9);
  floorShape.lineTo(1.5, 0.3);
  floorShape.closePath();
  const floorGeo = new THREE.ExtrudeGeometry(floorShape, { depth: 0.03, bevelEnabled: false });
  floorGeo.rotateX(Math.PI / 2);
  floorGeo.translate(0, 0.075, 0);
  // The floor is raw, matte carbon; a clear coat here catches the sky at grazing angles and reads as grey.
  body.add(new THREE.Mesh(floorGeo, new THREE.MeshStandardMaterial({ color: 0x101113, roughness: 0.7, metalness: 0.2 })));

  // Cockpit opening, driver's helmet and the halo.
  const cockpit = new THREE.Mesh(new THREE.SphereGeometry(1, 20, 10), black);
  cockpit.scale.set(0.45, 0.06, 0.26);
  cockpit.position.set(0.05, 0.75, 0);
  body.add(cockpit);
  const helmet = new THREE.Mesh(new THREE.SphereGeometry(0.13, 20, 14), accent);
  helmet.position.set(-0.05, 0.82, 0);
  body.add(helmet);
  const visor = new THREE.Mesh(
    new THREE.SphereGeometry(0.132, 20, 8, -Math.PI / 2.6, Math.PI / 1.3, Math.PI / 2.9, Math.PI / 6),
    new THREE.MeshPhysicalMaterial({ color: 0x0a0d12, roughness: 0.05, metalness: 0.6, clearcoat: 1 }),
  );
  visor.position.copy(helmet.position);
  visor.rotation.y = Math.PI / 2;
  body.add(visor);
  const haloCurve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(-0.32, 0.74, -0.3),
    new THREE.Vector3(0.05, 0.9, -0.33),
    new THREE.Vector3(0.42, 0.93, 0),
    new THREE.Vector3(0.05, 0.9, 0.33),
    new THREE.Vector3(-0.32, 0.74, 0.3),
  ]);
  body.add(new THREE.Mesh(new THREE.TubeGeometry(haloCurve, 40, 0.032, 8, false), carbon));
  body.add(rod(new THREE.Vector3(0.42, 0.93, 0), new THREE.Vector3(0.6, 0.72, 0), 0.03, carbon));

  // Front wing: three cambered elements stepping up and back, shaped endplates, pylons to the nose.
  const fwX = a + 0.95;
  // Broken: the elements bent down toward the right, about where the wing meets the nose, nearly touching the ground.
  const bend = (g: THREE.BufferGeometry) => (wingBroken ? g.translate(0, -0.15, 0).rotateX(0.07).translate(0, 0.15, 0) : g);
  body.add(new THREE.Mesh(bend(wing(0.34, 1.92, 0.07, 0.06, -0.04).translate(fwX + 0.19, 0.09, 0)), accent));
  body.add(new THREE.Mesh(bend(wing(0.22, 1.78, 0.08, 0.07, 0.25).translate(fwX - 0.05, 0.135, 0)), carbon));
  body.add(new THREE.Mesh(bend(wing(0.18, 1.62, 0.08, 0.07, 0.45).translate(fwX - 0.21, 0.19, 0)), accent));
  for (const side of [-1, 1]) {
    if (!(wingBroken && side > 0)) body.add(
      new THREE.Mesh(
        endplate([
          [0.2, 0.04],
          [-0.42, 0.04],
          [-0.44, 0.24],
          [-0.3, 0.29],
          [0.12, 0.2],
        ]).translate(fwX, 0, side * 0.965),
        paint,
      ),
    );
    body.add(rod(new THREE.Vector3(fwX - 0.05, 0.11, side * 0.12), new THREE.Vector3(fwX - 0.2, 0.3, side * 0.07), 0.015, carbon));
  }

  // Rear wing: cambered main plane and beam wing between shaped endplates on a swan-neck mount. The upper flap is
  // added later, on its own hinge, so it can open for DRS.
  const rwX = -b - 0.95;
  body.add(new THREE.Mesh(wing(0.32, 0.98, 0.1, 0.07, 0.1).translate(rwX + 0.17, 0.84, 0), carbon));
  body.add(new THREE.Mesh(wing(0.24, 0.86, 0.08, 0.07, 0.15).translate(rwX + 0.21, 0.47, 0), carbon));
  for (const side of [-1, 1]) {
    body.add(
      new THREE.Mesh(
        endplate([
          [0.27, 0.38],
          [-0.25, 0.38],
          [-0.28, 0.98],
          [-0.18, 1.07],
          [0.24, 1.04],
          [0.27, 0.6],
        ]).translate(rwX, 0, side * 0.5),
        paint,
      ),
    );
    plates.push(body.children[body.children.length - 1] as THREE.Mesh);
  }
  body.add(rod(new THREE.Vector3(-2.2, 0.4, 0), new THREE.Vector3(rwX + 0.05, 0.86, 0), 0.025, carbon));

  // Diffuser: the floor sweeps up under the rear, split by vertical strakes.
  const diffuserTilt = -Math.atan2(0.22, 0.5);
  body.add(box(0.546, 0.015, 1.0, -2.2, 0.19, 0, carbon, 0, diffuserTilt));
  for (const z of [-0.42, -0.21, 0, 0.21, 0.42]) body.add(box(0.5, 0.11, 0.012, -2.2, 0.24, z, carbon, 0, diffuserTilt));

  // Engine-cover fin from the airbox back to the rear wing.
  body.add(
    new THREE.Mesh(
      endplate([
        [-1.0, 1.0],
        [-2.45, 0.97],
        [-2.45, 0.62],
        [-2.0, 0.56],
        [-1.4, 0.8],
      ], 0.012),
      paint,
    ),
  );

  // Rain light.
  body.add(
    box(0.02, 0.06, 0.1, rwX - 0.15, 0.4, 0, new THREE.MeshStandardMaterial({ color: 0x400000, emissive: 0xff1010, emissiveIntensity: 0.6 })),
  );

  // Wheels: a steering pivot (front only) holding a spinning wheel.
  const tyreMat = new THREE.MeshStandardMaterial({ color: 0x141414, roughness: 0.82 });
  const compoundMat = new THREE.MeshStandardMaterial({ color: livery.compound ?? 0xd92020, roughness: 0.6 });
  const pivots: THREE.Group[] = [];
  const spinners: THREE.Group[] = [];
  const positions: [number, number][] = [
    [a, -wheelZ],
    [a, wheelZ],
    [-b, -wheelZ],
    [-b, wheelZ],
  ];
  positions.forEach(([wx, wz], w) => {
    const width = w < 2 ? 0.305 : 0.405;
    const pivot = new THREE.Group();
    pivot.position.set(wx, R, wz);
    const spinner = new THREE.Group();
    pivot.add(spinner);

    const tyreGeo = new THREE.CylinderGeometry(R, R, width, 40, 1);
    tyreGeo.rotateX(Math.PI / 2);
    const tyre = new THREE.Mesh(tyreGeo, tyreMat);
    spinner.add(tyre);

    const rimGeo = new THREE.CylinderGeometry(0.23, 0.23, width + 0.01, 24);
    rimGeo.rotateX(Math.PI / 2);
    spinner.add(new THREE.Mesh(rimGeo, titanium));

    // Coloured compound band and a few markings on the outer sidewall so rotation reads at speed.
    const outer = Math.sign(wz);
    const band = new THREE.Mesh(new THREE.RingGeometry(0.27, 0.3, 40), compoundMat);
    band.position.z = outer * (width / 2 + 0.006);
    band.rotation.y = outer > 0 ? 0 : Math.PI;
    spinner.add(band);
    const cover = new THREE.Mesh(new THREE.CircleGeometry(0.2, 24), carbon);
    cover.position.z = outer * (width / 2 + 0.008);
    cover.rotation.y = outer > 0 ? 0 : Math.PI;
    spinner.add(cover);

    root.add(pivot);
    pivots.push(pivot);
    spinners.push(spinner);

    // Wishbones from the chassis to the hub.
    const hub = new THREE.Vector3(wx, R, wz - outer * (width / 2 - 0.02));
    for (const [dx, dy] of [
      [0.25, 0.08],
      [-0.25, 0.08],
      [0.25, -0.1],
      [-0.25, -0.1],
    ]) {
      const inboard = new THREE.Vector3(wx + dx, R + dy + (w < 2 ? 0.05 : 0), outer * (w < 2 ? 0.2 : 0.28));
      body.add(rod(inboard, hub.clone().setY(R + dy * 0.6), 0.016, carbon));
    }
  });

  // Soft contact shadow so the car sits on the road even with shadows off.
  const shadow = new THREE.Mesh(
    new THREE.PlaneGeometry(6.4, 2.6),
    new THREE.MeshBasicMaterial({ map: contactShadowTexture(), transparent: true, depthWrite: false }),
  );
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.y = 0.01;
  shadow.renderOrder = 1;
  root.add(shadow);

  // Projected before merging, while the body's parts are separate; added after, since merging drops texture coordinates.
  const sponsors = sponsorDecals(livery, mono, pods, plates, a, rwX);
  mergeByMaterial(body);
  for (const spinner of spinners) mergeByMaterial(spinner);
  body.add(sponsors);

  // Parts added after merging keep their texture coordinates or move on their own.
  const decal = (map: THREE.Texture) =>
    new THREE.MeshStandardMaterial({ map, transparent: true, depthWrite: false, roughness: 0.35, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 });

  // Race number on top of the nose (reading forward) and on each side of the engine cover.
  const numberMat = decal(raceNumberTexture(livery.number ?? 1));
  const noseNumber = new THREE.PlaneGeometry(0.2, 0.2).rotateZ(-Math.PI / 2).rotateX(-Math.PI / 2);
  const nose = new THREE.Mesh(noseNumber, numberMat);
  nose.position.set(a + 0.5, 0.472, 0);
  nose.rotation.z = -0.17;
  body.add(nose);
  for (const side of [-1, 1]) {
    const n = new THREE.Mesh(new THREE.PlaneGeometry(0.26, 0.26), numberMat);
    n.position.set(-0.95, 0.72, side * 0.222);
    // Each side reads front to back for someone looking at it.
    n.rotation.y = side > 0 ? 0 : Math.PI;
    body.add(n);
  }

  // DRS: the upper rear-wing flap hinges at its leading edge and swings flat when the system opens.
  const flapPivot = new THREE.Group();
  flapPivot.position.set(rwX - 0.13, 0.95, 0);
  flapPivot.add(new THREE.Mesh(wing(0.22, 0.98, 0.08, 0.07, 0), accent));
  body.add(flapPivot);
  // Rotation about the hinge: negative lifts the trailing edge (a steep flap); near zero is open.
  const FLAP_CLOSED = -0.75;
  const FLAP_OPEN = -0.12;
  flapPivot.rotation.z = FLAP_CLOSED;

  // Brakes: a glowing ring between the wheel cover and the rim edge, front and rear heated separately.
  const glowFront = new THREE.MeshStandardMaterial({ color: 0x1a1210, emissive: 0xff3a08, emissiveIntensity: 0, roughness: 0.4, metalness: 0.6 });
  const glowRear = glowFront.clone();
  const lettering = decal(sidewallTexture(0.355, 0.33));
  spinners.forEach((spinner, w) => {
    const [, wz] = positions[w];
    const outer = Math.sign(wz);
    const width = w < 2 ? 0.305 : 0.405;
    const face = outer * (width / 2 + 0.009);
    const letters = new THREE.Mesh(new THREE.RingGeometry(0.3, 0.355, 48), lettering);
    letters.position.z = face;
    letters.rotation.y = outer > 0 ? 0 : Math.PI;
    spinner.add(letters);
    const glow = new THREE.Mesh(new THREE.RingGeometry(0.2, 0.228, 32), w < 2 ? glowFront : glowRear);
    glow.position.z = face;
    glow.rotation.y = outer > 0 ? 0 : Math.PI;
    spinner.add(glow);
  });
  let brakeHeatFront = 0;
  let brakeHeatRear = 0;

  root.traverse((o) => {
    if (o instanceof THREE.Mesh && o !== shadow) {
      o.castShadow = castShadows;
      o.receiveShadow = true;
      if (reflections && o.material instanceof THREE.MeshStandardMaterial) o.material.envMap = reflections;
    }
  });

  let shownCompound: Car['compound'] | null = null;
  return {
    root,
    wingBroken,
    update(c: Car, dt = 0) {
      // The sidewall band shows the compound fitted, which changes at a pit stop.
      if (c.compound !== shownCompound) {
        compoundMat.color.setHex(c.compound.colour);
        shownCompound = c.compound;
      }
      // On the ground under the car, pitched and rolled with the slope. Yaw first, then pitch, then roll.
      root.position.set(c.x, c.y, c.z);
      root.rotation.set(-c.roll, -c.yaw, c.pitch, 'YZX');
      // Body pitches under braking and acceleration and rolls toward the outside of a corner.
      body.rotation.z = THREE.MathUtils.clamp(c.gLong * 0.004, -0.03, 0.02);
      body.rotation.x = THREE.MathUtils.clamp(-c.gLat * 0.003, -0.02, 0.02);
      body.position.y = Math.min(0, -0.004 * Math.abs(c.gLat));
      pivots[0].rotation.y = -c.steerAngle;
      pivots[1].rotation.y = -c.steerAngle;
      for (let w = 0; w < 4; w++) spinners[w].rotation.z = -c.wheelRotation[w];

      // Hard braking from speed heats the discs to glowing; airflow cools them down the next straight.
      const speed = Math.abs(c.u);
      const heat = c.brake * (speed / 80) * 1.6 * dt;
      const cool = (0.25 + speed / 160) * dt;
      brakeHeatFront = THREE.MathUtils.clamp(brakeHeatFront + heat * spec.brakeBiasFront * 2 - brakeHeatFront * cool, 0, 1);
      brakeHeatRear = THREE.MathUtils.clamp(brakeHeatRear + heat * (1 - spec.brakeBiasFront) * 2 - brakeHeatRear * cool, 0, 1);
      glowFront.emissiveIntensity = Math.max(0, (brakeHeatFront - 0.3) / 0.7) * 1.4;
      glowRear.emissiveIntensity = Math.max(0, (brakeHeatRear - 0.3) / 0.7) * 1.4;

      const flapTarget = c.drsOpen ? FLAP_OPEN : FLAP_CLOSED;
      flapPivot.rotation.z += (flapTarget - flapPivot.rotation.z) * Math.min(1, dt * 12);
    },
  };
}
