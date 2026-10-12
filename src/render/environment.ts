import * as THREE from 'three';
import { Sky } from 'three/examples/jsm/objects/Sky.js';
import { createCloudLayer } from './clouds.ts';
import type { QualitySettings } from './quality.ts';

export interface Environment {
  sun: THREE.DirectionalLight;
  /** Direction toward the sun. */
  sunDirection: THREE.Vector3;
  /** Keeps the shadow map centred on the player so it stays sharp where it matters. */
  follow(target: THREE.Vector3): void;
  /** Advances anything that moves on its own, such as the clouds. */
  update(dt: number): void;
  dispose(): void;
}

/** Mid-afternoon sun: high enough for crisp shadows, low enough to model the car's shape. */
const SUN_ELEVATION = 38;
const SUN_AZIMUTH = 215;
const HAZE = new THREE.Color(0xa9bfd6);

/**
 * The sky model draws the sun's disc at a brightness near the top of a half-float render target (about 65,000).
 * On the bloom path that overflows to infinity whenever the sun is in view, and the bloom blur spreads it as NaN
 * until the whole frame is black. Clamped far below that, the sun still tone-maps to white and still blooms.
 */
function clampSky(sky: Sky): Sky {
  const material = sky.material as THREE.ShaderMaterial;
  material.fragmentShader = material.fragmentShader.replace(
    'gl_FragColor = vec4( retColor, 1.0 );',
    'gl_FragColor = vec4( min( retColor, vec3( 2000.0 ) ), 1.0 );',
  );
  return sky;
}

export function createEnvironment(renderer: THREE.WebGLRenderer, scene: THREE.Scene, q: QualitySettings): Environment {
  const sunDirection = new THREE.Vector3().setFromSphericalCoords(
    1,
    THREE.MathUtils.degToRad(90 - SUN_ELEVATION),
    THREE.MathUtils.degToRad(SUN_AZIMUTH),
  );

  // Physically based sky (Preetham model).
  const sky = clampSky(new Sky());
  // Inside the camera's far plane (6000 m) at every corner of the sky box.
  sky.scale.setScalar(6000);
  const u = sky.material.uniforms;
  u.turbidity.value = 1.6;
  u.rayleigh.value = 1.2;
  u.mieCoefficient.value = 0.002;
  u.mieDirectionalG.value = 0.8;
  u.sunPosition.value.copy(sunDirection);
  scene.add(sky);
  const clouds = createCloudLayer(q, sunDirection);
  scene.add(clouds.mesh);

  // Image-based lighting: render the sky once into a prefiltered environment map, so paint and
  // metal reflect a sky that matches the one on screen.
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envScene = new THREE.Scene();
  const envSky = clampSky(new Sky());
  envSky.scale.setScalar(1000);
  envSky.material.uniforms.turbidity.value = u.turbidity.value;
  envSky.material.uniforms.rayleigh.value = u.rayleigh.value;
  envSky.material.uniforms.mieCoefficient.value = u.mieCoefficient.value;
  envSky.material.uniforms.mieDirectionalG.value = u.mieDirectionalG.value;
  envSky.material.uniforms.sunPosition.value.copy(sunDirection);
  envScene.add(envSky);
  // The same clouds, frozen, so bodywork reflects broken cloud rather than a clear sky.
  envScene.add(clouds.makeMesh(900));
  // A green-brown ground disc so reflections below the horizon aren't sky-coloured.
  const groundDisc = new THREE.Mesh(
    new THREE.CircleGeometry(900, 32),
    new THREE.MeshBasicMaterial({ color: 0x3d4a2c, side: THREE.DoubleSide }),
  );
  groundDisc.rotation.x = -Math.PI / 2;
  groundDisc.position.y = -2;
  envScene.add(groundDisc);
  const envTarget = pmrem.fromScene(envScene, 0, 0.1, 2000);
  scene.environment = envTarget.texture;
  scene.environmentIntensity = 0.55;
  pmrem.dispose();

  scene.fog = new THREE.Fog(HAZE, q.drawDistance * 0.25, q.drawDistance);

  const sun = new THREE.DirectionalLight(0xfff1e0, 4.2);
  sun.position.copy(sunDirection).multiplyScalar(300);
  sun.castShadow = q.shadows;
  if (q.shadows) {
    sun.shadow.mapSize.set(q.shadowMapSize, q.shadowMapSize);
    const extent = 40;
    const cam = sun.shadow.camera;
    cam.left = -extent;
    cam.right = extent;
    cam.top = extent;
    cam.bottom = -extent;
    cam.near = 1;
    cam.far = 800;
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.04;
  }
  scene.add(sun);
  scene.add(sun.target);

  const fill = new THREE.HemisphereLight(0xcfe3ff, 0x4a5a32, 0.35);
  scene.add(fill);

  const texel = q.shadows ? 80 / q.shadowMapSize : 1;
  return {
    sun,
    sunDirection,
    follow(target: THREE.Vector3) {
      // Snap to shadow-map texels so shadow edges don't shimmer as the car moves.
      const x = Math.round(target.x / texel) * texel;
      const z = Math.round(target.z / texel) * texel;
      const y = target.y;
      sun.target.position.set(x, y, z);
      sun.position.set(x + sunDirection.x * 300, y + sunDirection.y * 300, z + sunDirection.z * 300);
    },
    update(dt: number) {
      clouds.update(dt);
    },
    dispose() {
      envTarget.dispose();
    },
  };
}
