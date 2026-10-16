import { formatLapTime } from '../game/LapTimer.ts';
import type { Standing } from '../game/Race.ts';
import { RACE_LAPS, type Difficulty, type Settings } from '../game/settings.ts';
import { TEAMS, type Team } from '../game/teams.ts';
import type { WeatherMode } from '../game/weather.ts';
import type { Assists } from '../physics/Car.ts';
import { COMPOUNDS } from '../physics/tyre.ts';
import { CIRCUITS } from '../track/circuits.ts';
import type { TimeOfDay } from '../render/environment.ts';
import type { QualityTier } from '../render/quality.ts';
import type { TouchSteering } from './touch.ts';

export type SessionMode = 'trial' | 'race';

export interface MenuCallbacks {
  onDrive(mode: SessionMode): void;
  onResume(): void;
  onRestart(): void;
  onQuit(): void;
  onTeam(team: Team): void;
  /** Applied immediately; returns false if the change could not be made (e.g. tilt permission refused). */
  onSettings(next: Settings, changed: keyof Settings): Promise<boolean> | boolean;
}

type Screen = 'title' | 'pause' | 'settings' | 'results' | 'none';

const hex = (n: number) => `#${n.toString(16).padStart(6, '0')}`;

const ASSIST_LABELS: [keyof Assists, string, string][] = [
  ['steering', 'Steering assist', 'Limits lock to what the tyres can use'],
  ['autoGears', 'Automatic gears', 'Shifts up and down for you'],
  ['tractionControl', 'Traction control', 'Stops wheelspin on the throttle'],
  ['abs', 'Anti-lock brakes', 'Stops the wheels locking under braking'],
];

export class Menu {
  readonly root: HTMLDivElement;
  private screen: Screen = 'none';
  private settingsReturn: Screen = 'title';
  private settings: Settings;
  private readonly cb: MenuCallbacks;
  private readonly touchDevice = matchMedia('(pointer: coarse)').matches;
  private readonly circuit: { name: string; length: number };
  private bestLap: number | null = null;

  constructor(parent: HTMLElement, settings: Settings, circuit: { name: string; length: number }, cb: MenuCallbacks) {
    this.settings = settings;
    this.circuit = circuit;
    this.cb = cb;
    this.root = document.createElement('div');
    this.root.className = 'menu';
    parent.appendChild(this.root);
  }

  get current(): Screen {
    return this.screen;
  }

  setBestLap(t: number | null): void {
    this.bestLap = t;
  }

  show(screen: Screen): void {
    this.screen = screen;
    this.root.className = `menu ${screen === 'none' ? '' : 'menu-on'} menu-screen-${screen}`;
    this.root.innerHTML = '';
    if (screen === 'title') this.renderTitle();
    else if (screen === 'pause') this.renderPause();
    else if (screen === 'settings') this.renderSettings();
    else if (screen === 'results') this.renderResults();
    // Keyboard and gamepad players start on the main action.
    this.root.querySelector<HTMLElement>('[data-primary]')?.focus({ preventScroll: true });
  }

  /** Activates the focused button, or the primary one: lets a gamepad's A button work in menus. */
  confirm(): void {
    const focused = document.activeElement;
    if (focused instanceof HTMLButtonElement && this.root.contains(focused)) focused.click();
    else this.root.querySelector<HTMLButtonElement>('[data-primary]')?.click();
  }

  /** Escape or the pause button: back out one level. */
  back(): void {
    if (this.screen === 'settings') this.show(this.settingsReturn);
    else if (this.screen === 'pause') this.cb.onResume();
  }

  private button(parent: HTMLElement, label: string, onClick: () => void, cls = 'menu-btn', primary = false): HTMLButtonElement {
    const b = document.createElement('button');
    b.className = cls;
    b.textContent = label;
    if (primary) b.dataset.primary = '';
    b.addEventListener('click', onClick);
    parent.appendChild(b);
    return b;
  }

