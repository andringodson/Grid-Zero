import * as THREE from 'three';
import type { QualitySettings } from '../quality.ts';

/** Drops in the box around the camera at full rain, per quality tier. */
const DROPS: Record<QualitySettings['tier'], number> = { low: 1500, medium: 3500, high: 6000, ultra: 9000 };
/** Size of the box of rain that travels with the camera, metres. */
const BOX = new THREE.Vector3(60, 26, 60);
/** Terminal speed of a raindrop, m/s. */
const FALL = 9;
/** A light crosswind that leans the rain over a little, m/s. */
const WIND = new THREE.Vector3(1.2, 0, 0.6);
/** How long the eye (or a camera shutter) integrates a drop, seconds; this is what draws a drop as a streak. */
const SHUTTER = 1 / 20;

const vertexShader = /* glsl */ `
attribute vec4 seed;
uniform float time;
uniform float amount;
uniform vec3 box;
uniform vec3 cameraPos;
uniform vec3 relVel;
uniform float shutter;
varying float vAlpha;
void main() {
  // Each drop falls from a fixed place in a world-space lattice the size of the box; wrapping around the camera
  // keeps the box full of drops wherever it goes, while each drop stays still in the world as the camera passes.
  vec3 p = seed.xyz * box + vec3(${WIND.x.toFixed(2)}, -${FALL.toFixed(2)}, ${WIND.z.toFixed(2)}) * time;
  p = mod(p - cameraPos + box * 0.5, box) - box * 0.5 + cameraPos;
  // Head of the streak at the drop; tail where it was a shutter's length ago, relative to the camera.
  float tail = position.y;
  vec3 streak = relVel * shutter;
  float len = length(streak);
  if (len > 1.8) streak *= 1.8 / len;
  p -= streak * tail;
  float d = distance(p, cameraPos);
  // Only some of the drops when it's light rain; none right in front of the lens or at the edge of the box.
  float on = step(seed.w, amount);
  // A fast drop spreads the same light over a longer streak, so it's fainter.
  float spread = clamp(0.5 / max(len, 1e-3), 0.3, 1.0);
  vAlpha = on * spread * smoothstep(0.6, 3.0, d) * (1.0 - smoothstep(box.x * 0.3, box.x * 0.5, d)) * (1.0 - tail * 0.8);
  gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
}`;

const fragmentShader = /* glsl */ `
uniform vec3 color;
varying float vAlpha;
void main() {
  if (vAlpha < 0.01) discard;
  float a = vAlpha * 0.5;
  gl_FragColor = vec4(color * a, a);
}`;

/** Falling rain: a box of streaks that moves with the camera. One draw call; drops are animated on the GPU. */
export class Rain {
  readonly mesh: THREE.LineSegments;
  private readonly material: THREE.ShaderMaterial;
  private readonly lastCamera = new THREE.Vector3();
  private readonly cameraVel = new THREE.Vector3();
  private readonly step = new THREE.Vector3();
  private time = 0;
  private hasCamera = false;

  constructor(q: QualitySettings) {
    const n = DROPS[q.tier];
    const seeds = new Float32Array(n * 2 * 4);
    const positions = new Float32Array(n * 2 * 3);
    for (let i = 0; i < n; i++) {
      const s = [Math.random(), Math.random(), Math.random(), Math.random()];
      seeds.set(s, i * 8);
      seeds.set(s, i * 8 + 4);
      // position.y marks the end of the segment: 0 head, 1 tail.
      positions[i * 6 + 4] = 1;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('seed', new THREE.BufferAttribute(seeds, 4));
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        time: { value: 0 },
        amount: { value: 0 },
        box: { value: BOX.clone() },
        cameraPos: { value: new THREE.Vector3() },
        relVel: { value: new THREE.Vector3(0, -FALL, 0) },
        shutter: { value: SHUTTER },
        color: { value: new THREE.Color(0.72, 0.76, 0.8) },
      },
      vertexShader,
      fragmentShader,
      transparent: true,
      depthWrite: false,
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
    });
    this.mesh = new THREE.LineSegments(geo, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
    this.mesh.renderOrder = 6;
    this.mesh.name = 'rain';
  }

  /** Advances the rain; `amount` is how hard it is raining (0..1). */
  update(dt: number, amount: number, camera: THREE.Camera): void {
    const u = this.material.uniforms;
    u.amount.value = amount;
    this.mesh.visible = amount > 0.01;
    const pos = camera.getWorldPosition(u.cameraPos.value as THREE.Vector3);
    if (dt > 0) {
      this.time = (this.time + dt) % 1000;
      u.time.value = this.time;
      if (this.hasCamera) {
        // Smoothed so a camera cut doesn't draw one frame of streaks across the whole screen.
        const jump = pos.distanceTo(this.lastCamera);
        if (jump < 10) this.cameraVel.lerp(this.step.subVectors(pos, this.lastCamera).divideScalar(dt), Math.min(1, dt * 12));
      }
      this.lastCamera.copy(pos);
      this.hasCamera = true;
    }
    (u.relVel.value as THREE.Vector3).set(WIND.x - this.cameraVel.x, -FALL - this.cameraVel.y, WIND.z - this.cameraVel.z);
  }
}
