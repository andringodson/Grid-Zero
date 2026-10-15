import type { TouchState } from '../input/Input.ts';
import { clamp } from '../math.ts';

export type TouchSteering = 'drag' | 'tilt';

/** Horizontal drag, in CSS pixels, for full steering lock. */
const DRAG_RANGE = 80;
/** Device tilt, in degrees, for full steering lock. */
const TILT_RANGE = 28;

type DeviceOrientationWithPermission = typeof DeviceOrientationEvent & { requestPermission?: () => Promise<'granted' | 'denied'> };

/**
 * On-screen controls for phones and tablets: drag steering on the left half of the screen (or tilt), pedals on the
 * right. Pointer events track each finger separately, so steering, braking and throttle all work at once.
 */
export class TouchControls {
  readonly root: HTMLDivElement;
  private readonly state: TouchState;
  private readonly knob: HTMLElement;
  private readonly steerZone: HTMLElement;
  private readonly throttle: HTMLElement;
  private readonly brake: HTMLElement;
  private steerPointer: number | null = null;
  private steerOrigin = 0;
  private readonly pedalPointers = new Map<number, 'throttle' | 'brake'>();
  private mode: TouchSteering = 'drag';
  private tiltZero: number | null = null;
  private tilt = 0;

  constructor(parent: HTMLElement, state: TouchState) {
    this.state = state;
    this.root = document.createElement('div');
    this.root.className = 'touch';
    this.root.innerHTML = `
      <div class="touch-steer"><div class="touch-track"><div class="touch-knob"></div></div><span class="touch-hint">DRAG TO STEER</span></div>
      <div class="touch-pedals">
        <div class="touch-pedal touch-brake"><span>BRAKE</span></div>
        <div class="touch-pedal touch-throttle"><span>THROTTLE</span></div>
      </div>
      <div class="touch-buttons">
        <button class="touch-btn" data-act="pause" aria-label="Pause">II</button>
        <button class="touch-btn" data-act="camera" aria-label="Change camera">CAM</button>
        <button class="touch-btn" data-act="reset" aria-label="Reset car">RESET</button>
      </div>
      <div class="touch-paddles">
        <button class="touch-btn" data-act="shiftDown" aria-label="Shift down">-</button>
        <button class="touch-btn" data-act="shiftUp" aria-label="Shift up">+</button>
      </div>
      <button class="touch-btn touch-drs" data-act="drs" aria-label="Open DRS">DRS</button>`;
    parent.appendChild(this.root);
    this.steerZone = this.root.querySelector('.touch-steer')!;
    this.knob = this.root.querySelector('.touch-knob')!;
    this.throttle = this.root.querySelector('.touch-throttle')!;
    this.brake = this.root.querySelector('.touch-brake')!;

    this.steerZone.addEventListener('pointerdown', (e) => {
      if (this.mode !== 'drag' || this.steerPointer !== null) return;
      this.steerPointer = e.pointerId;
      this.steerOrigin = e.clientX;
      this.state.active = true;
      this.setSteer(0);
      // Capture last: if it fails (the pointer already gone), the input above still counts.
      this.steerZone.setPointerCapture(e.pointerId);
    });
    this.steerZone.addEventListener('pointermove', (e) => {
      if (e.pointerId === this.steerPointer) this.setSteer((e.clientX - this.steerOrigin) / DRAG_RANGE);
    });
    const endSteer = (e: PointerEvent) => {
      if (e.pointerId !== this.steerPointer) return;
      this.steerPointer = null;
      this.setSteer(0);
    };
    this.steerZone.addEventListener('pointerup', endSteer);
    this.steerZone.addEventListener('pointercancel', endSteer);

    for (const [el, pedal] of [
      [this.throttle, 'throttle'],
      [this.brake, 'brake'],
    ] as const) {
      el.addEventListener('pointerdown', (e) => {
        this.pedalPointers.set(e.pointerId, pedal);
        this.state.active = true;
        this.syncPedals();
        el.setPointerCapture(e.pointerId);
      });
      const release = (e: PointerEvent) => {
        this.pedalPointers.delete(e.pointerId);
        this.syncPedals();
      };
      el.addEventListener('pointerup', release);
      el.addEventListener('pointercancel', release);
    }

    this.root.querySelectorAll<HTMLButtonElement>('.touch-btn').forEach((btn) => {
      btn.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        const act = btn.dataset.act as 'pause' | 'camera' | 'reset' | 'shiftUp' | 'shiftDown' | 'drs';
        this.state[act] = true;
        this.state.active = true;
      });
    });

    window.addEventListener('deviceorientation', (e) => this.onOrientation(e));
  }

  show(visible: boolean): void {
    this.root.style.display = visible ? '' : 'none';
    if (!visible) this.releaseAll();
  }

  /** The DRS button only appears when DRS can be used, and lights up while the flap is open. */
  setDrs(available: boolean, open: boolean): void {
    const btn = this.root.querySelector<HTMLElement>('.touch-drs')!;
    btn.style.display = available ? 'block' : 'none';
    btn.classList.toggle('open', open);
  }

  showPaddles(visible: boolean): void {
    this.root.querySelector<HTMLElement>('.touch-paddles')!.style.display = visible ? '' : 'none';
  }

  /** Switches steering mode. Tilt needs permission on iOS, which must be asked from a tap; returns whether it is usable. */
  async setSteering(mode: TouchSteering): Promise<boolean> {
    if (mode === 'tilt') {
      const DOE = window.DeviceOrientationEvent as DeviceOrientationWithPermission | undefined;
      if (!DOE) return false;
      if (DOE.requestPermission) {
        try {
          if ((await DOE.requestPermission()) !== 'granted') return false;
        } catch {
          return false;
        }
      }
      this.tiltZero = null;
    }
    this.mode = mode;
    this.root.classList.toggle('touch-tilt', mode === 'tilt');
    this.setSteer(0);
    return true;
  }

  /** Treat the current device angle as straight ahead. */
  recentreTilt(): void {
    this.tiltZero = null;
  }

  private onOrientation(e: DeviceOrientationEvent): void {
    if (this.mode !== 'tilt' || e.beta === null) return;
    // In landscape, turning the phone like a steering wheel changes beta; the sign depends on which way it's held.
    const angle = screen.orientation?.angle ?? (window as unknown as { orientation?: number }).orientation ?? 90;
    const raw = angle === 270 || angle === -90 ? -e.beta : e.beta;
    if (this.tiltZero === null) this.tiltZero = raw;
    this.tilt = raw - this.tiltZero;
    this.state.active = true;
    this.setSteer(this.tilt / TILT_RANGE);
  }

  private setSteer(v: number): void {
    const s = clamp(v, -1, 1);
    this.state.steer = s;
    this.knob.style.transform = `translateX(${(s * DRAG_RANGE * 0.8).toFixed(1)}px)`;
  }

  private syncPedals(): void {
    const pedals = [...this.pedalPointers.values()];
    this.state.throttle = pedals.includes('throttle') ? 1 : 0;
    this.state.brake = pedals.includes('brake') ? 1 : 0;
    this.throttle.classList.toggle('down', this.state.throttle > 0);
    this.brake.classList.toggle('down', this.state.brake > 0);
  }

  private releaseAll(): void {
    this.steerPointer = null;
    this.pedalPointers.clear();
    this.syncPedals();
    this.setSteer(0);
  }
}
