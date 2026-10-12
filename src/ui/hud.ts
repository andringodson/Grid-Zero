import { formatDelta, formatLapTime, type LapTimer, type TimingEvent } from '../game/LapTimer.ts';
import type { Race } from '../game/Race.ts';
import type { Car } from '../physics/Car.ts';
import type { Track } from '../track/Track.ts';

const LEDS = 15;
const SHIFT_LIGHT_START = 10400;

/** Blue when cold, green in the window, through amber to red when overheating. */
function tyreColour(temp: number, optimal: number): string {
  const d = temp - optimal;
  if (d < -25) return '#3d7bff';
  if (d < -10) return '#3dc4d6';
  if (d <= 12) return '#3ddc84';
  if (d <= 25) return '#ffcc33';
  return '#ff3b30';
}

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
  private readonly posBox: HTMLElement;
  private readonly pos: Text;
  private readonly posOf: Text;
  private readonly raceLap: Text;
  private readonly tower: HTMLElement;
  private readonly lights: HTMLElement;
  private readonly lamps: HTMLElement[] = [];
  private towerClock = 0;
  private raceMode = false;
  private totalLaps = 0;
  private readonly drs: HTMLElement;
  private drsState = '';
  private readonly tyres: HTMLElement[] = [];
  private readonly tyreWear: HTMLElement[] = [];
  private readonly fuel: Text;
  private tyreClock = 0;
  private readonly ersBar: HTMLElement;

  constructor(parent: HTMLElement, track: Track) {
    this.root = el('div', 'hud', parent);

    const timing = el('div', 'hud-panel hud-timing', this.root);
    this.posBox = el('div', 'hud-pos', timing);
    this.pos = new Text(el('span', 'hud-pos-n', this.posBox, 'P1'));
    this.posOf = new Text(el('span', 'hud-pos-of', this.posBox, '/1'));
    this.raceLap = new Text(el('span', 'hud-pos-lap', this.posBox, 'LAP 1/3'));
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
    this.drs = el('div', 'hud-drs', dash, 'DRS');
    const pedalL = el('div', 'hud-pedal', dash);
    this.brakeBar = el('div', 'hud-pedal-fill hud-brake', pedalL);
    const speedBox = el('div', 'hud-speedbox', dash);
    this.speed = new Text(el('div', 'hud-speed', speedBox, '0'));
    el('div', 'hud-unit', speedBox, 'KM/H');
    this.gear = new Text(el('div', 'hud-gear', dash, 'N'));
    const pedalR = el('div', 'hud-pedal', dash);
    this.throttleBar = el('div', 'hud-pedal-fill hud-throttle', pedalR);
    // Tyres seen from above: colour is surface temperature, the bar inside is tread left.
    const tyres = el('div', 'hud-tyres', dash);
    const grid = el('div', 'hud-tyre-grid', tyres);
    for (let w = 0; w < 4; w++) {
      const t = el('div', 'hud-tyre', grid);
      this.tyreWear.push(el('div', 'hud-tyre-wear', t));
      this.tyres.push(t);
    }
    this.fuel = new Text(el('div', 'hud-fuel', tyres, ''));
    // Hybrid battery: fills under braking, drains as the motor deploys.
    const ers = el('div', 'hud-ers', dash);
    ers.title = 'ERS battery';
    this.ersBar = el('div', 'hud-ers-fill', ers);

    this.tower = el('ol', 'hud-tower', this.root);
    this.lights = el('div', 'hud-lights', this.root);
    for (let i = 0; i < 5; i++) {
      const col = el('div', 'hud-lamp-col', this.lights);
      this.lamps.push(el('span', 'hud-lamp', col), el('span', 'hud-lamp', col));
    }
    this.toast = el('div', 'hud-toast', this.root);
    this.setRaceMode(false, 0, 0);

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

  /** DRS light: dark when unavailable, outlined when it can be opened, solid green while open. */
  setDrs(available: boolean, open: boolean): void {
    const state = open ? 'open' : available ? 'ready' : '';
    if (state === this.drsState) return;
    this.drsState = state;
    this.drs.className = `hud-drs ${state}`;
  }

  setRaceMode(on: boolean, cars: number, laps: number): void {
    this.raceMode = on;
    this.totalLaps = laps;
    this.posBox.style.display = on ? '' : 'none';
    this.tower.style.display = on ? '' : 'none';
    this.posOf.set(`/${cars}`);
    this.setLights(0, !on);
  }

  /** Start gantry: `lit` red columns; hidden once the race is under way. */
  setLights(lit: number, hidden: boolean): void {
    this.lights.style.display = hidden ? 'none' : '';
    this.lamps.forEach((lamp, i) => lamp.classList.toggle('on', Math.floor(i / 2) < lit));
  }

  updateRace(dt: number, race: Race, playerId: string): void {
    if (!this.raceMode) return;
    const me = race.standing(playerId);
    this.pos.set(`P${race.position(playerId)}`);
    this.raceLap.set(me.finished ? 'FINISHED' : `LAP ${Math.max(1, Math.min(me.lap, this.totalLaps))}/${this.totalLaps}`);

    // The tower only needs refreshing a few times a second.
    this.towerClock -= dt;
    if (this.towerClock > 0) return;
    this.towerClock = 0.25;
    const rows = race.standings();
    this.tower.replaceChildren(
      ...rows.map((st, i) => {
        const li = document.createElement('li');
        li.className = `hud-tower-row${st.entrant.isPlayer ? ' me' : ''}`;
        const gap = i === 0 ? (st.finished ? 'WIN' : 'LEADER') : st.finished && rows[0].finishTime !== null ? `+${(st.finishTime! - rows[0].finishTime!).toFixed(1)}` : `+${st.gap.toFixed(1)}`;
        li.innerHTML = `<span class="p">${i + 1}</span><span class="c" style="background:${st.entrant.colour}"></span><span class="n">${st.entrant.code}</span><span class="g">${race.phase === 'lights' ? '' : gap}</span>`;
        return li;
      }),
    );
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
    this.ersBar.style.transform = `scaleY(${(car.ersCharge / car.spec.ersCapacity).toFixed(3)})`;
    this.ersBar.classList.toggle('deploying', car.ersFlow > 1000);
    this.ersBar.classList.toggle('harvesting', car.ersFlow < -1000);

    const lit = Math.max(0, Math.min(LEDS, Math.ceil(((car.rpm - SHIFT_LIGHT_START) / (car.spec.upshiftRpm - SHIFT_LIGHT_START)) * LEDS)));
    const blink = car.limiter && Math.floor(performance.now() / 70) % 2 === 0;
    const state = `${lit}-${blink}`;
    if (state !== this.ledState) {
      this.ledState = state;
      this.leds.forEach((led, i) => led.classList.toggle('on', !blink && i < lit));
    }

    // Tyres and fuel: a few updates a second is plenty.
    this.tyreClock -= dt;
    if (this.tyreClock <= 0) {
      this.tyreClock = 0.2;
      for (let w = 0; w < 4; w++) {
        this.tyres[w].style.background = tyreColour(car.tyreTemp[w], car.compound.optimalTemp);
        this.tyreWear[w].style.transform = `scaleY(${(1 - car.tyreWear[w]).toFixed(2)})`;
      }
      this.tyres[0].parentElement!.title = car.tyreTemp.map((t) => `${t.toFixed(0)}°C`).join(' ');
      this.fuel.set(`${car.fuel.toFixed(1)} kg`);
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
