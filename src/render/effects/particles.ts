import * as THREE from 'three';
import type { Car } from '../../physics/Car.ts';
import type { QualitySettings } from '../quality.ts';
import { puffTexture } from '../textures.ts';
import { GROUND_Y } from '../trackMesh.ts';
import { type HasCar, tyreScrub, wheelX, wheelZ } from './tyres.ts';

const SMOKE = 0;
const DUST = 1;
const CLUMP = 2;
const SPARK = 3;

interface Budget {
  /** Most particles alive at once. */
  capacity: number;
  /** Scales every emission rate. */
  rate: number;
  sparks: boolean;
  grass: boolean;
}

const BUDGET: Record<QualitySettings['tier'], Budget> = {
  low: { capacity: 40, rate: 0.25, sparks: false, grass: false },
  medium: { capacity: 180, rate: 0.5, sparks: false, grass: true },
  high: { capacity: 520, rate: 1, sparks: true, grass: true },
  ultra: { capacity: 900, rate: 1.4, sparks: true, grass: true },
};

/** Kerb strikes throw sparks off the floor's skid plank only at serious speed. */
const SPARK_SPEED = 45;

const vertexShader = /* glsl */ `
attribute vec3 iPos;
attribute vec4 iData;
attribute vec3 iVel;
varying vec2 vUv;
varying vec2 vCorner;
varying float vAlpha;
varying float vKind;
#include <fog_pars_vertex>
void main() {
  float size = iData.x;
  float kind = iData.z;
  vec4 mvPosition = modelViewMatrix * vec4(iPos, 1.0);
  vec2 corner = position.xy;
  if (kind > 2.5) {
    // Sparks streak along their direction of travel on screen.
    vec3 vv = (modelViewMatrix * vec4(iVel, 0.0)).xyz;
    float speed = length(vv.xy);
    vec2 axis = speed > 1e-3 ? vv.xy / speed : vec2(1.0, 0.0);
    vec2 perp = vec2(-axis.y, axis.x);
    mvPosition.xy += axis * corner.x * (size + speed * 0.03) + perp * corner.y * size * 0.3;
    vCorner = corner;
  } else {
    float c = cos(iData.w);
    float s = sin(iData.w);
    vCorner = mat2(c, s, -s, c) * corner;
    mvPosition.xy += vCorner * size;
  }
  vUv = position.xy + 0.5;
  vAlpha = iData.y;
  vKind = kind;
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}`;

const fragmentShader = /* glsl */ `
uniform sampler2D map;
uniform vec3 sunView;
varying vec2 vUv;
varying vec2 vCorner;
varying float vAlpha;
varying float vKind;
#include <fog_pars_fragment>
void main() {
  if (vKind > 2.5) {
    // Additive: colour with zero alpha adds to whatever is behind under premultiplied blending.
    float core = smoothstep(0.5, 0.0, length(vCorner));
    gl_FragColor = vec4(vec3(1.0, 0.56, 0.2) * 5.0, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
    gl_FragColor = vec4(gl_FragColor.rgb * core * vAlpha, 0.0);
    return;
  }
  float a = texture2D(map, vUv).a;
  vec3 base = vec3(0.86, 0.86, 0.88);
  if (vKind > 1.5) {
    // Clods of turf: small and solid.
    a = smoothstep(0.25, 0.5, a);
    base = vec3(0.1, 0.12, 0.05);
  } else if (vKind > 0.5) {
    base = vec3(0.5, 0.41, 0.29);
  }
  a *= vAlpha;
  if (a < 0.004) discard;
  // Light the puff as if it were a ball, so smoke has a sunny side and a shaded side.
  vec2 q = vCorner * 2.0;
  vec3 n = normalize(vec3(q, sqrt(max(0.0, 1.0 - dot(q, q))) + 0.35));
  float light = 0.5 + 0.62 * max(dot(n, sunView), 0.0);
  vec3 col = base * light;
  #ifdef USE_FOG
    #ifdef FOG_EXP2
      float fogFactor = 1.0 - exp(-fogDensity * fogDensity * vFogDepth * vFogDepth);
    #else
      float fogFactor = smoothstep(fogNear, fogFar, vFogDepth);
    #endif
    col = mix(col, fogColor, fogFactor);
  #endif
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  gl_FragColor = vec4(gl_FragColor.rgb * a, a);
}`;

