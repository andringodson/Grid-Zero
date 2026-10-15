export type WeatherMode = 'dry' | 'wet' | 'changing';

/** Cloud builds over this many seconds ahead of the rain. */
const CLOUD_BUILD = 40;
/** How fast the track takes on water in rain, and dries once it stops, per second. */
const WETTING = 0.02;
const DRYING = 0.003;

/**
 * Rain and the water it leaves on the track. Rain eases in and out; the track wets quickly in rain and dries slowly
 * after, so a shower leaves a damp track for a while. "Changing" starts dry and brings a shower in partway through:
 * light, since there are no pit stops to change onto rain tyres, so it leaves the track damp (slippery on slicks)
 * rather than flooded.
 */
export class Weather {
  readonly mode: WeatherMode;
  /** How hard it's raining now, 0 to 1. */
  rain: number;
  /** Cloud cover, 0 fair to 1 a full rain deck; it builds before rain arrives. */
  cloud: number;
  /** Water on the track, 0 to 1. */
  wetness: number;
  /** Seconds into the session when rain arrives ("changing" only). */
  readonly rainAt: number;
  private targetRain: number;
  /** How hard the rain gets once it comes. */
  private readonly heavy: number;
  private time = 0;

  constructor(mode: WeatherMode, random: () => number = Math.random) {
    this.mode = mode;
    const heavy = mode === 'changing' ? 0.2 + random() * 0.1 : 0.65 + random() * 0.3;
    if (mode === 'wet') {
      this.rain = this.targetRain = heavy;
      this.cloud = 1;
      this.wetness = 0.85;
    } else {
      this.rain = this.targetRain = 0;
      this.cloud = 0;
      this.wetness = 0;
    }
    this.rainAt = mode === 'changing' ? 60 + random() * 120 : Infinity;
    this.heavy = heavy;
  }

  update(dt: number): void {
    this.time += dt;
    if (this.time >= this.rainAt) this.targetRain = this.heavy;
    const ease = 0.04 * dt;
    this.rain += Math.max(-ease, Math.min(ease, this.targetRain - this.rain));
    const cloudTarget = this.time >= this.rainAt - CLOUD_BUILD || this.rain > 0 ? 1 : 0;
    const build = dt / CLOUD_BUILD;
    this.cloud += Math.max(-build, Math.min(build, cloudTarget - this.cloud));
    const saturated = this.rain > 0.05 ? Math.min(1, this.rain * 1.25) : 0;
    if (this.wetness < saturated) this.wetness = Math.min(saturated, this.wetness + WETTING * this.rain * dt * 2);
    else this.wetness = Math.max(saturated, this.wetness - DRYING * dt);
  }
}
