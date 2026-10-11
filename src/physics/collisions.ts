import type { Car } from './Car.ts';

/** Each car is approximated by two discs along its centreline, which fits a long, narrow open-wheeler well. */
const DISC_OFFSET = 1.45;
const DISC_RADIUS = 0.95;
const RESTITUTION = 0.15;
/** Cars further apart than this can't touch; skip the detailed test. */
const BROAD_PHASE = 2 * (DISC_OFFSET + DISC_RADIUS);

export interface Contact {
  a: Car;
  b: Car;
  /** Closing speed along the contact normal, m/s. */
  speed: number;
}

function discs(car: Car): [number, number][] {
  const c = Math.cos(car.yaw);
  const s = Math.sin(car.yaw);
  return [
    [car.x + c * DISC_OFFSET, car.z + s * DISC_OFFSET],
    [car.x - c * DISC_OFFSET, car.z - s * DISC_OFFSET],
  ];
}

function worldVelocity(car: Car): [number, number] {
  const c = Math.cos(car.yaw);
  const s = Math.sin(car.yaw);
  return [car.u * c - car.v * s, car.u * s + car.v * c];
}

function setWorldVelocity(car: Car, vx: number, vz: number): void {
  const c = Math.cos(car.yaw);
  const s = Math.sin(car.yaw);
  car.u = vx * c + vz * s;
  car.v = -vx * s + vz * c;
}

/**
 * Separates overlapping cars and applies an impulse at the contact point, so a nudge from behind pushes the car ahead
 * and a hit off-centre spins it. Slightly inelastic; momentum is conserved.
 */
export function resolveCollisions(cars: readonly Car[]): Contact[] {
  const contacts: Contact[] = [];
  for (let i = 0; i < cars.length; i++) {
    for (let j = i + 1; j < cars.length; j++) {
      const a = cars[i];
      const b = cars[j];
      if (Math.abs(a.x - b.x) > BROAD_PHASE || Math.abs(a.z - b.z) > BROAD_PHASE) continue;
      let deepest = 0;
      let nx = 0;
      let nz = 0;
      let px = 0;
      let pz = 0;
      for (const [ax, az] of discs(a)) {
        for (const [bx, bz] of discs(b)) {
          const dx = bx - ax;
          const dz = bz - az;
          const d = Math.hypot(dx, dz);
          const overlap = 2 * DISC_RADIUS - d;
          if (overlap > deepest && d > 1e-6) {
            deepest = overlap;
            nx = dx / d;
            nz = dz / d;
            px = (ax + bx) / 2;
            pz = (az + bz) / 2;
          }
        }
      }
      if (deepest <= 0) continue;

      // Push apart equally.
      a.x -= nx * deepest * 0.5;
      a.z -= nz * deepest * 0.5;
      b.x += nx * deepest * 0.5;
      b.z += nz * deepest * 0.5;

      const [avx, avz] = worldVelocity(a);
      const [bvx, bvz] = worldVelocity(b);
      const closing = (avx - bvx) * nx + (avz - bvz) * nz;
      if (closing <= 0) continue;

      // Impulse between two masses (fuel loads differ, so cars aren't quite equal).
      const ma = a.mass;
      const mb = b.mass;
      const J = ((1 + RESTITUTION) * closing) / (1 / ma + 1 / mb);
      setWorldVelocity(a, avx - (J / ma) * nx, avz - (J / ma) * nz);
      setWorldVelocity(b, bvx + (J / mb) * nx, bvz + (J / mb) * nz);

      // Angular impulse about each car's centre: an off-centre hit turns the car.
      const spin = (car: Car, jx: number, jz: number) => {
        const rx = px - car.x;
        const rz = pz - car.z;
        car.r += ((rx * jz - rz * jx) / car.spec.yawInertia) * 0.6;
      };
      spin(a, -J * nx, -J * nz);
      spin(b, J * nx, J * nz);
      contacts.push({ a, b, speed: closing });
    }
  }
  return contacts;
}