  /**
   * The title screen as broadcast graphics: the wordmark top left, the menu as a column of tiles, the teams as a
   * timing tower on the right, and a lower third with the session: circuit, length, light, weather and best lap.
   */
  private renderTitle(): void {
    const head = document.createElement('header');
    head.className = 'menu-mark';
    head.innerHTML = '<span class="menu-mark-bar"></span><h1>GRID <b>ZERO</b></h1><p>OPEN-WHEEL RACING</p>';
    this.root.appendChild(head);

    const list = document.createElement('nav');
    list.className = 'menu-list';
    const item = (label: string, sub: string, onClick: () => void, primary = false) => {
      const b = this.button(list, '', onClick, 'menu-item', primary);
      b.innerHTML = `<span class="menu-item-label">${label}</span><span class="menu-item-sub">${sub}</span>`;
    };
    item('QUICK RACE', `${this.settings.raceLaps} LAPS · ${this.settings.difficulty.toUpperCase()} RIVALS`, () => this.cb.onDrive('race'), true);
    item('TIME TRIAL', this.bestLap === null ? 'SET A LAP TO QUALIFY' : 'BEAT YOUR GHOST', () => this.cb.onDrive('trial'));
    item('SETTINGS', 'CIRCUIT · WEATHER · TYRES · GRAPHICS', () => {
      this.settingsReturn = 'title';
      this.show('settings');
    });
    this.root.appendChild(list);

    // Teams as a timing tower: position box, colour bar, code, then the name; the chosen one highlighted white.
    const tower = document.createElement('div');
    tower.className = 'menu-tower';
    tower.setAttribute('role', 'radiogroup');
    tower.setAttribute('aria-label', 'Team');
    tower.innerHTML = '<div class="menu-tower-head">CHOOSE YOUR TEAM</div>';
    TEAMS.forEach((t, i) => {
      const b = document.createElement('button');
      b.className = 'menu-tower-row';
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', String(t.id === this.settings.teamId));
      b.innerHTML = `<span class="p">${i + 1}</span><span class="c" style="background:${hex(t.livery.primary)}"></span><span class="n">${t.name.toUpperCase()}</span><span class="d">${t.drivers[0].split(' ').pop()!.toUpperCase()}</span>`;
      b.addEventListener('click', () => {
        this.settings = { ...this.settings, teamId: t.id };
        tower.querySelectorAll('.menu-tower-row').forEach((r) => r.setAttribute('aria-checked', String(r === b)));
        this.cb.onTeam(t);
      });
      tower.appendChild(b);
    });
    this.root.appendChild(tower);

    const weather = { dry: 'DRY', wet: 'WET', changing: 'CHANGING' }[this.settings.weather];
    const light = { midday: 'MIDDAY', afternoon: 'AFTERNOON', sunset: 'SUNSET' }[this.settings.timeOfDay];
    const third = document.createElement('footer');
    third.className = 'menu-third';
    third.innerHTML = `
      <span class="menu-third-tab"></span>
      <span class="menu-third-name">${this.circuit.name.toUpperCase()}</span>
      <span>${(this.circuit.length / 1000).toFixed(3)} KM</span>
      <span>${light}</span>
      <span>${weather}</span>
      <span class="menu-third-best">BEST LAP <b>${formatLapTime(this.bestLap)}</b></span>`;
    this.root.appendChild(third);

    const help = document.createElement('p');
    help.className = 'menu-help';
    help.textContent = this.touchDevice
      ? 'DRAG ON THE LEFT TO STEER · PEDALS ON THE RIGHT'
      : 'W/S THROTTLE AND BRAKE · A/D STEER · C CAMERA · R RESET · ESC PAUSE · GAMEPADS WORK TOO';
    this.root.appendChild(help);
  }

  private renderPause(): void {
    const panel = document.createElement('div');
    panel.className = 'menu-panel';
    panel.innerHTML = '<h2><span></span>PAUSED</h2>';
    const actions = document.createElement('div');
    actions.className = 'menu-actions menu-actions-col';
    this.button(actions, 'RESUME', () => this.cb.onResume(), 'menu-btn menu-btn-primary', true);
    this.button(actions, 'RESTART SESSION', () => this.cb.onRestart());
    this.button(actions, 'SETTINGS', () => {
      this.settingsReturn = 'pause';
      this.show('settings');
    });
    this.button(actions, 'MAIN MENU', () => this.cb.onQuit());
    panel.appendChild(actions);
    this.root.appendChild(panel);
  }

