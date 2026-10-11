import { clamp } from '../math.ts';
import type { Car } from '../physics/Car.ts';

/**
 * All car sound is synthesised live from the physics, so it ships with no samples and reacts to everything the car
 * does. The engine is a turbo V6: three firing pulses per crank revolution, so its main tone sits at rpm / 20 Hz.
 */

const SMOOTH = 0.025;

function noiseBuffer(ctx: AudioContext, seconds: number): AudioBuffer {
  const buf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * seconds), ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  return buf;
}

/** Harmonic recipe for a V6: strong components at multiples of the firing frequency (every 3rd crank harmonic). */
export function engineWave(ctx: AudioContext): PeriodicWave {
  const n = 40;
  const real = new Float32Array(n);
  const imag = new Float32Array(n);
  for (let h = 1; h < n; h++) {
    const firing = h % 3 === 0;
    imag[h] = firing ? 1 / Math.sqrt(h / 3) : 0.22 / h;
    // A little asymmetry between banks gives the uneven, rasping edge of a real engine.
    real[h] = h % 2 === 0 ? 0.08 / h : 0;
  }
  return ctx.createPeriodicWave(real, imag);
}

export function softClip(amount: number): Float32Array<ArrayBuffer> {
  const curve = new Float32Array(1024);
  for (let i = 0; i < curve.length; i++) {
    const x = (i / (curve.length - 1)) * 2 - 1;
    curve[i] = Math.tanh(x * amount) / Math.tanh(amount);
  }
  return curve;
}

export class CarAudio {
  readonly ctx: AudioContext;
  /** Everything the game plays goes through here, so volume and mute apply to all of it. */
  readonly master: GainNode;
  private readonly bankA: OscillatorNode;
  private readonly bankB: OscillatorNode;
  private readonly engineFilter: BiquadFilterNode;
  private readonly engineGain: GainNode;
  private readonly intakeFilter: BiquadFilterNode;
  private readonly intakeGain: GainNode;
  private readonly turbo: OscillatorNode;
  private readonly turboGain: GainNode;
  private readonly mguk: OscillatorNode;
  private readonly mgukGain: GainNode;
  private readonly squealFilter: BiquadFilterNode;
  private readonly squealGain: GainNode;
  private readonly squealTone: OscillatorNode;
  private readonly squealToneGain: GainNode;
  private readonly windFilter: BiquadFilterNode;
  private readonly windGain: GainNode;
  private readonly rumble: OscillatorNode;
  private readonly rumbleGain: GainNode;
  private readonly groundGain: GainNode;
  private readonly noise: AudioBuffer;
  private lastGear = 1;
  private lastThrottle = 0;
  private popCooldown = 0;
  private volume = 0.8;
  private muted = false;

