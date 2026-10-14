import * as THREE from 'three';

interface WetState {
  color: THREE.Color;
  /** How far toward a water film the surface goes when soaked: 1 for sealed surfaces, low for gravel and grass. */
  gloss: number;
  /** Shader uniform: wetness times gloss. */
  wet: { value: number };
}

/** Roughness of a film of water on the surface. */
const FILM_ROUGHNESS = 0.14;

/**
 * Marks materials that change with the weather. Each gets a shader patch: water fills the surface texture, so
 * roughness goes toward that of a water film and the normal map flattens out (multiplying a roughness map down
 * instead would leave a field of glinting specks rather than a sheen).
 */
export function markWettable(gloss: number, ...materials: THREE.MeshStandardMaterial[]): void {
  for (const m of materials) {
    const state: WetState = { color: m.color.clone(), gloss, wet: { value: 0 } };
    m.userData.wet = state;
    const previous = m.onBeforeCompile;
    const previousKey = m.customProgramCacheKey();
    m.onBeforeCompile = (shader, renderer) => {
      previous.call(m, shader, renderer);
      shader.uniforms.wetAmount = state.wet;
      shader.fragmentShader = shader.fragmentShader
        .replace('void main() {', 'uniform float wetAmount;\nvoid main() {')
        .replace(
          '#include <roughnessmap_fragment>',
          `#include <roughnessmap_fragment>
  roughnessFactor = mix(roughnessFactor, ${FILM_ROUGHNESS.toFixed(2)}, wetAmount);`,
        )
        .replace(
          '#include <normal_fragment_maps>',
          `#include <normal_fragment_maps>
  normal = normalize(mix(normal, nonPerturbedNormal, wetAmount * 0.75));`,
        );
    };
    m.customProgramCacheKey = () => `${previousKey}|wet`;
  }
}

/** Every wettable material under a root, collected once so weather changes don't walk the scene each frame. */
export function collectWettable(root: THREE.Object3D): THREE.MeshStandardMaterial[] {
  const found = new Set<THREE.MeshStandardMaterial>();
  root.traverse((o) => {
    if (!(o instanceof THREE.Mesh)) return;
    for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
      if (m instanceof THREE.MeshStandardMaterial && m.userData.wet) found.add(m);
    }
  });
  return [...found];
}

/**
 * Wet surfaces: water darkens them (it fills the texture and absorbs scattered light) and, on sealed surfaces,
 * leaves a film that reflects the sky, which is why a wet track looks dark and shiny.
 */
export function applyWetness(materials: readonly THREE.MeshStandardMaterial[], wetness: number): void {
  const w = Math.min(1, Math.max(0, wetness));
  for (const m of materials) {
    const state = m.userData.wet as WetState;
    state.wet.value = w * state.gloss;
    m.color.copy(state.color).multiplyScalar(1 - 0.4 * w);
  }
}
