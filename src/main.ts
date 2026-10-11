import './ui/hud.css';
import './ui/touch.css';
import './ui/menu.css';
import { CarAudio } from './audio/CarAudio.ts';
import { Game } from './game/Game.ts';
import { LapTimer } from './game/LapTimer.ts';
import { loadSettings, saveSettings, type Settings } from './game/settings.ts';
import { loadBestLap, saveBestLap } from './game/storage.ts';
import { TEAMS } from './game/teams.ts';
import { Input } from './input/Input.ts';
import { QUALITY } from './render/quality.ts';
import { HALDEN_RING } from './track/circuits.ts';
import { Track } from './track/Track.ts';
import { Hud } from './ui/hud.ts';
import { Menu } from './ui/menu.ts';
import { TouchControls } from './ui/touch.ts';

type Mode = 'menu' | 'driving' | 'paused';

const container = document.getElementById('app')!;
const touchDevice = matchMedia('(pointer: coarse)').matches;
let settings = loadSettings();
const teamOf = (id: string) => TEAMS.find((t) => t.id === id) ?? TEAMS[0];

const input = new Input();
const track = new Track(HALDEN_RING);
let timer = new LapTimer(track.length, track.sectorStarts, loadBestLap(track.id));
const hud = new Hud(document.body, track);
const touch = new TouchControls(document.body, input.touch);
touch.showPaddles(!settings.assists.autoGears);
const audio = new CarAudio();
audio.setVolume(settings.volume);
// Browsers only allow sound after the player interacts with the page.
const unlockAudio = () => void audio.resume();
for (const type of ['keydown', 'pointerdown', 'touchend'] as const) window.addEventListener(type, unlockAudio);

let mode: Mode = 'menu';

const game = new Game({
  container,
  track,
  team: teamOf(settings.teamId),
  quality: QUALITY[settings.quality],
  assists: settings.assists,
  input,
  onFrame(g, info) {
    if (mode === 'menu' || mode === 'paused') {
      // Gamepad and keyboard drive the menus: A confirms, Start/Esc backs out.
      if (info.input.pause) {
        if (menu.current === 'title') return;
        menu.back();
      } else if (info.input.shiftUp && info.input.source === 'gamepad') {
        menu.confirm();
      }
      return;
    }

    if (info.input.pause) {
      setMode('paused');
      return;
    }
    if (info.input.reset) hud.onTiming(timer.invalidate('reset'));
    const events = timer.update(g.world.projection.s, info.dt, g.world.allWheelsOff(g.car));
    hud.onTiming(events);
    for (const e of events) {
      if (e.type === 'lap' && e.personalBest) saveBestLap(track.id, e.record);
    }
    hud.update(info.dt, g.car, timer, g.world.projection.s);
    audio.update(g.car, info.dt, info.kerb, info.impact);
  },
});

const menu = new Menu(document.body, settings, track.name, {
  onDrive() {
    void audio.resume();
    // Touch steering starts as drag; tilt needs motion permission, which iOS only grants from a tap like this one.
    if (touchDevice && settings.touchSteering === 'tilt') {
      void touch.setSteering('tilt').then((ok) => {
        if (!ok) hud.flash('TILT UNAVAILABLE - USING DRAG STEERING', 'bad');
      });
    }
    startSession();
  },
  onResume() {
    setMode('driving');
  },
  onRestart() {
    startSession();
  },
  onQuit() {
    game.toGrid(0);
    setMode('menu');
  },
  onTeam(team) {
    settings = { ...settings, teamId: team.id };
    saveSettings(settings);
    game.setTeam(team);
  },
  async onSettings(next: Settings, changed) {
    if (changed === 'touchSteering') {
      // Asking for motion access has to happen inside this tap on iOS.
      const ok = await touch.setSteering(next.touchSteering);
      if (!ok) {
        hud.flash('TILT STEERING IS NOT AVAILABLE ON THIS DEVICE', 'bad');
        return false;
      }
    }
    settings = next;
    saveSettings(settings);
    if (changed === 'quality') {
      location.reload();
      return true;
    }
    game.car.assists = { ...settings.assists };
    touch.showPaddles(!settings.assists.autoGears);
    audio.setVolume(settings.volume);
    return true;
  },
});

function startSession(): void {
  timer = new LapTimer(track.length, track.sectorStarts, timer.best);
  game.toGrid(0);
  setMode('driving');
  hud.flash('CROSS THE LINE TO START YOUR LAP', 'info', 3);
}

function setMode(next: Mode): void {
  mode = next;
  game.paused = next !== 'driving';
  game.showcase = next === 'menu';
  hud.show(next !== 'menu');
  touch.show(touchDevice && next === 'driving');
  audio.setMuted(next !== 'driving');
  if (next === 'menu') {
    menu.setBestLap(timer.best?.time ?? null);
    menu.show('title');
  } else if (next === 'paused') {
    menu.show('pause');
  } else {
    menu.show('none');
  }
}

// Leaving the tab or app pauses the session.
document.addEventListener('visibilitychange', () => {
  if (document.hidden && mode === 'driving') setMode('paused');
});

setMode('menu');
game.start();

// Exposed for debugging in the browser console during development.
if (import.meta.env.DEV) Object.assign(window, { game, getTimer: () => timer, setMode });