  constructor() {
    const AC: typeof AudioContext = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ctx = new AC({ latencyHint: 'interactive' });
    this.ctx = ctx;
    this.noise = noiseBuffer(ctx, 2);

    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.ratio.value = 4;
    comp.attack.value = 0.003;
    comp.release.value = 0.15;
    this.master = ctx.createGain();
    this.master.gain.value = this.volume;
    this.master.connect(comp).connect(ctx.destination);

    const noiseSource = (): AudioBufferSourceNode => {
      const src = ctx.createBufferSource();
      src.buffer = this.noise;
      src.loop = true;
      src.loopStart = Math.random();
      src.start();
      return src;
    };

    // Engine: two banks a few cents apart, saturated and filtered by throttle.
    const wave = engineWave(ctx);
    this.bankA = ctx.createOscillator();
    this.bankB = ctx.createOscillator();
    this.bankA.setPeriodicWave(wave);
    this.bankB.setPeriodicWave(wave);
    this.bankB.detune.value = 9;
    const shaper = ctx.createWaveShaper();
    shaper.curve = softClip(2.2);
    shaper.oversample = '2x';
    this.engineFilter = ctx.createBiquadFilter();
    this.engineFilter.type = 'lowpass';
    this.engineFilter.Q.value = 0.9;
    this.engineGain = ctx.createGain();
    this.engineGain.gain.value = 0;
    const bankMix = ctx.createGain();
    bankMix.gain.value = 0.5;
    this.bankA.connect(bankMix);
    this.bankB.connect(bankMix);
    bankMix.connect(shaper).connect(this.engineFilter).connect(this.engineGain).connect(this.master);
    this.bankA.start();
    this.bankB.start();

    // Intake and exhaust roar: noise shaped around the firing frequency.
    this.intakeFilter = ctx.createBiquadFilter();
    this.intakeFilter.type = 'bandpass';
    this.intakeFilter.Q.value = 2.5;
    this.intakeGain = ctx.createGain();
    this.intakeGain.gain.value = 0;
    noiseSource().connect(this.intakeFilter).connect(this.intakeGain).connect(this.master);

    // Turbocharger whistle and the hybrid motor's electric whine.
    this.turbo = ctx.createOscillator();
    this.turbo.type = 'sine';
    this.turboGain = ctx.createGain();
    this.turboGain.gain.value = 0;
    this.turbo.connect(this.turboGain).connect(this.master);
    this.turbo.start();
    this.mguk = ctx.createOscillator();
    this.mguk.type = 'triangle';
    this.mgukGain = ctx.createGain();
    this.mgukGain.gain.value = 0;
    this.mguk.connect(this.mgukGain).connect(this.master);
    this.mguk.start();

    // Tyres: filtered noise for scrub plus a wavering tone for the squeal of a locked or sliding tyre.
    this.squealFilter = ctx.createBiquadFilter();
    this.squealFilter.type = 'bandpass';
    this.squealFilter.frequency.value = 1100;
    this.squealFilter.Q.value = 5;
    this.squealGain = ctx.createGain();
    this.squealGain.gain.value = 0;
    noiseSource().connect(this.squealFilter).connect(this.squealGain).connect(this.master);
    this.squealTone = ctx.createOscillator();
    this.squealTone.type = 'sawtooth';
    this.squealTone.frequency.value = 760;
    const vibrato = ctx.createOscillator();
    vibrato.frequency.value = 13;
    const vibratoDepth = ctx.createGain();
    vibratoDepth.gain.value = 18;
    vibrato.connect(vibratoDepth).connect(this.squealTone.frequency);
    vibrato.start();
    const toneFilter = ctx.createBiquadFilter();
    toneFilter.type = 'bandpass';
    toneFilter.frequency.value = 900;
    toneFilter.Q.value = 3;
    this.squealToneGain = ctx.createGain();
    this.squealToneGain.gain.value = 0;
    this.squealTone.connect(toneFilter).connect(this.squealToneGain).connect(this.master);
    this.squealTone.start();

    // Wind over the cockpit.
    this.windFilter = ctx.createBiquadFilter();
    this.windFilter.type = 'lowpass';
    this.windGain = ctx.createGain();
    this.windGain.gain.value = 0;
    noiseSource().connect(this.windFilter).connect(this.windGain).connect(this.master);

    // Kerb rumble: a low square wave at the rate the kerb blocks pass under the tyres.
    this.rumble = ctx.createOscillator();
    this.rumble.type = 'square';
    const rumbleFilter = ctx.createBiquadFilter();
    rumbleFilter.type = 'lowpass';
    rumbleFilter.frequency.value = 220;
    this.rumbleGain = ctx.createGain();
    this.rumbleGain.gain.value = 0;
    this.rumble.connect(rumbleFilter).connect(this.rumbleGain).connect(this.master);
    this.rumble.start();

    // Grass: low, uneven rumble.
    const groundFilter = ctx.createBiquadFilter();
    groundFilter.type = 'lowpass';
    groundFilter.frequency.value = 180;
    this.groundGain = ctx.createGain();
    this.groundGain.gain.value = 0;
    noiseSource().connect(groundFilter).connect(this.groundGain).connect(this.master);
  }

  /** Browsers start audio suspended until the player interacts; call from a click or key handler. */
  async resume(): Promise<void> {
    if (this.ctx.state !== 'running') await this.ctx.resume();
  }

  setVolume(v: number): void {
    this.volume = clamp(v, 0, 1);
    this.applyVolume();
  }

  setMuted(m: boolean): void {
    this.muted = m;
    this.applyVolume();
  }

