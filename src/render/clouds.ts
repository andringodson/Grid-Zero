import * as THREE from 'three';
import type { QualitySettings } from './quality.ts';

/** Noise octaves per tier: each one adds finer detail and costs two noise lookups per sky pixel. */
const OCTAVES: Record<QualitySettings['tier'], number> = { low: 3, medium: 4, high: 5, ultra: 6 };

/** Height of the virtual cloud deck above the viewer, in metres: fair-weather cumulus base. */
const CLOUD_HEIGHT = 1600;
/** Wind across the deck, in noise units per second; slow enough to notice only when you look for it. */
const WIND = new THREE.Vector2(0.0042, 0.0017);

const vertexShader = /* glsl */ `
varying vec3 vWorldPosition;
void main() {
  vec4 world = modelMatrix * vec4(position, 1.0);
  vWorldPosition = world.xyz;
  gl_Position = projectionMatrix * viewMatrix * world;
  // On the far plane like the sky: anything in the scene is in front of the clouds.
  gl_Position.z = gl_Position.w;
}`;

const fragmentShader = /* glsl */ `
uniform vec3 sunDirection;
uniform vec2 offset;
uniform float coverage;
uniform float cloudHeight;
/** 0 for fair-weather cumulus, 1 for a dark rain deck. */
uniform float gloom;
uniform vec3 sunTint;
uniform vec3 shadowTint;
uniform vec3 hazeTint;
varying vec3 vWorldPosition;

float hash(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  float a = hash(i);
  float b = hash(i + vec2(1.0, 0.0));
  float c = hash(i + vec2(0.0, 1.0));
  float d = hash(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

// Rotating each octave hides the axis-aligned lattice of value noise.
const mat2 ROT = mat2(1.6, 1.2, -1.2, 1.6);

float fbm(vec2 p, int octaves) {
  float sum = 0.0;
  float amp = 0.5;
  for (int o = 0; o < OCTAVES; o++) {
    if (o >= octaves) break;
    sum += amp * noise(p);
    p = ROT * p + vec2(3.1, 1.7);
    amp *= 0.5;
  }
  return sum;
}

float density(vec2 p, int octaves) {
  // A broad term drifting at a different rate makes the field slowly change shape rather than just slide.
  float n = fbm(p + offset, octaves) + 0.25 * noise(p * 0.35 - offset * 0.6);
  return smoothstep(coverage, coverage + 0.24, n / 1.1);
}

void main() {
  vec3 dir = normalize(vWorldPosition - cameraPosition);
  // Fade out toward the horizon, where the deck is too far away to resolve and the haze takes over.
  float horizon = smoothstep(0.015, 0.22, dir.y);
  if (horizon <= 0.0) discard;

  // Where the view ray meets the cloud deck, in noise units.
  vec2 p = dir.xz * (cloudHeight / max(dir.y, 0.015)) / 1500.0;
  float d = density(p, OCTAVES);
  if (d <= 0.002) discard;

  // Self-shadowing: denser cloud between this point and the sun means less light reaches it.
  vec2 toSun = normalize(sunDirection.xz + 1e-4);
  float dl = density(p + toSun * 0.09, OCTAVES > 3 ? OCTAVES - 2 : OCTAVES);
  float lit = 0.55 + (d - dl) * 1.8;
  // Low in the sky we see the clouds' sides; with the sun behind the viewer those sides are in full sun.
  float mu = dot(dir, sunDirection);
  float side = 1.0 - smoothstep(0.05, 0.55, dir.y);
  lit = clamp(lit + side * (0.5 - 0.5 * mu) * 0.45, 0.0, 1.0);

  vec3 sunCol = sunTint;
  vec3 shadowCol = shadowTint;
  vec3 col = mix(shadowCol, sunCol, lit);
  // Thick cores seen from underneath are darker; thin edges glow.
  col *= mix(1.0, 0.78, smoothstep(0.5, 1.0, d) * (1.0 - side * 0.6));
  // Against the sun, thick cloud is a grey silhouette while thin edges light up with forward-scattered light.
  float fwd = max(mu, 0.0);
  col *= 1.0 - 0.32 * d * smoothstep(0.2, 1.0, fwd);
  col += sunCol * (pow(fwd, 12.0) * 1.2 + pow(fwd, 4.0) * 0.12) * (1.0 - d) * (1.0 - d);
  // Rain cloud: thick, grey and lit from above only, so the sun's glow fades out of it.
  col = mix(col, vec3(0.42, 0.45, 0.5) * (0.75 + 0.35 * lit), gloom);
  // Distant cloud takes on the haze colour.
  col = mix(mix(hazeTint, vec3(0.55, 0.58, 0.62), gloom), col, smoothstep(0.0, 0.3, dir.y));

  gl_FragColor = vec4(col, d * horizon * 0.96);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

export interface CloudLayer {
  /** For the visible sky; it keeps itself centred on whichever camera draws it. */
  mesh: THREE.Mesh;
  /** A second copy sharing the material, for baking into the reflection map; `radius` must sit inside that camera's far plane. */
  makeMesh(radius: number): THREE.Mesh;
  update(dt: number): void;
  /** 0 fair weather to 1 heavy rain: more cloud, darker and greyer. */
  setOvercast(amount: number): void;
}

/**
 * A procedural deck of fair-weather cumulus: fractal value noise projected onto a plane high above the viewer, so
 * clouds shrink toward the horizon with proper perspective. Lit from the sun with a single self-shadowing sample,
 * drawn on the far plane so the scene always sits in front of it, and never fogged.
 */
/** How the clouds are lit: their sunlit side, their shaded side, and the haze they fade into at the horizon. */
export interface CloudTints {
  sun: THREE.Color;
  shadow: THREE.Color;
  haze: THREE.Color;
}

export function createCloudLayer(q: QualitySettings, sunDirection: THREE.Vector3, tints: CloudTints): CloudLayer {
  const material = new THREE.ShaderMaterial({
    name: 'Clouds',
    uniforms: {
      sunDirection: { value: sunDirection.clone().normalize() },
      offset: { value: new THREE.Vector2(17.3, -4.1) },
      coverage: { value: 0.5 },
      cloudHeight: { value: CLOUD_HEIGHT },
      gloom: { value: 0 },
      sunTint: { value: tints.sun },
      shadowTint: { value: tints.shadow },
      hazeTint: { value: tints.haze },
    },
    defines: { OCTAVES: OCTAVES[q.tier] },
    vertexShader,
    fragmentShader,
    transparent: true,
    depthWrite: false,
    side: THREE.BackSide,
    fog: false,
  });
  // Only the upper half of the sphere is ever visible.
  const geometry = new THREE.SphereGeometry(1, 32, 12, 0, Math.PI * 2, 0, Math.PI * 0.55);
  const makeMesh = (radius: number) => {
    const m = new THREE.Mesh(geometry, material);
    m.scale.setScalar(radius);
    m.frustumCulled = false;
    // Before every other transparent surface, so smoke and fencing blend over the clouds and not the reverse.
    m.renderOrder = -10;
    return m;
  };
  const mesh = makeMesh(2500);
  mesh.onBeforeRender = (_r, _s, camera) => {
    mesh.position.copy(camera.position);
    mesh.updateMatrixWorld();
  };
  const offset = material.uniforms.offset.value as THREE.Vector2;
  return {
    mesh,
    makeMesh,
    update(dt: number) {
      offset.x += WIND.x * dt;
      offset.y += WIND.y * dt;
    },
    setOvercast(amount: number) {
      material.uniforms.coverage.value = 0.5 - 0.42 * amount;
      material.uniforms.gloom.value = amount;
    },
  };
}
