import * as THREE from 'three';

/**
 * Real-time reflections for the cars: a cube camera that rides with the player's car and sees the track, the
 * trackside, the sky and the sun around it, so glossy paint mirrors where the car actually is. One face is rendered
 * per frame, so a full refresh takes six frames (ten times a second at 60 fps) and costs a sixth of a cube a frame;
 * the cube is prefiltered for rough surfaces once per full refresh.
 */
export class ReflectionProbe {
  readonly texture: THREE.CubeTexture;
  private readonly target: THREE.WebGLCubeRenderTarget;
  private readonly cubeCamera: THREE.CubeCamera;
  private face = 0;
  /** Objects hidden while the probe renders: the car it sits inside, and effects that don't belong in a mirror. */
  readonly hidden: THREE.Object3D[] = [];

  constructor(size: number) {
    this.target = new THREE.WebGLCubeRenderTarget(size, { type: THREE.HalfFloatType, generateMipmaps: false });
    this.texture = this.target.texture;
    this.cubeCamera = new THREE.CubeCamera(0.4, 1500, this.target);
  }

  /** Renders the next face from `position`; after the sixth, the reflections update. */
  update(renderer: THREE.WebGLRenderer, scene: THREE.Scene, position: THREE.Vector3): void {
    const cube = this.cubeCamera;
    cube.position.copy(position);
    cube.updateMatrixWorld();
    if (cube.coordinateSystem !== renderer.coordinateSystem) {
      cube.coordinateSystem = renderer.coordinateSystem;
      cube.updateCoordinateSystem();
    }
    const visible = this.hidden.map((o) => o.visible);
    for (const o of this.hidden) o.visible = false;
    const previous = renderer.getRenderTarget();
    // The frame's shadow map is still good: don't redraw it for a reflection.
    const autoShadows = renderer.shadowMap.autoUpdate;
    renderer.shadowMap.autoUpdate = false;
    renderer.setRenderTarget(this.target, this.face);
    renderer.render(scene, cube.children[this.face] as THREE.Camera);
    renderer.setRenderTarget(previous);
    renderer.shadowMap.autoUpdate = autoShadows;
    this.hidden.forEach((o, i) => (o.visible = visible[i]));
    this.face = (this.face + 1) % 6;
    if (this.face === 0) this.texture.needsPMREMUpdate = true;
  }

  dispose(): void {
    this.target.dispose();
  }
}
