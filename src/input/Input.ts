import { approach, clamp } from '../math.ts';

export type InputSource = 'keyboard' | 'gamepad' | 'touch';

export interface InputFrame {
  throttle: number;
  brake: number;
  steer: number;
  /** Edge-triggered: true only on the frame the button went down. */
  shiftUp: boolean;
  shiftDown: boolean;
  camera: boolean;
  reset: boolean;
  pause: boolean;
  /** Where the most recent input came from; the game picks assists and on-screen controls from it. */
  source: InputSource;
}

/** Written by the on-screen touch controls; read every frame. */
export interface TouchState {
  active: boolean;
  throttle: number;
  brake: number;
  steer: number;
  shiftUp: boolean;
  shiftDown: boolean;
  camera: boolean;
  reset: boolean;
  pause: boolean;
}

type Action = 'throttle' | 'brake' | 'left' | 'right' | 'shiftUp' | 'shiftDown' | 'camera' | 'reset' | 'pause';

const KEYS: Record<string, Action> = {
  KeyW: 'throttle',
  ArrowUp: 'throttle',
  KeyS: 'brake',
  ArrowDown: 'brake',
  KeyA: 'left',
  ArrowLeft: 'left',
  KeyD: 'right',
  ArrowRight: 'right',
  KeyE: 'shiftUp',
  ShiftRight: 'shiftUp',
  KeyQ: 'shiftDown',
  ControlRight: 'shiftDown',
  KeyC: 'camera',
  KeyR: 'reset',
  Escape: 'pause',
  KeyP: 'pause',
};

/** Standard gamepad layout (Xbox naming). */
const PAD = { a: 0, b: 1, x: 2, y: 3, lt: 6, rt: 7, start: 9 } as const;
const DEADZONE = 0.08;

/** How fast keyboard inputs travel, per second: steering takes ~0.3 s to full lock and returns faster. */
const KEY_STEER_RATE = 3.2;
const KEY_STEER_RETURN = 5;
const KEY_PEDAL_RATE = 7;

export class Input {
  readonly touch: TouchState = {
    active: false,
    throttle: 0,
    brake: 0,
    steer: 0,
    shiftUp: false,
    shiftDown: false,
    camera: false,
    reset: false,
    pause: false,
  };

  private held = new Set<Action>();
  private pressed = new Set<Action>();
  private padPrev: boolean[] = [];
  private keySteer = 0;
  private keyThrottle = 0;
  private keyBrake = 0;
  private source: InputSource = matchMedia('(pointer: coarse)').matches ? 'touch' : 'keyboard';

  constructor(target: Window = window) {
    target.addEventListener('keydown', (e) => {
      const action = KEYS[e.code];
      if (!action) return;
      e.preventDefault();
      if (!e.repeat) this.pressed.add(action);
      this.held.add(action);
      this.source = 'keyboard';
    });
    target.addEventListener('keyup', (e) => {
      const action = KEYS[e.code];
      if (action) this.held.delete(action);
    });
    // Releasing everything when the window loses focus stops the car driving off on its own.
    target.addEventListener('blur', () => this.held.clear());
  }

  get lastSource(): InputSource {
    return this.source;
  }

  poll(dt: number): InputFrame {
    const frame: InputFrame = {
      throttle: 0,
      brake: 0,
      steer: 0,
      shiftUp: this.pressed.has('shiftUp'),
      shiftDown: this.pressed.has('shiftDown'),
      camera: this.pressed.has('camera'),
      reset: this.pressed.has('reset'),
      pause: this.pressed.has('pause'),
      source: this.source,
    };
    this.pressed.clear();

    // Keyboard: ramp digital keys into analogue values.
    const steerTarget = (this.held.has('right') ? 1 : 0) - (this.held.has('left') ? 1 : 0);
    const steerRate = steerTarget === 0 || Math.sign(steerTarget) !== Math.sign(this.keySteer) ? KEY_STEER_RETURN : KEY_STEER_RATE;
    this.keySteer = approach(this.keySteer, steerTarget, steerRate * dt);
    this.keyThrottle = approach(this.keyThrottle, this.held.has('throttle') ? 1 : 0, KEY_PEDAL_RATE * dt);
    this.keyBrake = approach(this.keyBrake, this.held.has('brake') ? 1 : 0, KEY_PEDAL_RATE * 1.5 * dt);
    frame.throttle = this.keyThrottle;
    frame.brake = this.keyBrake;
    frame.steer = this.keySteer;

    // Gamepad: the first connected pad wins over the keyboard whenever it's being used.
    const pad = navigator.getGamepads?.().find((p) => p && p.connected);
    if (pad) {
      const button = (i: number) => pad.buttons[i]?.value ?? 0;
      const pressedNow = (i: number) => {
        const down = (pad.buttons[i]?.pressed ?? false) === true;
        const edge = down && !this.padPrev[i];
        this.padPrev[i] = down;
        return edge;
      };
      const raw = pad.axes[0] ?? 0;
      const stick = Math.abs(raw) < DEADZONE ? 0 : Math.sign(raw) * ((Math.abs(raw) - DEADZONE) / (1 - DEADZONE));
      // A gentle curve gives fine control near the centre and full lock at the edge.
      const padSteer = Math.sign(stick) * Math.abs(stick) ** 1.6;
      const padThrottle = button(PAD.rt);
      const padBrake = button(PAD.lt);
      if (Math.abs(padSteer) > 0 || padThrottle > 0.02 || padBrake > 0.02) this.source = 'gamepad';
      if (this.source === 'gamepad') {
        frame.steer = padSteer;
        frame.throttle = padThrottle;
        frame.brake = padBrake;
      }
      frame.shiftUp ||= pressedNow(PAD.a);
      frame.shiftDown ||= pressedNow(PAD.x);
      frame.camera ||= pressedNow(PAD.y);
      frame.reset ||= pressedNow(PAD.b);
      frame.pause ||= pressedNow(PAD.start);
    }

    // Touch.
    const t = this.touch;
    if (t.active) {
      this.source = 'touch';
      frame.steer = t.steer;
      frame.throttle = t.throttle;
      frame.brake = t.brake;
    }
    frame.shiftUp ||= t.shiftUp;
    frame.shiftDown ||= t.shiftDown;
    frame.camera ||= t.camera;
    frame.reset ||= t.reset;
    frame.pause ||= t.pause;
    t.shiftUp = t.shiftDown = t.camera = t.reset = t.pause = false;

    frame.steer = clamp(frame.steer, -1, 1);
    frame.source = this.source;
    return frame;
  }
}
