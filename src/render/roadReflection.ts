import * as THREE from 'three';

/**
 * The road as a mirror: each frame the scene is rendered from the camera's reflection in the road under the player's
 * car, at half resolution, and the asphalt blends that image in by its wetness and the viewing angle. In the dry it
 * is a faint gloss that seats the cars on the road; in the wet the cars and the sky stand in the water.
 */

/** Shared with the asphalt's shader, so the track can be built before the reflection exists. */
export const roadReflectionUniforms = {
  reflMap: { value: null as THREE.Texture | null },
  reflMatrix: { value: new THREE.Matrix4() },
  reflStrength: { value: 0 },
};

/** Adds the reflection to a road material, after any shader patches it already has. */
export function addRoadReflection(material: THREE.MeshStandardMaterial): void {
  const previous = material.onBeforeCompile;
  const previousKey = material.customProgramCacheKey();
  material.onBeforeCompile = (shader, renderer) => {
    previous.call(material, shader, renderer);
    Object.assign(shader.uniforms, roadReflectionUniforms);
    shader.vertexShader = shader.vertexShader
      .replace('void main() {', 'uniform mat4 reflMatrix;\nvarying vec4 vReflUv;\nvoid main() {')
      .replace('#include <project_vertex>', '#include <project_vertex>\n  vReflUv = reflMatrix * modelMatrix * vec4(transformed, 1.0);');
    shader.fragmentShader = shader.fragmentShader
      .replace('void main() {', 'uniform sampler2D reflMap;\nuniform float reflStrength;\nvarying vec4 vReflUv;\nvoid main() {')
      .replace(
        '#include <opaque_fragment>',
        `if (reflStrength > 0.0) {
    // Rippled by the surface's own bumps, and stronger the flatter the angle, as on any wet or polished surface.
    vec2 ripple = (normal - nonPerturbedNormal).xy * 0.06;
    vec3 mirrored = texture2D(reflMap, vReflUv.xy / vReflUv.w + ripple).rgb;
    float facing = clamp(dot(normal, normalize(vViewPosition)), 0.0, 1.0);
    float fresnel = 0.04 + 0.96 * pow(1.0 - facing, 5.0);
    outgoingLight = mix(outgoingLight, mirrored, clamp(fresnel * reflStrength, 0.0, 1.0));
  }
  #include <opaque_fragment>`,
      );
  };
  material.customProgramCacheKey = () => `${previousKey}|road-reflection`;
}

export class RoadReflection {
  private readonly target: THREE.WebGLRenderTarget;
  private readonly camera = new THREE.PerspectiveCamera();
  /** Left out of the mirror: the road itself, the land, the trees and effects; the sky, cars and trackside remain. */
  readonly hidden: THREE.Object3D[] = [];
  private readonly scale: number;
  private readonly plane = new THREE.Plane();
  private readonly clip = new THREE.Vector4();
  private readonly q = new THREE.Vector4();
  private readonly view = new THREE.Vector3();
  private readonly target3 = new THREE.Vector3();
  private readonly lookAt = new THREE.Vector3();
  private readonly rotation = new THREE.Matrix4();
  private readonly camPos = new THREE.Vector3();
  private frame = 0;

  constructor(scale: number) {
    this.scale = scale;
    this.target = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType });
    roadReflectionUniforms.reflMap.value = this.target.texture;
  }

  setSize(width: number, height: number): void {
    this.target.setSize(Math.max(1, Math.round(width * this.scale)), Math.max(1, Math.round(height * this.scale)));
  }

  /**
   * Renders the mirror image about the horizontal plane through `point` (the road under the car). A faint reflection
   * (the dry gloss) is refreshed every other frame, where a frame's lag can't be seen, to halve its cost.
   */
  update(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.PerspectiveCamera, point: THREE.Vector3, strength: number): void {
    roadReflectionUniforms.reflStrength.value = strength;
    this.frame++;
    if (strength <= 0 || (strength < 0.3 && this.frame % 2 === 1)) return;
    const normal = THREE.Object3D.DEFAULT_UP;
    this.camPos.setFromMatrixPosition(camera.matrixWorld);
    // The camera's position and its line of sight, reflected in the road (as three.js's Reflector does it).
    this.view.subVectors(point, this.camPos).reflect(normal).negate().add(point);
    this.rotation.extractRotation(camera.matrixWorld);
    this.lookAt.set(0, 0, -1).applyMatrix4(this.rotation).add(this.camPos);
    this.target3.subVectors(point, this.lookAt).reflect(normal).negate().add(point);
    const cam = this.camera;
    cam.position.copy(this.view);
    cam.up.set(0, 1, 0).applyMatrix4(this.rotation).reflect(normal);
    cam.lookAt(this.target3);
    cam.far = camera.far;
    cam.updateMatrixWorld();
    cam.projectionMatrix.copy(camera.projectionMatrix);

    // World position to reflection-texture coordinates.
    roadReflectionUniforms.reflMatrix.value
      .set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1)
      .multiply(cam.projectionMatrix)
      .multiply(cam.matrixWorldInverse);

    // Oblique near plane at the road, so nothing below it is drawn into the mirror (Lengyel's method).
    this.plane.setFromNormalAndCoplanarPoint(normal, point).applyMatrix4(cam.matrixWorldInverse);
    this.clip.set(this.plane.normal.x, this.plane.normal.y, this.plane.normal.z, this.plane.constant);
    const p = cam.projectionMatrix.elements;
    this.q.set((Math.sign(this.clip.x) + p[8]) / p[0], (Math.sign(this.clip.y) + p[9]) / p[5], -1, (1 + p[10]) / p[14]);
    this.clip.multiplyScalar(2 / this.clip.dot(this.q));
    p[2] = this.clip.x;
    p[6] = this.clip.y;
    p[10] = this.clip.z + 1 - 0.003;
    p[14] = this.clip.w;

    const visible = this.hidden.map((o) => o.visible);
    for (const o of this.hidden) o.visible = false;
    const previous = renderer.getRenderTarget();
    const autoShadows = renderer.shadowMap.autoUpdate;
    renderer.shadowMap.autoUpdate = false;
    renderer.setRenderTarget(this.target);
    renderer.clear();
    renderer.render(scene, cam);
    renderer.setRenderTarget(previous);
    renderer.shadowMap.autoUpdate = autoShadows;
    this.hidden.forEach((o, i) => (o.visible = visible[i]));
  }
}
