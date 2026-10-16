import * as THREE from 'three';
import { Sky } from 'three/examples/jsm/objects/Sky.js';
import { createCloudLayer } from './clouds.ts';
import { createSkyDome, type PhotoSkyData } from './photoSky.ts';
import type { QualitySettings } from './quality.ts';

export interface Environment {
  sun: THREE.DirectionalLight;
  /** Direction toward the sun. */
  sunDirection: THREE.Vector3;
  /** Keeps the shadow map centred on the player so it stays sharp where it matters. */
  follow(target: THREE.Vector3): void;
  /** Advances anything that moves on its own, such as the clouds. */
  update(dt: number): void;
  /**
   * `cloud` 0 fair to 1 a full rain deck: overcast sky, a dimmed sun and flat grey light. `rain` 0..1 brings the
   * haze in closer and greyer.
   */
  setWeather(cloud: number, rain: number): void;
  /** Tone-mapping exposure that suits this time of day. */
  exposure: number;
  dispose(): void;
}

const RAIN_HAZE = new THREE.Color(0x868d95);
/** With a photographed sky, its HDR lights everything: the hemisphere fill only lifts the darkest shadows. */
const PHOTO_ENVIRONMENT = 0.8;
const PHOTO_FILL = 0.12;
const RAIN_FILL = new THREE.Color(0xc4c9cf);

export type TimeOfDay = 'midday' | 'afternoon' | 'sunset';

/** The light of one time of day: where the sun is and its colour, the sky's scattering, the haze and the fill. */
interface Lighting {
  elevation: number;
  azimuth: number;
  sun: number;
  sunIntensity: number;
  turbidity: number;
  rayleigh: number;
  mie: number;
  haze: number;
  fillSky: number;
  fillGround: number;
  fill: number;
  exposure: number;
  clouds: { sun: [number, number, number]; shadow: [number, number, number]; haze: [number, number, number] };
}

export const TIMES_OF_DAY: Record<TimeOfDay, Lighting> = {
  // High summer sun: short, crisp shadows and a deep blue sky.
  midday: {
    elevation: 60, azimuth: 200, sun: 0xfff7ee, sunIntensity: 4.5, turbidity: 1.4, rayleigh: 1.0, mie: 0.002,
    haze: 0xb4c9df, fillSky: 0xd4e7ff, fillGround: 0x4a5a32, fill: 0.38, exposure: 0.72,
    clouds: { sun: [1.3, 1.27, 1.22], shadow: [0.62, 0.68, 0.8], haze: [0.84, 0.89, 0.96] },
  },
  // Mid-afternoon: high enough for crisp shadows, low enough to model the cars' shapes.
  afternoon: {
    elevation: 38, azimuth: 215, sun: 0xfff1e0, sunIntensity: 4.2, turbidity: 1.6, rayleigh: 1.2, mie: 0.002,
    haze: 0xa9bfd6, fillSky: 0xcfe3ff, fillGround: 0x4a5a32, fill: 0.35, exposure: 0.75,
    clouds: { sun: [1.28, 1.24, 1.17], shadow: [0.6, 0.66, 0.77], haze: [0.82, 0.87, 0.94] },
  },
  // Golden hour: a low orange sun, long shadows, a warm sky, clouds lit pink from below.
  sunset: {
    elevation: 8, azimuth: 250, sun: 0xffb06a, sunIntensity: 3.8, turbidity: 3.2, rayleigh: 2.6, mie: 0.006,
    haze: 0xd8b49a, fillSky: 0xffcfa8, fillGround: 0x3d3326, fill: 0.32, exposure: 0.86,
    clouds: { sun: [1.55, 0.98, 0.66], shadow: [0.46, 0.42, 0.56], haze: [0.96, 0.78, 0.66] },
  },
};

/**
 * The sky model draws the sun's disc at a brightness near the top of a half-float render target (about 65,000).
 * On the bloom path that overflows to infinity whenever the sun is in view, and the bloom blur spreads it as NaN
 * until the whole frame is black. Clamped far below that, the sun still tone-maps to white and still blooms.
 */
