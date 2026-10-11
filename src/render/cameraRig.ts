import * as THREE from 'three';
import { damp, wrapAngle } from '../math.ts';
import type { Car } from '../physics/Car.ts';

export type CameraMode = 'chase' | 'tcam' | 'cockpit';
export const CAMERA_MODES: readonly CameraMode[] = ['chase', 'tcam', 'cockpit'];

/**
 * Follows the car. The chase camera trails the car's heading with a lag, so a slide shows as the car
 * rotating in frame; field of view widens with speed for a sense of pace.
 */
export class CameraRig {
  readonly camera: THREE.PerspectiveCamera;
  mode: CameraMode = 'chase';
  private yaw = 0;
  private shake = 0;
  private time = 0;
  private readonly pos = new THREE.Vector3();
  private readonly look = new THREE.Vector3();

  constructor(aspect: number) {
    this.camera = new THREE.PerspectiveCamera(62, aspect, 0.3, 6000);
  }

  next(): void {
    this.mode = CAMERA_MODES[(CAMERA_MODES.indexOf(this.mode) + 1) % CAMERA_MODES.length];
  }

  /** Adds a jolt, e.g. from hitting a barrier or a kerb. */
  bump(amount: number): void {
    this.shake = Math.min(1, this.shake + amount);
  }

  snap(car: Car): void {
    this.yaw = car.yaw;
    this.update(car, 1, 0);
  }

  update(car: Car, dt: number, kerbRumble: number): void {
    this.time += dt;
    const speed = Math.abs(car.u);
    const cam = this.camera;

    // The trailing heading follows the direction of travel more than the nose, revealing slides.
    const travel = speed > 3 ? car.yaw + Math.atan2(car.v, Math.abs(car.u)) * 0.5 : car.yaw;
    this.yaw += wrapAngle(travel - this.yaw) * (1 - Math.exp(-dt * 6));

    const fwdX = Math.cos(car.yaw);
    const fwdZ = Math.sin(car.yaw);
    const rightX = -fwdZ;
    const rightZ = fwdX;
    const local = (f: number, up: number, r: number, out: THREE.Vector3) =>
      out.set(car.x + fwdX * f + rightX * r, up, car.z + fwdZ * f + rightZ * r);

    let fov = 62;
    if (this.mode === 'chase') {
      const cx = Math.cos(this.yaw);
      const cz = Math.sin(this.yaw);
      const dist = 6.4 + speed * 0.012;
      this.pos.set(car.x - cx * dist, 1.75 + speed * 0.002, car.z - cz * dist);
      this.look.set(car.x + cx * 3, 0.75, car.z + cz * 3);
      fov = 60 + Math.min(14, speed * 0.14);
    } else if (this.mode === 'tcam') {
      local(-0.55, 1.22, 0, this.pos);
      local(20, 0.7, 0, this.look);
      fov = 64 + Math.min(10, speed * 0.1);
    } else {
      local(-0.02, 0.86, 0, this.pos);
      local(20, 0.55, 0, this.look);
      fov = 72 + Math.min(8, speed * 0.08);
    }

    // Shake: impacts decay quickly, kerbs and high speed add a fine buzz.
    this.shake = damp(this.shake, 0, 0.25, dt);
    const buzz = this.shake * 0.12 + kerbRumble * 0.02 + Math.max(0, speed - 60) * 0.00015;
    if (buzz > 0) {
      this.pos.x += Math.sin(this.time * 71) * buzz;
      this.pos.y += Math.sin(this.time * 89 + 1.3) * buzz;
      this.pos.z += Math.sin(this.time * 97 + 2.1) * buzz;
    }

    cam.position.copy(this.pos);
    cam.lookAt(this.look);
    cam.fov = damp(cam.fov, fov, 0.3, dt);
    cam.updateProjectionMatrix();
  }
}
