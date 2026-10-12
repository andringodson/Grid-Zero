import type * as THREE from 'three';
import type { Car } from '../physics/Car.ts';
import { engineWave, softClip } from './CarAudio.ts';

/** Only the nearest few rivals get a voice: beyond that they're masked by the player's own engine anyway. */
const VOICES = 3;
const HEARING_RANGE = 180;
const SPEED_OF_SOUND = 343;

interface Voice {
  bankA: OscillatorNode;
  bankB: OscillatorNode;
  filter: BiquadFilterNode;
  gain: GainNode;
  panner: PannerNode;
  car: Car | null;
  lastDistance: number;
}

/**
 * Rival cars' engines, placed in 3D around the camera. Distance falls off naturally, the panner puts each car
 * left or right, and the pitch drops as a car passes (Doppler), the sound that tells you someone is alongside.
 */
export class OpponentAudio {
  private readonly ctx: AudioContext;
  private readonly voices: Voice[] = [];

  constructor(ctx: AudioContext, output: AudioNode, hrtf: boolean) {
    this.ctx = ctx;
    const wave = engineWave(ctx);
    const curve = softClip(2);
    for (let i = 0; i < VOICES; i++) {
      const bankA = ctx.createOscillator();
      const bankB = ctx.createOscillator();
      bankA.setPeriodicWave(wave);
      bankB.setPeriodicWave(wave);
      bankB.detune.value = 11;
      const mix = ctx.createGain();
      mix.gain.value = 0.5;
      const shaper = ctx.createWaveShaper();
      shaper.curve = curve;
      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      const gain = ctx.createGain();
      gain.gain.value = 0;
      const panner = new PannerNode(ctx, {
        panningModel: hrtf ? 'HRTF' : 'equalpower',
        distanceModel: 'inverse',
        refDistance: 6,
        maxDistance: HEARING_RANGE,
        rolloffFactor: 1.4,
      });
      bankA.connect(mix);
      bankB.connect(mix);
      mix.connect(shaper).connect(filter).connect(gain).connect(panner).connect(output);
      bankA.start();
      bankB.start();
      this.voices.push({ bankA, bankB, filter, gain, panner, car: null, lastDistance: 0 });
    }
  }

  update(camera: THREE.Camera, opponents: readonly Car[], dt: number): void {
    const t = this.ctx.currentTime;
    const l = this.ctx.listener;
    const p = camera.position;
    const m = camera.matrixWorld.elements;
    // Camera looks down its local -z; up is local +y.
    if (l.positionX) {
      l.positionX.setTargetAtTime(p.x, t, 0.02);
      l.positionY.setTargetAtTime(p.y, t, 0.02);
      l.positionZ.setTargetAtTime(p.z, t, 0.02);
      l.forwardX.setTargetAtTime(-m[8], t, 0.02);
      l.forwardY.setTargetAtTime(-m[9], t, 0.02);
      l.forwardZ.setTargetAtTime(-m[10], t, 0.02);
      l.upX.setTargetAtTime(m[4], t, 0.02);
      l.upY.setTargetAtTime(m[5], t, 0.02);
      l.upZ.setTargetAtTime(m[6], t, 0.02);
    } else {
      // Older Safari only has the setter methods.
      l.setPosition(p.x, p.y, p.z);
      l.setOrientation(-m[8], -m[9], -m[10], m[4], m[5], m[6]);
    }

    const nearest = opponents
      .map((car) => ({ car, d: Math.hypot(car.x - p.x, car.z - p.z) }))
      .filter((o) => o.d < HEARING_RANGE)
      .sort((a, b) => a.d - b.d)
      .slice(0, VOICES);

    for (const v of this.voices) {
      const match = nearest.find((o) => o.car === v.car);
      if (!match) {
        // This voice's car is out of range: hand it to the nearest car without a voice, or let it fade out.
        const free = nearest.find((o) => !this.voices.some((x) => x.car === o.car));
        v.car = free?.car ?? null;
        if (!free) {
          v.gain.gain.setTargetAtTime(0, t, 0.05);
          continue;
        }
        v.lastDistance = free.d;
      }
      const car = v.car!;
      const d = Math.hypot(car.x - p.x, car.z - p.z);
      // Doppler: a car closing in sounds higher, one pulling away lower.
      const radial = dt > 0 ? (d - v.lastDistance) / dt : 0;
      v.lastDistance = d;
      const doppler = Math.min(1.3, Math.max(0.75, SPEED_OF_SOUND / (SPEED_OF_SOUND + radial)));
      const crank = (car.rpm / 60) * doppler;
      v.bankA.frequency.setTargetAtTime(crank, t, 0.03);
      v.bankB.frequency.setTargetAtTime(crank, t, 0.03);
      v.filter.frequency.setTargetAtTime(500 + car.throttle * 4000 + car.rpm * 0.25, t, 0.03);
      v.gain.gain.setTargetAtTime(0.18 + 0.32 * car.throttle, t, 0.05);
      v.panner.positionX.setTargetAtTime(car.x, t, 0.02);
      v.panner.positionY.setTargetAtTime(car.y + 0.6, t, 0.02);
      v.panner.positionZ.setTargetAtTime(car.z, t, 0.02);
    }
  }

  silence(): void {
    const t = this.ctx.currentTime;
    for (const v of this.voices) {
      v.gain.gain.setTargetAtTime(0, t, 0.05);
      v.car = null;
    }
  }
}