function clampSky(sky: Sky): Sky {
  const material = sky.material as THREE.ShaderMaterial;
  // Under a full rain deck no blue gets through anywhere, down to the horizon: `overcast` greys the whole dome.
  material.uniforms.overcast = { value: 0 };
  material.fragmentShader = material.fragmentShader
    .replace('void main() {', 'uniform float overcast;\nvoid main() {')
    .replace(
      'gl_FragColor = vec4( retColor, 1.0 );',
      'gl_FragColor = vec4( mix( min( retColor, vec3( 2000.0 ) ), vec3( 0.5, 0.52, 0.55 ), overcast ), 1.0 );',
    );
  return sky;
}

/** A photographed sky for the session, and an overcast one to turn to if it rains. */
export interface PhotoSkies {
  sky: PhotoSkyData;
  overcast: PhotoSkyData | null;
}

/** Haze takes the horizon's hue at this brightness, so distant land fades into the sky rather than glowing. */
const HAZE_LUMINANCE = 0.5;

function hazeFrom(horizon: THREE.Color): THREE.Color {
  const l = 0.2126 * horizon.r + 0.7152 * horizon.g + 0.0722 * horizon.b || 1;
  return horizon.clone().multiplyScalar(HAZE_LUMINANCE / l);
}

/**
 * The sky and its light. With photographed skies, the sky is the photograph, the lighting and reflections come from
 * its HDR, and the sun stands where it stood in the photo; without them (still loading, or offline on a first visit)
 * a procedural sky with drifting clouds stands in.
 */
