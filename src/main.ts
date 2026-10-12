import './ui/hud.css';
import './ui/touch.css';
import './ui/menu.css';
import { CarAudio } from './audio/CarAudio.ts';
import { OpponentAudio } from './audio/OpponentAudio.ts';
import { Haptics } from './input/haptics.ts';
import { Game, PLAYER_ID } from './game/Game.ts';
import { LapTimer } from './game/LapTimer.ts';
import { findDrsZones, inZone } from './game/drs.ts';
import { Race, type RaceEntrant } from './game/Race.ts';
import { DIFFICULTY_CONSISTENCY, DIFFICULTY_PACE, loadSettings, saveSettings, type Settings } from './game/settings.ts';
import { loadBestLap, saveBestLap } from './game/storage.ts';
import { TEAMS, type Team } from './game/teams.ts';
import { Input } from './input/Input.ts';
import { COMPOUNDS, type TyreCompound } from './physics/tyre.ts';
import { QUALITY, type QualityTier } from './render/quality.ts';
import { HALDEN_RING } from './track/circuits.ts';
import { Track } from './track/Track.ts';
import { Hud } from './ui/hud.ts';
import { Menu, type SessionMode } from './ui/menu.ts';
import { TouchControls } from './ui/touch.ts';

type Mode = 'menu' | 'driving' | 'paused' | 'results';

/** Opponents per graphics tier: every car costs draw calls and physics. */
const OPPONENTS: Record<QualityTier, number> = { low: 5, medium: 7, high: 9, ultra: 9 };
/** Seconds between the player taking the flag and the results screen. */
const RESULTS_DELAY = 4;
/** Tyres come off the blankets at this temperature, below their window, so the first lap needs care. */
const BLANKET_TEMP = 80;
/** Race fuel: about 1.2 kg a lap on Halden Ring, plus a margin. */
const FUEL_PER_LAP = 1.35;
const FUEL_MARGIN = 1.5;
const TRIAL_FUEL = 12;

const container = document.getElementById('app')!;
const touchDevice = matchMedia('(pointer: coarse)').matches;
let settings = loadSettings();
const teamOf = (id: string) => TEAMS.find((t) => t.id === id) ?? TEAMS[0];
const hex = (n: number) => `#${n.toString(16).padStart(6, '0')}`;

const input = new Input();
const track = new Track(HALDEN_RING);
let timer = new LapTimer(track.length, track.sectorStarts, loadBestLap(track.id));
const hud = new Hud(document.body, track);
const touch = new TouchControls(document.body, input.touch);
touch.showPaddles(!settings.assists.autoGears);
const audio = new CarAudio();
audio.setVolume(settings.volume);
const rivalsAudio = new OpponentAudio(audio.ctx, audio.master, settings.quality === 'high' || settings.quality === 'ultra');
const haptics = new Haptics();
// Browsers only allow sound after the player interacts with the page.
const unlockAudio = () => void audio.resume();
for (const type of ['keydown', 'pointerdown', 'touchend'] as const) window.addEventListener(type, unlockAudio);

let mode: Mode = 'menu';
let session: SessionMode = 'trial';
let race: Race | null = null;
let resultsCountdown = -1;
const drsZones = findDrsZones(track);
const wasOff = new Set<string>();
let wingWarned = false;

