export interface PacejkaCoefficients {
  /** Stiffness: how quickly force builds with slip. */
  B: number;
  /** Shape: how far force falls away beyond the peak. */
  C: number;
  /** Curvature: sharpness of the peak. */
  E: number;
}

/** Racing slick: peaks at roughly 6 degrees of slip and keeps about 80% of its grip when sliding. */
export const SLICK: PacejkaCoefficients = { B: 16, C: 1.45, E: 0.1 };

/**
 * Normalised Pacejka "magic formula": the fraction of available grip (-1..1) a tyre produces at a given slip angle.
 * Odd in slip, so the force always opposes the slide.
 */
export function pacejka(slip: number, k: PacejkaCoefficients): number {
  const bx = k.B * slip;
  return Math.sin(k.C * Math.atan(bx - k.E * (bx - Math.atan(bx))));
}

/** Slip angle in radians at which the tyre produces its peak force. */
export function peakSlip(k: PacejkaCoefficients): number {
  let best = 0;
  let bestF = 0;
  for (let a = 0; a < 0.5; a += 0.0005) {
    const f = pacejka(a, k);
    if (f > bestF) {
      bestF = f;
      best = a;
    }
  }
  return best;
}

/**
 * Grip multiplier from tyre surface temperature and wear. Grip peaks in the operating window and falls away
 * either side: cold tyres slide, overheated ones go greasy. Worn tyres lose up to 12% when fully worn.
 */
export function tyreCondition(temp: number, wear: number, optimal: number, window: number): number {
  const t = (temp - optimal) / window;
  const thermal = Math.max(0.76, 1 - 0.2 * t * t);
  return thermal * (1 - 0.12 * Math.min(1, Math.max(0, wear)));
}

/**
 * Tyre load sensitivity: the friction coefficient drops as load rises, so doubling the load
 * less than doubles the grip. This is why weight transfer costs a car grip overall.
 */
export function loadSensitiveMu(mu: number, load: number, nominalLoad: number): number {
  const factor = 1 - 0.1 * (load / nominalLoad - 1);
  return mu * Math.min(1.2, Math.max(0.65, factor));
}
