import * as THREE from 'three';
import type { QualitySettings } from './quality.ts';

/** Where the photographic assets are served from (see public/assets/CREDITS.md). */
export const ASSETS = `${import.meta.env.BASE_URL}assets/`;

/**
 * A photographic surface texture from public/assets, at the tier's resolution (2K on high and ultra, 1K below). It
 * starts out as the procedural `fallback` and swaps to the photo when it has loaded, so a surface is never blank,
 * offline or on a slow connection. `colour` maps are sRGB; normal and roughness maps are data.
 */
export function photoTexture(
  q: QualitySettings,
  name: string,
  fallback: THREE.Texture,
  colour: boolean,
  repeat: [number, number],
): THREE.Texture {
  const tex = new THREE.Texture(fallback.image);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = q.anisotropy;
  tex.colorSpace = colour ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  tex.repeat.set(repeat[0], repeat[1]);
  tex.needsUpdate = true;
  const res = q.textureSize >= 1024 ? '2k' : '1k';
  new THREE.ImageLoader().load(`${ASSETS}surface/${name}_${res}.jpg`, (image) => {
    tex.image = image;
    tex.needsUpdate = true;
  });
  return tex;
}