const game = new Game({
  container,
  track,
  team: onCompound(teamOf(settings.teamId), COMPOUNDS[settings.compound]),
  quality: QUALITY[settings.quality],
  assists: settings.assists,
  input,
  onFrame(g, info) {
    if (mode !== 'driving') {
      // Gamepad and keyboard drive the menus: A confirms, Start/Esc backs out.
      if (info.input.pause) {
        if (menu.current === 'title' || menu.current === 'results') return;
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

    if (race) runRace(info.dt);
    updateDrs(info.input.drs);
    checkTrackLimits();
    if (g.car.wingDamage > 0.15 && !wingWarned) {
      wingWarned = true;
      hud.flash('FRONT WING DAMAGE', 'bad', 3);
    }
    if (info.input.reset) hud.onTiming(timer.invalidate('reset'));
    if (!g.held) {
      const events = timer.update(g.world.projection.s, info.dt, g.world.allWheelsOff(g.car));
      if (session === 'trial') {
        hud.onTiming(events);
        for (const e of events) if (e.type === 'lap' && e.personalBest) saveBestLap(track.id, e.record);
      } else {
        // In a race the lap toasts would bury the race messages; only flag invalid laps.
        hud.onTiming(events.filter((e) => e.type === 'invalidated'));
      }
    }
    hud.update(info.dt, g.car, timer, g.world.projection.s, opponentDots());
    audio.update(g.car, info.dt, info.kerb, info.impact);
    if (race) {
      const rivals = g.field.cars.filter((fc) => fc.driver).map((fc) => fc.car);
      rivalsAudio.update(g.rig.camera, rivals, info.dt);
    }
    haptics.update(g.car, info.kerb, info.impact, info.dt);
  },
});

function runRace(dt: number): void {
  if (!race) return;
  for (const e of race.update(dt, (id) => game.sOf(id))) {
    if (e.type === 'light') hud.setLights(e.count, false);
    else if (e.type === 'lightsOut') {
      hud.setLights(0, true);
      hud.flash('GO GO GO', 'best', 1.5);
    } else if (e.type === 'lap' && e.entrant.isPlayer && e.lap === race.laps - 1) {
      hud.flash('FINAL LAP', 'info', 2.5);
    } else if (e.type === 'finish' && e.entrant.isPlayer) {
      hud.flash(e.position === 1 ? 'CHEQUERED FLAG - YOU WIN!' : `CHEQUERED FLAG - P${e.position}`, e.position === 1 ? 'best' : 'info', RESULTS_DELAY);
      resultsCountdown = RESULTS_DELAY;
    }
  }
  game.held = race.held;
  hud.updateRace(dt, race, PLAYER_ID);
  if (resultsCountdown > 0) {
    resultsCountdown -= dt;
    if (resultsCountdown <= 0) {
      menu.setResults(race.standings());
      setMode('results');
    }
  }
}

/**
 * DRS: in a race a car may open the flap only in a zone it was cleared for at detection; in Time Trial, as in
 * qualifying, in every zone. The player toggles it; AI drivers open it whenever allowed. Braking closes it.
 */
function updateDrs(toggle: boolean): void {
  const s = game.world.projection.s;
  const available = game.held ? false : race ? race.drsAvailable(PLAYER_ID, s) : drsZones.some((z) => inZone(track, z, s));
  if (!available) game.car.drsOpen = false;
  else if (toggle) game.car.drsOpen = !game.car.drsOpen;
  hud.setDrs(available, game.car.drsOpen);
  touch.setDrs(available, game.car.drsOpen);
  if (!race) return;
  for (const fc of game.field.cars) {
    if (fc.driver) fc.car.drsOpen = race.drsAvailable(fc.id, fc.world.projection.s);
  }
}

/** One offence per trip off the track with all four wheels, for every car. */
function checkTrackLimits(): void {
  if (!race || race.held) return;
  for (const fc of game.field.cars) {
    const off = fc.world.allWheelsOff(fc.car);
    if (off && !wasOff.has(fc.id)) {
      for (const e of race.trackLimits(fc.id)) {
        if (e.type !== 'trackLimits' || !e.entrant.isPlayer) continue;
        if (e.penalty === 0) hud.flash(`TRACK LIMITS - WARNING ${e.warnings}/3`, 'bad', 2.5);
        else hud.flash(`TRACK LIMITS - 5 SECOND PENALTY (${e.penalty}s TOTAL)`, 'bad', 3);
      }
    }
    if (off) wasOff.add(fc.id);
    else wasOff.delete(fc.id);
  }
}

function opponentDots(): { x: number; z: number; colour: string }[] {
  if (!race) return [];
  return game.field.cars
    .filter((fc) => fc.driver)
    .map((fc) => ({ x: fc.car.x, z: fc.car.z, colour: entrantColour.get(fc.id) ?? '#ccc' }));
}

const entrantColour = new Map<string, string>();

const menu = new Menu(document.body, settings, track.name, {
  onDrive(next) {
    void audio.resume();
    // Touch steering starts as drag; tilt needs motion permission, which iOS only grants from a tap like this one.
    if (touchDevice && settings.touchSteering === 'tilt') {
      void touch.setSteering('tilt').then((ok) => {
        if (!ok) hud.flash('TILT UNAVAILABLE - USING DRAG STEERING', 'bad');
      });
    }
    startSession(next);
  },
  onResume() {
    setMode('driving');
  },
  onRestart() {
    startSession(session);
  },
  onQuit() {
    race = null;
    game.held = false;
    game.clearOpponents();
    game.toGrid(0);
    setMode('menu');
  },
  onTeam(team) {
    settings = { ...settings, teamId: team.id };
    saveSettings(settings);
    game.setTeam(onCompound(team, COMPOUNDS[settings.compound]));
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
    if (changed === 'compound') game.setTeam(onCompound(teamOf(settings.teamId), COMPOUNDS[settings.compound]));
    touch.showPaddles(!settings.assists.autoGears);
    audio.setVolume(settings.volume);
    return true;
  },
});

/** A team's livery with the sidewall band of the tyres fitted. */
function onCompound(team: Team, compound: TyreCompound): Team {
  return { ...team, livery: { ...team.livery, compound: compound.colour } };
}

/** Rivals split their tyre choice the way a real grid does: mostly mediums, some softs, a few hards. */
function pickCompound(): TyreCompound {
  const r = Math.random();
  return r < 0.3 ? COMPOUNDS.soft : r < 0.8 ? COMPOUNDS.medium : COMPOUNDS.hard;
}

const codeOf = (name: string) => name.split(' ').pop()!.slice(0, 3).toUpperCase();

function startSession(next: SessionMode): void {
  session = next;
  timer = new LapTimer(track.length, track.sectorStarts, timer.best);
  resultsCountdown = -1;
  game.clearOpponents();
  race = null;
  game.held = false;

  wasOff.clear();
  wingWarned = false;
  rivalsAudio.silence();

  if (next === 'trial') {
    game.toGrid(0);
    prepareCars(TRIAL_FUEL);
    hud.setRaceMode(false, 0, 0);
    setMode('driving');
    hud.flash('CROSS THE LINE TO START YOUR LAP', 'info', 3);
    return;
  }

  // Quick race: rivals from the other teams first, then team-mates, on a shuffled grid with the player mid-pack.
  const mine = teamOf(settings.teamId);
  const pool: { team: Team; name: string }[] = [
    ...TEAMS.filter((t) => t !== mine).map((t) => ({ team: t, name: t.drivers[0] })),
    ...TEAMS.map((t) => ({ team: t, name: t.drivers[1] })),
  ];
  const count = OPPONENTS[settings.quality];
  const rivals = pool.slice(0, count);
  const total = count + 1;
  const playerSlot = Math.min(total - 1, Math.ceil(total / 2));
  const slots = Array.from({ length: total }, (_, i) => i).filter((s) => s !== playerSlot);
  for (let i = slots.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [slots[i], slots[j]] = [slots[j], slots[i]];
  }
  const [lo, hi] = DIFFICULTY_PACE[settings.difficulty];
  const compounds = rivals.map(() => pickCompound());
  const opponents = rivals.map((r, i) => ({
    id: `ai-${i}`,
    team: onCompound(r.team, compounds[i]),
    slot: slots[i],
    skill: {
      pace: lo + Math.random() * (hi - lo),
      laneOffset: 0,
      consistency: DIFFICULTY_CONSISTENCY[settings.difficulty] + (Math.random() - 0.5) * 0.1,
      seed: Math.floor(Math.random() * 1e9),
    },
  }));
  game.setupOpponents(opponents, playerSlot);

  entrantColour.clear();
  const entrants: RaceEntrant[] = [
    { id: PLAYER_ID, name: 'You', code: 'YOU', teamName: mine.name, colour: hex(mine.livery.primary), isPlayer: true },
    ...opponents.map((o, i) => {
      const colour = hex(o.team.livery.primary);
      entrantColour.set(o.id, colour);
      return { id: o.id, name: rivals[i].name, code: codeOf(rivals[i].name), teamName: o.team.name, colour, isPlayer: false };
    }),
  ];
  prepareCars(settings.raceLaps * FUEL_PER_LAP + FUEL_MARGIN, (id) => compounds[opponents.findIndex((o) => o.id === id)]);
  race = new Race(track.length, settings.raceLaps, entrants, entrants.map((e) => game.sOf(e.id)), {
    drsZones,
    // Real races enable DRS two laps in; short races get it a lap earlier so it comes into play.
    drsFromLap: settings.raceLaps <= 3 ? 2 : 3,
  });
  game.held = true;
  hud.setRaceMode(true, total, settings.raceLaps);
  setMode('driving');
}

/** Fresh tyres off the blankets, a fuel load for the session, and an undamaged car for everyone. */
function prepareCars(fuel: number, rivalCompound: (id: string) => TyreCompound = () => COMPOUNDS.medium): void {
  for (const fc of game.field.cars) {
    fc.car.setTyres(BLANKET_TEMP, 0, fc.driver ? rivalCompound(fc.id) : COMPOUNDS[settings.compound]);
    fc.car.fuel = fuel;
    fc.car.wingDamage = 0;
    fc.car.drsOpen = false;
  }
}

function setMode(next: Mode): void {
  mode = next;
  game.paused = next !== 'driving';
  game.showcase = next === 'menu';
  hud.show(next === 'driving' || next === 'paused');
  touch.show(touchDevice && next === 'driving');
  audio.setMuted(next !== 'driving');
  if (next === 'menu') {
    menu.setBestLap(timer.best?.time ?? null);
    menu.show('title');
  } else if (next === 'paused') {
    menu.show('pause');
  } else if (next === 'results') {
    menu.show('results');
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

// Offline play and home-screen install. Only in production builds, so development always loads fresh code.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => void navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`));
}

// Exposed for debugging in the browser console during development.
if (import.meta.env.DEV) Object.assign(window, { game, getTimer: () => timer, getRace: () => race, setMode });
