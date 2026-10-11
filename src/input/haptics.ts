import type { Car } from '../physics/Car.ts';

type Actuator = {
  playEffect?: (type: 'dual-rumble', params: { duration: number; strongMagnitude: number; weakMagnitude: number }) => Promise<unknown>;
};

/**
 * Feel through the hands: a gamepad's rumble motors carry kerbs, lock-ups, wheelspin and impacts; phones that support
 * vibration buzz on impacts. Pulses are short and re-sent each frame while the effect lasts.
 */
export class Haptics {
  enabled = true;
  private cooldown = 0;

  update(car: Car, kerb: number, impact: number, dt: number): void {
    if (!this.enabled) return;
    this.cooldown -= dt;
    const speed = Math.abs(car.u);
    // The heavy motor carries big, low events; the light one fine texture.
    const strong = Math.min(1, Math.max(impact / 15, car.lockup * 0.6, car.wheelSpin * 0.8));
    const weak = Math.min(1, kerb * Math.min(1, speed / 25) * 0.7 + car.slide * 0.4);

    const pad = navigator.getGamepads?.().find((p) => p && p.connected);
    const actuator = (pad as (Gamepad & { vibrationActuator?: Actuator }) | undefined)?.vibrationActuator;
    if (actuator?.playEffect && (strong > 0.05 || weak > 0.05) && this.cooldown <= 0) {
      void actuator.playEffect('dual-rumble', { duration: 60, strongMagnitude: strong, weakMagnitude: weak }).catch(() => {});
      this.cooldown = 0.05;
    }
    // Phones: only for real hits, so it never becomes a constant buzz.
    if (impact > 4 && 'vibrate' in navigator) navigator.vibrate(Math.min(120, 20 + impact * 4));
  }
}