  private renderSettings(): void {
    const panel = document.createElement('div');
    panel.className = 'menu-panel';
    panel.innerHTML = '<h2><span></span>SETTINGS</h2>';

    const apply = async (next: Settings, changed: keyof Settings) => {
      const ok = await this.cb.onSettings(next, changed);
      if (ok) this.settings = next;
      this.show('settings');
    };

    // Graphics quality.
    const quality = this.section(panel, 'Graphics', 'Higher settings look better but use more battery. Changing this reloads the game.');
    const seg = document.createElement('div');
    seg.className = 'menu-seg';
    for (const tier of ['low', 'medium', 'high', 'ultra'] as QualityTier[]) {
      const b = this.button(seg, tier.toUpperCase(), () => void apply({ ...this.settings, quality: tier }, 'quality'), 'menu-seg-btn');
      b.setAttribute('aria-pressed', String(this.settings.quality === tier));
    }
    quality.appendChild(seg);

    // Circuit.
    const circuitSection = this.section(panel, 'Circuit', 'Changing circuit reloads the game.');
    const circuits = document.createElement('div');
    circuits.className = 'menu-seg';
    for (const c of CIRCUITS) {
      const b = this.button(circuits, c.name.toUpperCase(), () => void apply({ ...this.settings, trackId: c.id }, 'trackId'), 'menu-seg-btn');
      b.setAttribute('aria-pressed', String(this.settings.trackId === c.id));
    }
    circuitSection.appendChild(circuits);

    // Race.
    const race = this.section(panel, 'Quick race', 'Opponent pace, and race length in laps.');
    const diff = document.createElement('div');
    diff.className = 'menu-seg';
    for (const d of ['easy', 'medium', 'hard'] as Difficulty[]) {
      const b = this.button(diff, d.toUpperCase(), () => void apply({ ...this.settings, difficulty: d }, 'difficulty'), 'menu-seg-btn');
      b.setAttribute('aria-pressed', String(this.settings.difficulty === d));
    }
    race.appendChild(diff);
    const laps = document.createElement('div');
    laps.className = 'menu-seg';
    laps.style.marginTop = '6px';
    for (const n of RACE_LAPS) {
      const b = this.button(laps, `${n} LAPS`, () => void apply({ ...this.settings, raceLaps: n }, 'raceLaps'), 'menu-seg-btn');
      b.setAttribute('aria-pressed', String(this.settings.raceLaps === n));
    }
    race.appendChild(laps);

    // Time of day.
    const timeSection = this.section(panel, 'Time of day', 'Sunset brings a low golden sun and long shadows. Changing it reloads the game.');
    const times = document.createElement('div');
    times.className = 'menu-seg';
    for (const [t, label] of [['midday', 'MIDDAY'], ['afternoon', 'AFTERNOON'], ['sunset', 'SUNSET']] as [TimeOfDay, string][]) {
      const b = this.button(times, label, () => void apply({ ...this.settings, timeOfDay: t }, 'timeOfDay'), 'menu-seg-btn');
      b.setAttribute('aria-pressed', String(this.settings.timeOfDay === t));
    }
    timeSection.appendChild(times);

    // Weather.
    const weather = this.section(panel, 'Weather', 'Changing starts dry and brings rain part-way through: time to think about tyres.');
    const sky = document.createElement('div');
    sky.className = 'menu-seg';
    for (const [mode, label] of [['dry', 'DRY'], ['wet', 'WET'], ['changing', 'CHANGING']] as [WeatherMode, string][]) {
      const b = this.button(sky, label, () => void apply({ ...this.settings, weather: mode }, 'weather'), 'menu-seg-btn');
      b.setAttribute('aria-pressed', String(this.settings.weather === mode));
    }
    weather.appendChild(sky);

    // Tyres.
    const tyres = this.section(
      panel,
      'Tyres',
      'Soft grips most but wears fastest; hard lasts but needs heat. Inters for a damp track, full wets for standing water.',
    );
    const compounds = document.createElement('div');
    compounds.className = 'menu-seg';
    for (const c of Object.values(COMPOUNDS)) {
      const b = this.button(compounds, c.name.toUpperCase(), () => void apply({ ...this.settings, compound: c.id }, 'compound'), 'menu-seg-btn');
      b.setAttribute('aria-pressed', String(this.settings.compound === c.id));
      b.style.boxShadow = `inset 0 -3px 0 #${c.colour.toString(16).padStart(6, '0')}`;
    }
    tyres.appendChild(compounds);

    // Assists.
    const assists = this.section(panel, 'Driving assists', 'Turn them off for the full challenge.');
    for (const [key, label, hint] of ASSIST_LABELS) {
      const row = document.createElement('label');
      row.className = 'menu-toggle';
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = this.settings.assists[key];
      input.addEventListener('change', () =>
        void apply({ ...this.settings, assists: { ...this.settings.assists, [key]: input.checked } }, 'assists'),
      );
      row.append(input);
      const text = document.createElement('span');
      text.innerHTML = `<strong>${label}</strong><small>${hint}</small>`;
      row.append(text);
      assists.appendChild(row);
    }

    // Volume.
    const sound = this.section(panel, 'Sound', '');
    const vol = document.createElement('input');
    vol.type = 'range';
    vol.min = '0';
    vol.max = '100';
    vol.value = String(Math.round(this.settings.volume * 100));
    vol.setAttribute('aria-label', 'Volume');
    vol.className = 'menu-range';
    vol.addEventListener('change', () => void apply({ ...this.settings, volume: Number(vol.value) / 100 }, 'volume'));
    sound.appendChild(vol);

    // Touch steering.
    if (this.touchDevice) {
      const steer = this.section(panel, 'Touch steering', 'Tilt steers by turning the phone like a wheel.');
      const s2 = document.createElement('div');
      s2.className = 'menu-seg';
      for (const mode of ['drag', 'tilt'] as TouchSteering[]) {
        const b = this.button(s2, mode === 'drag' ? 'DRAG' : 'TILT', () => void apply({ ...this.settings, touchSteering: mode }, 'touchSteering'), 'menu-seg-btn');
        b.setAttribute('aria-pressed', String(this.settings.touchSteering === mode));
      }
      steer.appendChild(s2);
    }

    const actions = document.createElement('div');
    actions.className = 'menu-actions';
    this.button(actions, 'BACK', () => this.show(this.settingsReturn), 'menu-btn menu-btn-primary', true);
    panel.appendChild(actions);
    this.root.appendChild(panel);
  }