/**
 * Tyre smoke, grass and dust thrown up by wheels off the track, and sparks from the floor over kerbs. One pool of
 * camera-facing quads drawn in a single call: premultiplied-alpha blending lets soft smoke and additive sparks share
 * the same material. Simulated on the CPU into preallocated arrays, so nothing is allocated per frame.
 */
export class Particles {
  readonly mesh: THREE.Mesh;
  private readonly budget: Budget;
  private readonly cap: number;
  private count = 0;
  private readonly pos: THREE.InstancedBufferAttribute;
  private readonly data: THREE.InstancedBufferAttribute;
  private readonly vel: THREE.InstancedBufferAttribute;
  private readonly geometry: THREE.InstancedBufferGeometry;
  // Simulation state, structure-of-arrays.
  private readonly age: Float32Array;
  private readonly life: Float32Array;
  private readonly size0: Float32Array;
  private readonly growth: Float32Array;
  private readonly alpha0: Float32Array;
  private readonly kind: Uint8Array;
  private readonly spin: Float32Array;
  private readonly sunWorld: THREE.Vector3;

  constructor(q: QualitySettings, sunDirection: THREE.Vector3) {
    this.budget = BUDGET[q.tier];
    const cap = this.budget.capacity;
    this.cap = cap;
    this.sunWorld = sunDirection.clone().normalize();

    const geo = new THREE.InstancedBufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0], 3));
    geo.setIndex([0, 1, 2, 0, 2, 3]);
    const dyn = (n: number) => {
      const a = new THREE.InstancedBufferAttribute(new Float32Array(cap * n), n);
      a.setUsage(THREE.DynamicDrawUsage);
      return a;
    };
    this.pos = dyn(3);
    this.data = dyn(4);
    this.vel = dyn(3);
    geo.setAttribute('iPos', this.pos);
    geo.setAttribute('iData', this.data);
    geo.setAttribute('iVel', this.vel);
    geo.instanceCount = 0;
    this.geometry = geo;

    this.age = new Float32Array(cap);
    this.life = new Float32Array(cap);
    this.size0 = new Float32Array(cap);
    this.growth = new Float32Array(cap);
    this.alpha0 = new Float32Array(cap);
    this.kind = new Uint8Array(cap);
    this.spin = new Float32Array(cap);

    const material = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { map: { value: null }, sunView: { value: new THREE.Vector3() } }]),
      vertexShader,
      fragmentShader,
      transparent: true,
      depthWrite: false,
      fog: true,
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
    });
    material.uniforms.map.value = puffTexture();
    this.mesh = new THREE.Mesh(geo, material);
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
    // After the skid marks and the cars' contact shadows.
    this.mesh.renderOrder = 5;
    this.mesh.name = 'particles';
    const sunView = material.uniforms.sunView.value as THREE.Vector3;
    this.mesh.onBeforeRender = (_r, _s, camera) => {
      sunView.copy(this.sunWorld).transformDirection(camera.matrixWorldInverse);
    };
  }

  /** Emits from every car, then moves, grows and fades the live particles. */
  update(dt: number, cars: readonly HasCar[]): void {
    if (dt <= 0) return;
    for (const { car } of cars) this.emit(car, dt);
    this.simulate(dt);
  }

  private emit(car: Car, dt: number): void {
    const b = this.budget;
    const speed = car.speed;
    const c = Math.cos(car.yaw);
    const s = Math.sin(car.yaw);
    const vx = car.u * c - car.v * s;
    const vz = car.u * s + car.v * c;
    let kerb = 0;
    for (let w = 0; w < 4; w++) {
      const surface = car.wheelSurface[w];
      const x = wheelX(car, w);
      const z = wheelZ(car, w);
      if (surface === 'kerb') kerb = w % 2 === 0 ? -1 : 1;
      if (surface === 'grass' || surface === 'gravel') {
        if (!b.grass || speed < 5) continue;
        const k = Math.min(1, speed / 40);
        // Gravel throws a cloud of stone dust; grass throws clods of turf.
        const gravel = surface === 'gravel';
        this.spawnMany((gravel ? 45 : 18) * k * b.rate * dt, DUST, x, z, vx, vz);
        this.spawnMany((gravel ? 6 : 30) * k * b.rate * dt, CLUMP, x, z, vx, vz);
        continue;
      }
      const scrub = tyreScrub(car, w);
      // Wheelspin smokes even at walking pace; lockups and slides need some speed to heat the rubber.
      const spinning = w >= 2 && car.wheelSpin > 0.15;
      if (scrub < 0.3 || (speed < 4 && !spinning)) continue;
      this.spawnMany(40 * (scrub - 0.2) * b.rate * dt, SMOKE, x, z, vx, vz, scrub);
    }
    if (b.sparks && kerb !== 0 && car.u > SPARK_SPEED) {
      // From the plank under the floor, on the side that's riding the kerb.
      const n = this.count;
      this.spawnMany(40 * b.rate * dt, SPARK, car.x, car.z, vx, vz);
      for (let i = n; i < this.count; i++) {
        const f = (Math.random() - 0.5) * 2.4;
        const r = kerb * 0.3 + (Math.random() - 0.5) * 0.4;
        this.pos.setXYZ(i, car.x + c * f - s * r, 0.04, car.z + s * f + c * r);
      }
    }
  }

  /** Spawns a fractional number of particles: the remainder is spawned with that probability. */
  private spawnMany(amount: number, kind: number, x: number, z: number, vx: number, vz: number, strength = 1): void {
    let n = Math.floor(amount);
    if (Math.random() < amount - n) n++;
    for (let k = 0; k < n; k++) this.spawn(kind, x, z, vx, vz, strength);
  }

  private spawn(kind: number, x: number, z: number, vx: number, vz: number, strength: number): void {
    if (this.count >= this.cap) return;
    const i = this.count++;
    const r = Math.random;
    const spread = (m: number) => (r() - 0.5) * m;
    this.kind[i] = kind;
    this.age[i] = 0;
    this.spin[i] = spread(1.2);
    let y = 0.15;
    let ux = 0;
    let uy = 0;
    let uz = 0;
    if (kind === SMOKE) {
      // Smoke leaves the tyre with a little of the car's speed and is quickly left behind by it.
      ux = vx * 0.3 + spread(2);
      uz = vz * 0.3 + spread(2);
      uy = 0.4 + r() * 0.6;
      y = 0.3;
      this.life[i] = 1.6 + r() * 1.2;
      this.size0[i] = 0.7 + r() * 0.4;
      this.growth[i] = 1.6 + r() * 0.9;
      this.alpha0[i] = 0.25 + 0.3 * strength;
    } else if (kind === DUST) {
      ux = vx * 0.35 + spread(3);
      uz = vz * 0.35 + spread(3);
      uy = 0.8 + r() * 1.4;
      y = 0.25;
      this.life[i] = 0.9 + r() * 0.6;
      this.size0[i] = 0.4 + r() * 0.3;
      this.growth[i] = 1.3 + r() * 0.6;
      this.alpha0[i] = 0.3;
    } else if (kind === CLUMP) {
      ux = vx * 0.5 + spread(4);
      uz = vz * 0.5 + spread(4);
      uy = 2 + r() * 3;
      y = 0.1;
      this.life[i] = 0.6 + r() * 0.5;
      this.size0[i] = 0.07 + r() * 0.09;
      this.growth[i] = 0;
      this.alpha0[i] = 1;
      this.spin[i] = spread(12);
    } else {
      ux = vx * 0.85 + spread(4);
      uz = vz * 0.85 + spread(4);
      uy = 0.8 + r() * 2.5;
      y = 0.04;
      this.life[i] = 0.25 + r() * 0.3;
      this.size0[i] = 0.035;
      this.growth[i] = 0;
      this.alpha0[i] = 1;
    }
    this.pos.setXYZ(i, x, y, z);
    this.vel.setXYZ(i, ux, uy, uz);
    this.data.setXYZW(i, this.size0[i], 0, kind, r() * Math.PI * 2);
  }

  private simulate(dt: number): void {
    const p = this.pos.array as Float32Array;
    const v = this.vel.array as Float32Array;
    const d = this.data.array as Float32Array;
    let i = 0;
    while (i < this.count) {
      const age = (this.age[i] += dt);
      const life = this.life[i];
      if (age >= life) {
        this.kill(i);
        continue;
      }
      const kind = this.kind[i];
      const t = age / life;
      const o = i * 3;
      if (kind === SMOKE || kind === DUST) {
        // Air drag stops the puff; warm smoke keeps rising, dust settles.
        const drag = Math.exp(-dt * (kind === SMOKE ? 1.8 : 2.4));
        v[o] *= drag;
        v[o + 2] *= drag;
        v[o + 1] = v[o + 1] * drag + (kind === SMOKE ? 0.35 : -0.2) * dt;
      } else {
        v[o + 1] -= 9.81 * dt;
      }
      p[o] += v[o] * dt;
      p[o + 1] += v[o + 1] * dt;
      p[o + 2] += v[o + 2] * dt;
      const size = this.size0[i] + this.growth[i] * age;
      // Keep billboards out of the road: a puff's lower edge would otherwise cut a hard line across the asphalt.
      const floor = kind === SMOKE || kind === DUST ? size * 0.35 : kind === CLUMP ? GROUND_Y + size * 0.5 : 0.02;
      if (p[o + 1] < floor) {
        p[o + 1] = floor;
        if (kind === CLUMP || kind === SPARK) {
          v[o] *= 0.4;
          v[o + 2] *= 0.4;
          v[o + 1] = kind === SPARK ? -v[o + 1] * 0.3 : 0;
        }
      }
      // Quick fade in, long fade out.
      const fade = Math.min(1, t * 10) * (1 - t) * (1 - t);
      const q = i * 4;
      d[q] = size;
      d[q + 1] = this.alpha0[i] * (kind === CLUMP || kind === SPARK ? Math.min(1, (1 - t) * 3) : fade);
      d[q + 3] += this.spin[i] * dt;
      i++;
    }
    this.geometry.instanceCount = this.count;
    this.mesh.visible = this.count > 0;
    if (this.count > 0) {
      this.markLive(this.pos);
      this.markLive(this.vel);
      this.markLive(this.data);
    }
  }

  /** Uploads only the packed live particles. */
  private markLive(attr: THREE.InstancedBufferAttribute): void {
    attr.clearUpdateRanges();
    attr.addUpdateRange(0, this.count * attr.itemSize);
    attr.needsUpdate = true;
  }

  /** Swaps the last live particle into slot `i`, keeping the live ones packed at the front. */
  private kill(i: number): void {
    const last = --this.count;
    if (i === last) return;
    this.age[i] = this.age[last];
    this.life[i] = this.life[last];
    this.size0[i] = this.size0[last];
    this.growth[i] = this.growth[last];
    this.alpha0[i] = this.alpha0[last];
    this.kind[i] = this.kind[last];
    this.spin[i] = this.spin[last];
    this.pos.copyAt(i, this.pos, last);
    this.vel.copyAt(i, this.vel, last);
    this.data.copyAt(i, this.data, last);
  }
}