export function createEnvironment(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  q: QualitySettings,
  time: TimeOfDay = 'afternoon',
  photo: PhotoSkies | null = null,
): Environment {
  const light = TIMES_OF_DAY[time];
  const HAZE = photo ? hazeFrom(photo.sky.horizon) : new THREE.Color(light.haze);
  const OVERCAST_HAZE = photo?.overcast ? hazeFrom(photo.overcast.horizon) : RAIN_HAZE;
  const FILL_SKY = photo ? HAZE.clone() : new THREE.Color(light.fillSky);
  const sunDirection = photo
    ? photo.sky.sun.clone()
    : new THREE.Vector3().setFromSphericalCoords(1, THREE.MathUtils.degToRad(90 - light.elevation), THREE.MathUtils.degToRad(light.azimuth));
  const pmrem = new THREE.PMREMGenerator(renderer);
  return photo ? photographed(photo) : procedural();

  function photographed(photo: PhotoSkies): Environment {
    const dome = createSkyDome(photo.sky, photo.overcast, 1 / light.exposure);
    scene.add(dome.mesh);
    const clear = pmrem.fromEquirectangular(photo.sky.radiance);
    const overcastEnv = photo.overcast ? pmrem.fromEquirectangular(photo.overcast.radiance) : null;
    pmrem.dispose();
    scene.environment = clear.texture;
    scene.environmentIntensity = PHOTO_ENVIRONMENT;
    scene.fog = new THREE.Fog(HAZE, q.drawDistance * 0.25, q.drawDistance);
    const { sun, fill, follow } = lights(photo.sky.sunColour, PHOTO_FILL);
    return {
      sun,
      sunDirection,
      follow,
      update() {},
      setWeather(cloud: number, rain: number) {
        const r = Math.min(1, Math.max(0, cloud));
        const wet = Math.min(1, Math.max(0, rain));
        dome.setOvercast(r);
        // The light is the overcast sky's once it is mostly cloud.
        scene.environment = r > 0.5 && overcastEnv ? overcastEnv.texture : clear.texture;
        sun.intensity = light.sunIntensity * (1 - 0.85 * r);
        fill.intensity = PHOTO_FILL * (1 + 0.5 * r);
        const fog = scene.fog as THREE.Fog;
        fog.color.copy(HAZE).lerp(OVERCAST_HAZE, Math.max(r, wet));
        fog.near = q.drawDistance * 0.25 * (1 - 0.7 * wet);
        fog.far = q.drawDistance * (1 - 0.15 * r - 0.45 * wet);
      },
      exposure: light.exposure,
      dispose() {
        clear.dispose();
        overcastEnv?.dispose();
      },
    };
  }

  /** The sun (casting shadows that follow the player) and a soft fill from the sky and the ground. */
  function lights(sunColour: THREE.ColorRepresentation, fillIntensity: number) {
    const sun = new THREE.DirectionalLight(sunColour, light.sunIntensity);
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
    const fill = new THREE.HemisphereLight(FILL_SKY, light.fillGround, fillIntensity);
    scene.add(fill);
    const texel = q.shadows ? 80 / q.shadowMapSize : 1;
    const follow = (target: THREE.Vector3) => {
      // Snap to shadow-map texels so shadow edges don't shimmer as the car moves.
      const x = Math.round(target.x / texel) * texel;
      const z = Math.round(target.z / texel) * texel;
      const y = target.y;
      sun.target.position.set(x, y, z);
      sun.position.set(x + sunDirection.x * 300, y + sunDirection.y * 300, z + sunDirection.z * 300);
    };
    return { sun, fill, follow };
  }

  function procedural(): Environment {
  // Physically based sky (Preetham model).
  const sky = clampSky(new Sky());
  // Inside the camera's far plane (6000 m) at every corner of the sky box.
  sky.scale.setScalar(6000);
  const u = sky.material.uniforms;
  u.turbidity.value = light.turbidity;
  u.rayleigh.value = light.rayleigh;
  u.mieCoefficient.value = light.mie;
  u.mieDirectionalG.value = 0.8;
  u.sunPosition.value.copy(sunDirection);
  scene.add(sky);
  const tint = (c: [number, number, number]) => new THREE.Color(c[0], c[1], c[2]);
  const clouds = createCloudLayer(q, sunDirection, {
    sun: tint(light.clouds.sun),
    shadow: tint(light.clouds.shadow),
    haze: tint(light.clouds.haze),
  });
  scene.add(clouds.mesh);

  // Image-based lighting: render the sky once into a prefiltered environment map, so paint and
  // metal reflect a sky that matches the one on screen.
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
  const { sun, fill, follow } = lights(light.sun, light.fill);

  return {
    sun,
    sunDirection,
    follow,
    update(dt: number) {
      clouds.update(dt);
    },
    setWeather(cloud: number, rain: number) {
      const r = Math.min(1, Math.max(0, cloud));
      const wet = Math.min(1, Math.max(0, rain));
      clouds.setOvercast(r);
      // Wet air scatters every colour alike: the blue goes out of the sky and it turns a bright grey.
      u.turbidity.value = light.turbidity + (10 - light.turbidity) * r;
      u.rayleigh.value = light.rayleigh * (1 - 0.75 * r);
      u.overcast.value = Math.min(1, r * 1.3);
      // Under a rain deck the sun barely gets through and the light comes evenly from the whole sky.
      sun.intensity = light.sunIntensity * (1 - 0.85 * r);
      fill.intensity = light.fill * (1 + 0.5 * r);
      fill.color.copy(FILL_SKY).lerp(RAIN_FILL, r);
      scene.environmentIntensity = 0.55 * (1 - 0.3 * r);
      const fog = scene.fog as THREE.Fog;
      // Cloud alone greys the haze a little; rain fills the air with it.
      fog.color.copy(HAZE).lerp(RAIN_HAZE, Math.max(0.5 * r, wet));
      fog.near = q.drawDistance * 0.25 * (1 - 0.7 * wet);
      fog.far = q.drawDistance * (1 - 0.15 * r - 0.45 * wet);
    },
    exposure: light.exposure,
    dispose() {
      envTarget.dispose();
    },
  };
  }
}
