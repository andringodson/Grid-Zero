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

export interface TyreCompound {
  id: 'soft' | 'medium' | 'hard' | 'inter' | 'wet';
  name: string;
  /** Sidewall band colour, as on real race tyres. */
  colour: number;
  /** Peak grip relative to the medium, on a dry track. */
  grip: number;
  /** Peak grip on a fully wet track. Slicks can't clear water and aquaplane; treaded tyres pump it away. */
  wetGrip: number;
  /** Wear rate relative to the medium. */
  wear: number;
  /** Temperature of peak grip, deg C. */
  optimalTemp: number;
}

/**
 * Softer rubber grips harder and warms up sooner but wears out faster; harder rubber is the reverse. Intermediates
 * and full wets give up dry grip for grip in the rain, and run cooler: on a dry track they overheat and wear fast.
 * Crossovers: slick to intermediate at about 20% wetness, intermediate to full wet at about 55%.
 */
export const COMPOUNDS: Record<TyreCompound['id'], TyreCompound> = {
  soft: { id: 'soft', name: 'Soft', colour: 0xe0242c, grip: 1.025, wetGrip: 0.5, wear: 2, optimalTemp: 95 },
  medium: { id: 'medium', name: 'Medium', colour: 0xf2c400, grip: 1, wetGrip: 0.5, wear: 1, optimalTemp: 100 },
  hard: { id: 'hard', name: 'Hard', colour: 0xf2f2f2, grip: 0.985, wetGrip: 0.48, wear: 0.55, optimalTemp: 104 },
  inter: { id: 'inter', name: 'Inter', colour: 0x2fa84f, grip: 0.92, wetGrip: 0.82, wear: 1.6, optimalTemp: 75 },
  wet: { id: 'wet', name: 'Wet', colour: 0x2a6fdb, grip: 0.85, wetGrip: 0.88, wear: 1.4, optimalTemp: 65 },
};

/** A compound's peak grip at a track wetness from 0 (dry) to 1 (standing water). */
export function compoundGrip(c: TyreCompound, wetness: number): number {
  return c.grip + (c.wetGrip - c.grip) * Math.min(1, Math.max(0, wetness));
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
