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
  private groundY = 0;
  private headLat = 0;
  private headLong = 0;
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

  /** Slow orbit around the parked car, behind the menus. */
  showcase(car: Car, dt: number): void {
    this.time += dt;
    const angle = this.time * 0.12 + 2.4;
    const cam = this.camera;
    cam.position.set(car.x + Math.cos(angle) * 7.5, car.y + 1.9 + Math.sin(this.time * 0.2) * 0.3, car.z + Math.sin(angle) * 7.5);
    cam.lookAt(car.x, car.y + 0.55, car.z);
    cam.fov = 40;
    cam.updateProjectionMatrix();
  }

  snap(car: Car): void {
    this.yaw = car.yaw;
    this.groundY = car.y;
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
    // A point fixed to the car: forward, up and right of its centre, riding the slope with it.
    const local = (f: number, up: number, r: number, out: THREE.Vector3) =>
      out.set(car.x + fwdX * f + rightX * r, car.groundY(f, r) + up, car.z + fwdZ * f + rightZ * r);

    let fov = 62;
    if (this.mode === 'chase') {
      const cx = Math.cos(this.yaw);
      const cz = Math.sin(this.yaw);
      const dist = 6.4 + speed * 0.012;
      // Height follows the ground with a little lag, so crests and dips read as the car rising and falling.
      const ground = damp(this.groundY, car.y, 0.12, dt);
      this.groundY = ground;
      this.pos.set(car.x - cx * dist, ground + 1.75 + speed * 0.002 - Math.tan(car.pitch) * dist * 0.6, car.z - cz * dist);
      this.look.set(car.x + cx * 3, ground + 0.75 + Math.tan(car.pitch) * 3, car.z + cz * 3);
      fov = 60 + Math.min(14, speed * 0.14);
    } else if (this.mode === 'tcam') {
      local(-0.55, 1.22, 0, this.pos);
      local(20, 0.7, 0, this.look);
      fov = 64 + Math.min(10, speed * 0.1);
    } else {
      // The driver's head: thrown toward the outside of a corner and forward under braking, the gaze tilting a
      // little into the turn. Smoothed, as a neck would.
      this.headLat = damp(this.headLat, -car.gLat * 0.012, 0.08, dt);
      this.headLong = damp(this.headLong, car.gLong * 0.008, 0.08, dt);
      local(-0.02 + this.headLong, 0.86 - Math.abs(this.headLong) * 0.4, this.headLat, this.pos);
      local(20, 0.55, car.gLat * 0.35, this.look);
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