  private applyVolume(): void {
    this.master.gain.setTargetAtTime(this.muted ? 0 : this.volume, this.ctx.currentTime, 0.05);
  }

  update(car: Car, dt: number, kerb: number, impact: number): void {
    const t = this.ctx.currentTime;
    const set = (p: AudioParam, v: number, tau = SMOOTH) => p.setTargetAtTime(v, t, tau);
    const speed = Math.abs(car.u);
    const rpm = car.rpm;
    const thr = car.throttle;
    const load = 0.35 + 0.65 * thr;

    // Engine pitch: crank rotation frequency; the wave's 3rd harmonic is the firing tone.
    const crank = rpm / 60;
    set(this.bankA.frequency, crank);
    set(this.bankB.frequency, crank);
    let engineLevel = 0.2 + 0.55 * load * (0.5 + 0.5 * (rpm / car.spec.limiterRpm));
    if (car.limiter) engineLevel *= 0.55 + 0.45 * Math.random();
    set(this.engineGain.gain, engineLevel);
    set(this.engineFilter.frequency, 600 + thr * 5200 + rpm * 0.35);

    set(this.intakeFilter.frequency, (rpm / 20) * 2);
    set(this.intakeGain.gain, 0.06 + thr * 0.22 * (rpm / car.spec.limiterRpm));

    set(this.turbo.frequency, 2200 + rpm * 0.28);
    set(this.turboGain.gain, thr * 0.012 * (rpm / car.spec.limiterRpm));
    set(this.mguk.frequency, 180 + speed * 26);
    set(this.mgukGain.gain, (1 - thr) * Math.min(1, speed / 40) * 0.025 + car.brake * 0.02);

    // Gear change: a brief cut and a mechanical knock.
    if (car.gear !== this.lastGear) {
      this.engineGain.gain.cancelScheduledValues(t);
      this.engineGain.gain.setValueAtTime(engineLevel * 0.35, t);
      this.engineGain.gain.setTargetAtTime(engineLevel, t + 0.03, 0.02);
      this.burst(0.18, 260, 0.05);
      this.lastGear = car.gear;
    }

    // Overrun pops when lifting off at high revs.
    this.popCooldown -= dt;
    if (thr < 0.15 && this.lastThrottle > 0.5 && rpm > 9000) this.popCooldown = 0;
    if (thr < 0.1 && rpm > 8000 && this.popCooldown <= 0 && Math.random() < 0.35) {
      this.burst(0.22 + Math.random() * 0.2, 900 + Math.random() * 900, 0.025);
      this.popCooldown = 0.06 + Math.random() * 0.12;
    }
    this.lastThrottle = thr;

    // Tyres.
    const onAsphalt = car.wheelSurface.filter((k) => k !== 'grass').length / 4;
    const squeal = clamp(car.slide * 1.3 + car.lockup + car.wheelSpin * 1.5, 0, 1) * onAsphalt * Math.min(1, speed / 8);
    set(this.squealGain.gain, squeal * 0.22, 0.04);
    set(this.squealToneGain.gain, squeal * 0.07, 0.04);
    set(this.squealTone.frequency, 640 + squeal * 260 + car.lockup * 200, 0.04);
    set(this.squealFilter.frequency, 900 + squeal * 700, 0.04);

    set(this.windFilter.frequency, 300 + speed * 18);
    set(this.windGain.gain, Math.min(0.32, (speed / 90) ** 2 * 0.3));

    set(this.rumble.frequency, Math.max(20, speed / 1.2));
    set(this.rumbleGain.gain, kerb > 0 && speed > 3 ? 0.18 * Math.min(1, speed / 20) : 0, 0.02);
    const grass = 1 - onAsphalt;
    set(this.groundGain.gain, grass * Math.min(1, speed / 15) * 0.5, 0.05);

    if (impact > 2) this.burst(Math.min(1, impact / 20), 400, 0.18);
  }

  /** A short filtered noise burst: pops, knocks and impacts. */
  private burst(level: number, frequency: number, duration: number): void {
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = frequency;
    filter.Q.value = 1.2;
    const g = ctx.createGain();
    g.gain.setValueAtTime(level, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + duration);
    src.connect(filter).connect(g).connect(this.master);
    src.start(t, Math.random(), duration + 0.02);
  }
}
