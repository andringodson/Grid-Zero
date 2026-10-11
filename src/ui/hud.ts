import { formatDelta, formatLapTime, type LapTimer, type TimingEvent } from '../game/LapTimer.ts';
import type { Car } from '../physics/Car.ts';
import type { Track } from '../track/Track.ts';

const LEDS = 15;
const SHIFT_LIGHT_START = 10400;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, parent?: HTMLElement, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = className;
  if (text !== undefined) e.textContent = text;
  parent?.appendChild(e);
  return e;
}

/** Only touches the DOM when a value changes, so the HUD costs almost nothing per frame. */
class Text {
  private value = '';
  constructor(readonly node: HTMLElement) {}
  set(v: string): void {
    if (v !== this.value) {
      this.value = v;
      this.node.textContent = v;
    }
  }
}

export class Hud {
  readonly root: HTMLDivElement;
  private readonly lap: Text;
  private readonly time: Text;
  private readonly delta: Text;
  private readonly deltaNode: HTMLElement;
  private readonly last: Text;
  private readonly best: Text;
  private readonly sectorNodes: HTMLElement[] = [];
  private readonly speed: Text;
  private readonly gear: Text;
  private readonly leds: HTMLElement[] = [];
  private readonly throttleBar: HTMLElement;
  private readonly brakeBar: HTMLElement;
  private readonly toast: HTMLElement;
  private readonly invalid: HTMLElement;
  private readonly map: HTMLCanvasElement;
  private readonly mapCtx: CanvasRenderingContext2D;
  private readonly mapBase: HTMLCanvasElement;
  private readonly mapTransform: (x: number, z: number) => [number, number];
  private toastTimer = 0;
  private ledState = '';

  constructor(parent: HTMLElement, track: Track) {
    this.root = el('div', 'hud', parent);

    const timing = el('div', 'hud-panel hud-timing', this.root);
    const head = el('div', 'hud-row', timing);
    this.lap = new Text(el('span', 'hud-label', head, 'OUT LAP'));
    this.invalid = el('span', 'hud-invalid', head, 'INVALID');
    this.time = new Text(el('div', 'hud-time', timing, '--:--.---'));
    this.deltaNode = el('div', 'hud-delta', timing);
    this.delta = new Text(this.deltaNode);
    const sectors = el('div', 'hud-sectors', timing);
    for (let i = 0; i < 3; i++) this.sectorNodes.push(el('span', 'hud-sector', sectors, `S${i + 1}`));
    const lastRow = el('div', 'hud-row hud-small', timing);
    el('span', 'hud-label', lastRow, 'LAST');
    this.last = new Text(el('span', 'hud-mono', lastRow, '--:--.---'));
    const bestRow = el('div', 'hud-row hud-small', timing);
    el('span', 'hud-label', bestRow, 'BEST');
    this.best = new Text(el('span', 'hud-mono hud-best', bestRow, '--:--.---'));

    const tele = el('div', 'hud-telemetry', this.root);
    const ledRow = el('div', 'hud-leds', tele);
    for (let i = 0; i < LEDS; i++) {
      const colour = i < 5 ? 'g' : i < 10 ? 'r' : 'b';
      this.leds.push(el('span', `hud-led hud-led-${colour}`, ledRow));
    }
    const dash = el('div', 'hud-dash', tele);
    const pedalL = el('div', 'hud-pedal', dash);
    this.brakeBar = el('div', 'hud-pedal-fill hud-brake', pedalL);
    const speedBox = el('div', 'hud-speedbox', dash);
    this.speed = new Text(el('div', 'hud-speed', speedBox, '0'));
    el('div', 'hud-unit', speedBox, 'KM/H');
    this.gear = new Text(el('div', 'hud-gear', dash, 'N'));
    const pedalR = el('div', 'hud-pedal', dash);
    this.throttleBar = el('div', 'hud-pedal-fill hud-throttle', pedalR);

    this.toast = el('div', 'hud-toast', this.root);

    // Minimap: the circuit is drawn once to an offscreen canvas; each frame only the dots are drawn on top.
    this.map = el('canvas', 'hud-map', this.root);
    const size = 180;
    const dpr = Math.min(window.devicePixelRatio, 2);
    this.map.width = this.map.height = size * dpr;
    this.mapCtx = this.map.getContext('2d')!;
    this.mapBase = document.createElement('canvas');
    this.mapBase.width = this.mapBase.height = size * dpr;
    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (let i = 0; i < track.count; i++) {
      minX = Math.min(minX, track.xs[i]);
      maxX = Math.max(maxX, track.xs[i]);
      minZ = Math.min(minZ, track.zs[i]);
      maxZ = Math.max(maxZ, track.zs[i]);
    }
    const pad = 14 * dpr;
    const scale = (size * dpr - 2 * pad) / Math.max(maxX - minX, maxZ - minZ);
    const ox = (size * dpr - (maxX - minX) * scale) / 2;
    const oz = (size * dpr - (maxZ - minZ) * scale) / 2;
    this.mapTransform = (x, z) => [ox + (x - minX) * scale, oz + (z - minZ) * scale];
    const b = this.mapBase.getContext('2d')!;
    b.lineJoin = 'round';
    b.beginPath();
    for (let i = 0; i <= track.count; i++) {
      const [px, py] = this.mapTransform(track.xs[i % track.count], track.zs[i % track.count]);
      if (i === 0) b.moveTo(px, py);
      else b.lineTo(px, py);
    }
    b.strokeStyle = 'rgba(0,0,0,0.55)';
    b.lineWidth = 7 * dpr;
    b.stroke();
    b.strokeStyle = 'rgba(255,255,255,0.85)';
    b.lineWidth = 3 * dpr;
    b.stroke();
    const [sx, sy] = this.mapTransform(track.xs[0], track.zs[0]);
    b.fillStyle = '#fff';
    b.fillRect(sx - 1.5 * dpr, sy - 6 * dpr, 3 * dpr, 12 * dpr);
  }

