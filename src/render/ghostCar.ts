import * as THREE from 'three';
import type { GhostPose } from '../game/ghost.ts';
import type { Livery } from '../game/teams.ts';
import type { Car } from '../physics/Car.ts';
import { buildCarModel } from './carModel.ts';

/** Your best lap as a see-through car to race against. It casts no shadow and nothing collides with it. */
export class GhostCar {
  readonly root: THREE.Group;

  constructor(car: Car, livery: Livery) {
    const visual = buildCarModel(car, livery, false);
    this.root = visual.root;
    this.root.traverse((o) => {
      if (!(o instanceof THREE.Mesh)) return;
      o.castShadow = false;
      o.receiveShadow = false;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of mats) {
        m.transparent = true;
        m.opacity *= 0.32;
        m.depthWrite = false;
      }
    });
    this.root.visible = false;
  }

  show(pose: GhostPose | null): void {
    if (!pose) {
      this.root.visible = false;
      return;
    }
    this.root.visible = true;
    this.root.position.set(pose.x, pose.y, pose.z);
    this.root.rotation.set(-pose.roll, -pose.yaw, pose.pitch, 'YZX');
  }
}