  private results: Standing[] = [];

  setResults(results: Standing[]): void {
    this.results = results;
  }

  private renderResults(): void {
    const panel = document.createElement('div');
    panel.className = 'menu-panel menu-results';
    const me = this.results.findIndex((r) => r.entrant.isPlayer);
    // Classified times include any track-limits penalties.
    const classified = (r: Standing) => (r.finishTime === null ? null : r.finishTime + r.penalty);
    const winnerTime = this.results[0] ? classified(this.results[0]) : null;
    panel.innerHTML = `<h2><span></span>${me === 0 ? 'YOU WIN!' : `YOU FINISHED P${me + 1}`}</h2><p class="menu-results-sub">CLASSIFICATION · ${this.circuit.name.toUpperCase()}</p>`;
    const table = document.createElement('table');
    table.className = 'menu-table';
    table.innerHTML = '<thead><tr><th>POS</th><th>DRIVER</th><th>TEAM</th><th>TIME</th><th>BEST LAP</th></tr></thead>';
    const body = document.createElement('tbody');
    this.results.forEach((r, i) => {
      const tr = document.createElement('tr');
      if (r.entrant.isPlayer) tr.className = 'me';
      const t = classified(r);
      let time = i === 0 && t !== null ? formatLapTime(t) : r.finished && t !== null && winnerTime !== null ? `+${(t - winnerTime).toFixed(3)}` : 'Running';
      if (r.penalty > 0) time += ` (${r.penalty}s pen)`;
      const cells = [String(i + 1), r.entrant.name, r.entrant.teamName, time, formatLapTime(r.bestLap)];
      for (const [k, text] of cells.entries()) {
        const td = document.createElement('td');
        td.textContent = text;
        if (k === 1) td.style.borderLeft = `4px solid ${r.entrant.colour}`;
        tr.appendChild(td);
      }
      body.appendChild(tr);
    });
    table.appendChild(body);
    panel.appendChild(table);
    const actions = document.createElement('div');
    actions.className = 'menu-actions';
    this.button(actions, 'RACE AGAIN', () => this.cb.onDrive('race'), 'menu-btn menu-btn-primary', true);
    this.button(actions, 'MAIN MENU', () => this.cb.onQuit());
    panel.appendChild(actions);
    this.root.appendChild(panel);
  }

  private section(parent: HTMLElement, title: string, hint: string): HTMLElement {
    const s = document.createElement('section');
    s.className = 'menu-section';
    s.innerHTML = `<h3>${title}</h3>${hint ? `<p>${hint}</p>` : ''}`;
    parent.appendChild(s);
    return s;
  }
}
