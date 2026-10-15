export type QualityTier = 'low' | 'medium' | 'high' | 'ultra';

export interface QualitySettings {
  tier: QualityTier;
  maxPixelRatio: number;
  antialias: boolean;
  shadows: boolean;
  shadowMapSize: number;
  textureSize: number;
  anisotropy: number;
  trees: number;
  bloom: boolean;
  drawDistance: number;
  /** Size of each face of the cars' live reflection cube; 0 for none (they reflect the sky alone). */
  reflectionSize: number;
  /** Trees and stands in the reflections too: the probe's biggest cost, and the least noticed. */
  reflectScenery: boolean;
}

export const QUALITY: Record<QualityTier, QualitySettings> = {
  low: {
    tier: 'low',
    maxPixelRatio: 1,
    antialias: false,
    shadows: false,
    shadowMapSize: 512,
    textureSize: 256,
    anisotropy: 2,
    trees: 300,
    bloom: false,
    drawDistance: 1600,
    reflectionSize: 0,
    reflectScenery: false,
  },
  medium: {
    tier: 'medium',
    maxPixelRatio: 1.5,
    antialias: true,
    shadows: true,
    shadowMapSize: 1024,
    textureSize: 512,
    anisotropy: 4,
    trees: 900,
    bloom: true,
    drawDistance: 2400,
    reflectionSize: 64,
    reflectScenery: false,
  },
  high: {
    tier: 'high',
    maxPixelRatio: 1.5,
    antialias: true,
    shadows: true,
    shadowMapSize: 2048,
    textureSize: 1024,
    anisotropy: 8,
    trees: 1800,
    bloom: true,
    drawDistance: 3200,
    reflectionSize: 128,
    reflectScenery: true,
  },
  ultra: {
    tier: 'ultra',
    maxPixelRatio: 2,
    antialias: true,
    shadows: true,
    shadowMapSize: 4096,
    textureSize: 1024,
    anisotropy: 16,
    trees: 3000,
    bloom: true,
    drawDistance: 4000,
    reflectionSize: 256,
    reflectScenery: true,
  },
};

/** Picks a starting tier from what the device reveals; players can change it in settings. */
export function detectQualityTier(): QualityTier {
  const touch = matchMedia('(pointer: coarse)').matches;
  const cores = navigator.hardwareConcurrency || 4;
  const memory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? 8;
  if (touch) return cores >= 8 && memory >= 6 ? 'medium' : 'low';
  if (cores >= 12 && memory >= 8) return 'ultra';
  if (cores >= 6) return 'high';
  return 'medium';
}
