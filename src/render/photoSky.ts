import * as THREE from 'three';
import { RGBELoader } from 'three/examples/jsm/loaders/RGBELoader.js';
import { ASSETS } from './photoTextures.ts';
import type { QualitySettings } from './quality.ts';

export type SkyName = 'midday' | 'afternoon' | 'sunset' | 'overcast';

/** A photographed sky: its HDR for lighting and reflections, its photograph for the visible sky, and what was measured from it. */
export interface PhotoSkyData {
  /** Sky radiance, with the sun's disc clamped out: the sun light supplies it, with shadows, so it isn't counted twice. */
  radiance: THREE.DataTexture;
  /** The photograph, for the sky you see. */
  photo: THREE.Texture;
  /** Direction toward the sun. */
  sun: THREE.Vector3;
  /** The sun's colour, brightest channel 1. */
  sunColour: THREE.Color;
  /** The sky just above the horizon, for the haze. */
  horizon: THREE.Color;
}

/** Radiance above this is the sun's disc and its immediate glow, held back from the lighting copy. */
const SUN_CLAMP = 24;

/** Loads one sky: the 2K HDR and 8K photograph on high and ultra, 1K and 4K below. */
export async function loadPhotoSky(name: SkyName, q: QualitySettings): Promise<PhotoSkyData> {
  const hi = q.textureSize >= 1024;
  const [radiance, photo] = await Promise.all([
    new RGBELoader().setDataType(THREE.FloatType).loadAsync(`${ASSETS}sky/${name}_${hi ? '2k' : '1k'}.hdr`),
    new THREE.TextureLoader().loadAsync(`${ASSETS}sky/${name}_${hi ? '8k' : '4k'}.jpg`),
  ]);
  radiance.mapping = THREE.EquirectangularReflectionMapping;
  photo.colorSpace = THREE.SRGBColorSpace;
  photo.wrapS = THREE.RepeatWrapping;
  photo.anisotropy = q.anisotropy;
  return { radiance, photo, ...analyse(radiance) };
}

/**
 * Finds the sun (the luminance-weighted centre of the brightest pixels), its colour and the horizon's colour, and
 * clamps the sun out of the radiance. Directions follow three.js's equirectangular convention: u = atan(z, x) / 2π +
 * 0.5, v = asin(y) / π + 0.5, with the HDR's first row at the top.
 */
function analyse(tex: THREE.DataTexture): Pick<PhotoSkyData, 'sun' | 'sunColour' | 'horizon'> {
  // Loaded as FloatType, so the pixels are RGBA floats.
  const { width: w, height: h, data } = tex.image as unknown as { width: number; height: number; data: Float32Array };
  const lum = (k: number) => 0.2126 * data[k] + 0.7152 * data[k + 1] + 0.0722 * data[k + 2];
  let max = 0;
  for (let k = 0; k < w * h * 4; k += 4) max = Math.max(max, lum(k));
  const dirOf = (row: number, col: number, out: THREE.Vector3) => {
    const phi = ((col + 0.5) / w - 0.5) * Math.PI * 2;
    const theta = (0.5 - (row + 0.5) / h) * Math.PI;
    return out.set(Math.cos(theta) * Math.cos(phi), Math.sin(theta), Math.cos(theta) * Math.sin(phi));
  };
  const sun = new THREE.Vector3();
  const colour = new THREE.Color(0, 0, 0);
  const horizon = new THREE.Color(0, 0, 0);
  const d = new THREE.Vector3();
  let horizonCount = 0;
  for (let row = 0; row < h; row++) {
    const aboveHorizon = row < h / 2 && row > h * 0.44;
    for (let col = 0; col < w; col++) {
      const k = (row * w + col) * 4;
      const l = lum(k);
      if (l > max * 0.25) {
        sun.addScaledVector(dirOf(row, col, d), l);
        colour.r += data[k];
        colour.g += data[k + 1];
        colour.b += data[k + 2];
      }
      if (aboveHorizon && l < SUN_CLAMP) {
        horizon.r += data[k];
        horizon.g += data[k + 1];
        horizon.b += data[k + 2];
        horizonCount++;
      }
      if (l > SUN_CLAMP) {
        const s = SUN_CLAMP / l;
        data[k] *= s;
        data[k + 1] *= s;
        data[k + 2] *= s;
      }
    }
  }
  tex.needsUpdate = true;
  // A sun below the horizon (or a sky with none) still needs to light from above.
  sun.normalize();
  if (sun.y < 0.05) sun.setY(0.05).normalize();
  const peak = Math.max(colour.r, colour.g, colour.b) || 1;
  colour.multiplyScalar(1 / peak);
  horizon.multiplyScalar(1 / Math.max(1, horizonCount));
  return { sun, sunColour: colour, horizon };
}

/**
 * The visible sky: a photograph on a sphere that follows the camera, crossfading to an overcast photograph as cloud
 * comes over. Sampled with explicit gradients so the wrap-around seam behind the camera has no mipmap line.
 */
export function createSkyDome(sky: PhotoSkyData, overcast: PhotoSkyData | null, intensity: number) {
  const material = new THREE.ShaderMaterial({
    uniforms: {
      photo: { value: sky.photo },
      overcastPhoto: { value: overcast?.photo ?? sky.photo },
      overcast: { value: 0 },
      intensity: { value: intensity },
    },
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        vDir = position;
        vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        gl_Position = p.xyww;
      }`,
    fragmentShader: /* glsl */ `
      uniform sampler2D photo;
      uniform sampler2D overcastPhoto;
      uniform float overcast;
      uniform float intensity;
      varying vec3 vDir;
      void main() {
        vec3 d = normalize(vDir);
        vec2 uv = vec2(atan(d.z, d.x) * 0.15915494 + 0.5, asin(clamp(d.y, -1.0, 1.0)) * 0.31830989 + 0.5);
        vec2 dx = dFdx(uv);
        vec2 dy = dFdy(uv);
        dx.x -= floor(dx.x + 0.5);
        dy.x -= floor(dy.x + 0.5);
        vec3 col = textureGrad(photo, uv, dx, dy).rgb;
        if (overcast > 0.0) col = mix(col, textureGrad(overcastPhoto, uv, dx, dy).rgb, overcast);
        gl_FragColor = vec4(col * intensity, 1.0);
      }`,
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
  });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 64, 32), material);
  mesh.scale.setScalar(5000);
  mesh.frustumCulled = false;
  mesh.renderOrder = -100;
  mesh.name = 'sky';
  mesh.onBeforeRender = (_r, _s, camera) => {
    mesh.position.copy(camera.position);
    mesh.updateMatrixWorld();
  };
  return {
    mesh,
    setOvercast(amount: number) {
      material.uniforms.overcast.value = overcast ? amount : 0;
    },
  };
}