  show(visible: boolean): void {
    this.root.style.display = visible ? '' : 'none';
  }

  flash(message: string, kind: 'best' | 'bad' | 'info' = 'info', seconds = 2.5): void {
    this.toast.textContent = message;
    this.toast.className = `hud-toast hud-toast-${kind} hud-toast-on`;
    this.toastTimer = seconds;
  }

  onTiming(events: TimingEvent[]): void {
    for (const e of events) {
      if (e.type === 'lap') {
        if (e.personalBest) this.flash(`PERSONAL BEST  ${formatLapTime(e.record.time)}`, 'best', 3.5);
        else this.flash(`LAP ${e.record.lap}  ${formatLapTime(e.record.time)}${e.record.valid ? '' : '  (INVALID)'}`, 'info', 3);
      } else if (e.type === 'invalidated') {
        const why = e.reason === 'track-limits' ? 'TRACK LIMITS' : e.reason === 'reset' ? 'CAR RESET' : 'WRONG WAY';
        this.flash(`LAP INVALIDATED - ${why}`, 'bad');
      }
    }
  }

  update(dt: number, car: Car, timer: LapTimer, s: number, others: { x: number; z: number; colour: string }[] = []): void {
    // Timing.
    this.lap.set(timer.started ? `LAP ${timer.lap}` : 'OUT LAP');
    this.invalid.style.visibility = timer.started && !timer.valid ? 'visible' : 'hidden';
    this.time.set(timer.started ? formatLapTime(timer.lapTime) : '--:--.---');
    const d = timer.valid ? timer.delta(s) : null;
    this.delta.set(formatDelta(d));
    this.deltaNode.className = `hud-delta ${d === null ? '' : d < 0 ? 'hud-ahead' : 'hud-behind'}`;
    this.last.set(formatLapTime(timer.last?.time));
    this.best.set(formatLapTime(timer.best?.time));
    for (let i = 0; i < 3; i++) {
      const t = timer.currentSectors[i];
      let cls = 'hud-sector';
      if (timer.started && t !== undefined) {
        const best = timer.bestSectors[i];
        cls += best !== null && t <= best + 1e-6 ? ' hud-sector-pb' : ' hud-sector-slow';
      } else if (timer.started && i === timer.sector) {
        cls += ' hud-sector-live';
      }
      if (this.sectorNodes[i].className !== cls) this.sectorNodes[i].className = cls;
    }

    // Dash.
    this.speed.set(String(Math.round(car.speedKmh)));
    this.gear.set(car.gear < 0 ? 'R' : String(car.gear));
    this.throttleBar.style.transform = `scaleY(${car.throttle.toFixed(2)})`;
    this.brakeBar.style.transform = `scaleY(${car.brake.toFixed(2)})`;

    const lit = Math.max(0, Math.min(LEDS, Math.ceil(((car.rpm - SHIFT_LIGHT_START) / (car.spec.upshiftRpm - SHIFT_LIGHT_START)) * LEDS)));
    const blink = car.limiter && Math.floor(performance.now() / 70) % 2 === 0;
    const state = `${lit}-${blink}`;
    if (state !== this.ledState) {
      this.ledState = state;
      this.leds.forEach((led, i) => led.classList.toggle('on', !blink && i < lit));
    }

    // Toast.
    if (this.toastTimer > 0) {
      this.toastTimer -= dt;
      if (this.toastTimer <= 0) this.toast.classList.remove('hud-toast-on');
    }

    // Minimap.
    const ctx = this.mapCtx;
    const dpr = this.map.width / 180;
    ctx.clearRect(0, 0, this.map.width, this.map.height);
    ctx.drawImage(this.mapBase, 0, 0);
    for (const o of others) {
      const [ox, oy] = this.mapTransform(o.x, o.z);
      ctx.fillStyle = o.colour;
      ctx.beginPath();
      ctx.arc(ox, oy, 3.5 * dpr, 0, Math.PI * 2);
      ctx.fill();
    }
    const [px, py] = this.mapTransform(car.x, car.z);
    ctx.fillStyle = '#ff2d3d';
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 2 * dpr;
    ctx.beginPath();
    ctx.arc(px, py, 5 * dpr, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }
}
