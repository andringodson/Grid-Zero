import { formatLapTime } from '../game/LapTimer.ts';
import type { Settings } from '../game/settings.ts';
import { TEAMS, type Team } from '../game/teams.ts';
import type { Assists } from '../physics/Car.ts';
import type { QualityTier } from '../render/quality.ts';
import type { TouchSteering } from './touch.ts';

export interface MenuCallbacks {
  onDrive(): void;
  onResume(): void;
  onRestart(): void;
  onQuit(): void;
  onTeam(team: Team): void;
  /** Applied immediately; returns false if the change could not be made (e.g. tilt permission refused). */
  onSettings(next: Settings, changed: keyof Settings): Promise<boolean> | boolean;
}

type Screen = 'title' | 'pause' | 'settings' | 'none';

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
  private readonly trackName: string;
  private bestLap: number | null = null;

  constructor(parent: HTMLElement, settings: Settings, trackName: string, cb: MenuCallbacks) {
    this.settings = settings;
    this.trackName = trackName;
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

  private renderTitle(): void {
    const panel = document.createElement('div');
    panel.className = 'menu-title';
    panel.innerHTML = `
      <h1 class="menu-logo"><span>GRID</span> ZERO</h1>
      <p class="menu-sub">${this.trackName} · Time Trial</p>
      <p class="menu-best">Your best lap <strong>${formatLapTime(this.bestLap)}</strong></p>`;
    this.root.appendChild(panel);

    const teams = document.createElement('div');
    teams.className = 'menu-teams';
    teams.setAttribute('role', 'radiogroup');
    teams.setAttribute('aria-label', 'Team');
    const name = document.createElement('p');
    name.className = 'menu-team-name';
    const describe = (t: Team) => `${t.name} · ${t.drivers[0]}`;
    for (const t of TEAMS) {
      const b = document.createElement('button');
      b.className = 'menu-swatch';
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-label', t.name);
      b.setAttribute('aria-checked', String(t.id === this.settings.teamId));
      b.style.background = `linear-gradient(135deg, ${hex(t.livery.primary)} 0 62%, ${hex(t.livery.accent)} 62% 100%)`;
      b.addEventListener('click', () => {
        this.settings = { ...this.settings, teamId: t.id };
        teams.querySelectorAll('.menu-swatch').forEach((s) => s.setAttribute('aria-checked', String(s === b)));
        name.textContent = describe(t);
        this.cb.onTeam(t);
      });
      teams.appendChild(b);
    }
    name.textContent = describe(TEAMS.find((t) => t.id === this.settings.teamId) ?? TEAMS[0]);
    panel.appendChild(teams);
    panel.appendChild(name);

    const actions = document.createElement('div');
    actions.className = 'menu-actions';
    this.button(actions, 'DRIVE', () => this.cb.onDrive(), 'menu-btn menu-btn-primary', true);
    this.button(actions, 'SETTINGS', () => {
      this.settingsReturn = 'title';
      this.show('settings');
    });
    panel.appendChild(actions);

    const help = document.createElement('p');
    help.className = 'menu-help';
    help.textContent = this.touchDevice
      ? 'Drag on the left to steer, pedals on the right.'
      : 'W/S or arrows: throttle and brake · A/D: steer · C: camera · R: reset · Esc: pause · Gamepads work too';
    panel.appendChild(help);
  }

  private renderPause(): void {
    const panel = document.createElement('div');
    panel.className = 'menu-panel';
    panel.innerHTML = '<h2>PAUSED</h2>';
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
    panel.innerHTML = '<h2>SETTINGS</h2>';

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

  private section(parent: HTMLElement, title: string, hint: string): HTMLElement {
    const s = document.createElement('section');
    s.className = 'menu-section';
    s.innerHTML = `<h3>${title}</h3>${hint ? `<p>${hint}</p>` : ''}`;
    parent.appendChild(s);
    return s;
  }
}
