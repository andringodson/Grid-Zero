import './ui/hud.css';
import './ui/touch.css';
import './ui/menu.css';
import { CarAudio } from './audio/CarAudio.ts';
import { OpponentAudio } from './audio/OpponentAudio.ts';
import { Haptics } from './input/haptics.ts';
import { Game, PLAYER_ID } from './game/Game.ts';
import { aiLapTime, gridSlots, idealLap } from './game/grid.ts';
import { formatLapTime, LapTimer } from './game/LapTimer.ts';
import { findDrsZones, inZone } from './game/drs.ts';
import { Race, type RaceEntrant } from './game/Race.ts';
import { DIFFICULTY_CONSISTENCY, DIFFICULTY_PACE, loadSettings, saveSettings, type Settings } from './game/settings.ts';
import { GhostRecorder, ghostPose, type GhostLap, type GhostPose } from './game/ghost.ts';
import { aiPitCall, BLANKET_TEMP, PIT_APPROACH, pitU, tyresFor, wrongTyres } from './game/pits.ts';
import { loadBestLap, loadGhost, saveBestLap, saveGhost } from './game/storage.ts';
import { TEAMS, type Team } from './game/teams.ts';
import { Weather } from './game/weather.ts';
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
/** Time Trial ghost: the personal best lap, replayed as a see-through car. */
const recorder = new GhostRecorder();
let ghostLap: GhostLap | null = loadGhost(track.id);
const ghostScratch: GhostPose = { x: 0, y: 0, z: 0, yaw: 0, pitch: 0, roll: 0 };
/** This session's weather; the menu backdrop shows how the chosen weather starts. */
let weather = new Weather(settings.weather);
let rainAnnounced = false;

const game = new Game({
  container,
  track,
  team: liveryFor(teamOf(settings.teamId), 0, COMPOUNDS[settings.compound]),
  quality: QUALITY[settings.quality],
  assists: settings.assists,
  input,
  onFrame(g, info) {
    if (mode === 'driving') updateWeather(info.dt);
    g.field.wetness = weather.wetness;
    g.setWeather(weather.cloud, weather.rain, weather.wetness);
    audio.rain = weather.rain;
    audio.wetness = weather.wetness;
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
    updatePits();
    updateDrs(info.input.drs);
    checkTrackLimits();
    if (g.car.wingDamage > 0.15 && !wingWarned) {
      wingWarned = true;
      hud.flash('FRONT WING DAMAGE - PIT FOR A NEW NOSE', 'bad', 3);
    }
    if (info.input.reset) hud.onTiming(timer.invalidate('reset'));
    if (!g.held) {
      const events = timer.update(g.world.projection.s, info.dt, g.world.allWheelsOff(g.car));
      if (session === 'trial') {
        hud.onTiming(events);
        for (const e of events) {
          if (e.type !== 'lap') continue;
          // The lap just finished becomes the ghost if it's a personal best; recording starts over either way.
          if (e.personalBest) {
            saveBestLap(track.id, e.record);
            ghostLap = recorder.finish(e.record.time);
            saveGhost(track.id, ghostLap);
          }
          recorder.reset();
        }
        if (timer.started) {
          recorder.add(timer.lapTime, g.car);
          const pose = ghostLap && timer.lap > 0 ? ghostPose(ghostLap, timer.lapTime, ghostScratch) : null;
          g.setGhost(pose, g.playerLivery);
        }
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

/** Weather moves on while the session runs; the first drops of a changing session get a warning. */
function updateWeather(dt: number): void {
  weather.update(dt);
  if (!rainAnnounced && weather.rain > 0.04) {
    rainAnnounced = true;
    hud.flash('RAIN IS FALLING - GRIP WILL DROP', 'bad', 3.5);
  }
}

let lastPitPhase: 'in' | 'service' | 'out' | null = null;
let boxCalled = false;

/**
 * Pit calls. Rivals come in when their tyres are wrong for the track or their nose is broken (never on the last
 * lap); the player gets the radio call, and a message at each stage of their own stop.
 */
function updatePits(): void {
  if (race && !race.held) {
    for (const fc of game.field.cars) {
      if (!fc.driver || fc.pit || fc.pitRequest || race.standing(fc.id).lap >= race.laps) continue;
      const u = pitU(track, fc.world.projection.s);
      if (u < -PIT_APPROACH - 60 || u > -PIT_APPROACH) continue;
      const tyres = aiPitCall(fc.id, fc.car, weather.wetness);
      if (tyres) game.field.requestPit(fc, tyres);
    }
  }
  const pit = game.playerPit;
  const phase = pit?.phase ?? null;
  if (phase !== lastPitPhase) {
    if (phase === 'in') hud.flash('PIT LANE - SPEED LIMITER ON', 'info', 3);
    else if (phase === 'out' && pit) {
      const work = `${pit.compound.name.toUpperCase()}S${pit.nose ? ' AND A NEW NOSE' : ''}`;
      hud.flash(`${pit.stopTime.toFixed(1)} s STOP - ${work}`, 'best', 3);
    }
    lastPitPhase = phase;
  }
  // The radio call, once, when the tyres fitted become the wrong ones for the track.
  const wrong = !pit && wrongTyres(weather.wetness, game.car.compound);
  if (wrong && !boxCalled) {
    hud.flash(`BOX BOX - ${tyresFor(weather.wetness, game.car.compound, drySlick()).name.toUpperCase()}S READY`, 'bad', 4);
  }
  boxCalled = wrong;
}

/** The player's dry tyre for a stop: their chosen slick, or mediums if they chose a rain tyre. */
function drySlick(): TyreCompound {
  const chosen = COMPOUNDS[settings.compound];
  return chosen.id !== 'inter' && chosen.id !== 'wet' ? chosen : COMPOUNDS.medium;
}

function runRace(dt: number): void {
  if (!race) return;
  for (const e of race.update(dt, (id) => game.sOf(id))) {
    if (e.type === 'light') {
      hud.setLights(e.count, false);
      game.setStartLights(e.count);
    } else if (e.type === 'lightsOut') {
      hud.setLights(0, true);
      game.setStartLights(0);
      hud.flash('GO GO GO', 'best', 1.5);
    } else if (e.type === 'lap' && e.entrant.isPlayer && e.lap === race.laps - 1) {
      hud.flash('FINAL LAP', 'info', 2.5);
    } else if (e.type === 'finish' && e.entrant.isPlayer) {
      hud.flash(e.position === 1 ? 'CHEQUERED FLAG - YOU WIN!' : `CHEQUERED FLAG - P${e.position}`, e.position === 1 ? 'best' : 'info', RESULTS_DELAY);
      resultsCountdown = RESULTS_DELAY;
    }
  }
  game.held = race.held;
  hud.updateRace(dt, race, PLAYER_ID, (id) => game.field.cars.some((fc) => fc.id === id && fc.pit !== null));
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
  const inPits = game.playerPit !== null;
  const available = game.held || inPits ? false : race ? race.drsAvailable(PLAYER_ID, s) : drsZones.some((z) => inZone(track, z, s));
  if (!available) game.car.drsOpen = false;
  else if (toggle) game.car.drsOpen = !game.car.drsOpen;
  hud.setDrs(available, game.car.drsOpen);
  touch.setDrs(available, game.car.drsOpen);
  if (!race) return;
  for (const fc of game.field.cars) {
    if (fc.driver) fc.car.drsOpen = !fc.pit && race.drsAvailable(fc.id, fc.world.projection.s);
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
    game.setTeam(liveryFor(team, 0, COMPOUNDS[settings.compound]));
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
    if (changed === 'weather') weather = new Weather(settings.weather);
    // The car in the menu wears the tyres it would start on.
    if (changed === 'compound' || changed === 'weather') game.car.setTyres(BLANKET_TEMP, 0, playerCompound());
    touch.showPaddles(!settings.assists.autoGears);
    audio.setVolume(settings.volume);
    return true;
  },
});

/** A team's livery with the sidewall band of the tyres fitted. */
/** A team's livery for one of its cars: the driver's race number and the sidewall band of the tyres fitted. */
function liveryFor(team: Team, driver: 0 | 1, compound: TyreCompound): Team {
  return { ...team, livery: { ...team.livery, compound: compound.colour, number: team.numbers[driver] } };
}

/**
 * Rivals split their tyre choice the way a real grid does: in the dry mostly mediums, some softs, a few hards; in
 * the wet full wets, with a few gambling on inters.
 */
function pickCompound(): TyreCompound {
  const r = Math.random();
  if (weather.wetness > 0.5) return r < 0.8 ? COMPOUNDS.wet : COMPOUNDS.inter;
  if (weather.wetness > 0.15) return COMPOUNDS.inter;
  return r < 0.3 ? COMPOUNDS.soft : r < 0.8 ? COMPOUNDS.medium : COMPOUNDS.hard;
}

/** The player's tyres: their choice, except that no team sends a car out on slicks into standing water. */
function playerCompound(): TyreCompound {
  const chosen = COMPOUNDS[settings.compound];
  const slick = chosen.id !== 'inter' && chosen.id !== 'wet';
  return slick && weather.wetness > 0.5 ? COMPOUNDS.wet : chosen;
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
  game.setStartLights(0);
  rivalsAudio.silence();

  recorder.reset();
  game.setGhost(null, game.playerLivery);
  weather = new Weather(settings.weather);
  rainAnnounced = weather.rain > 0;
  lastPitPhase = null;
  boxCalled = false;
  const tyres = playerCompound();
  game.setTeam(liveryFor(teamOf(settings.teamId), 0, tyres));
  const wetsFitted = tyres !== COMPOUNDS[settings.compound];
  if (next === 'trial') {
    game.toGrid(0);
    prepareCars(TRIAL_FUEL);
    hud.setRaceMode(false, 0, 0);
    setMode('driving');
    hud.flash(wetsFitted ? 'WET TRACK - FULL WETS FITTED' : 'CROSS THE LINE TO START YOUR LAP', 'info', 3);
    return;
  }

  // Quick race: rivals from the other teams first, then team-mates, on a grid set by qualifying pace.
  const mine = teamOf(settings.teamId);
  const pool: { team: Team; name: string; driver: 0 | 1 }[] = [
    ...TEAMS.filter((t) => t !== mine).map((t) => ({ team: t, name: t.drivers[0], driver: 0 as const })),
    ...TEAMS.map((t) => ({ team: t, name: t.drivers[1], driver: 1 as const })),
  ];
  const count = OPPONENTS[settings.quality];
  const rivals = pool.slice(0, count);
  const total = count + 1;
  const [lo, hi] = DIFFICULTY_PACE[settings.difficulty];
  const skills = rivals.map(() => ({
    pace: lo + Math.random() * (hi - lo),
    laneOffset: 0,
    consistency: DIFFICULTY_CONSISTENCY[settings.difficulty] + (Math.random() - 0.5) * 0.1,
    seed: Math.floor(Math.random() * 1e9),
  }));
  // Qualifying: rivals' laps from their pace, give or take a few tenths on the day; the player's from their best
  // Time Trial lap, or the back of the grid without one.
  const best = timer.best?.time ?? Infinity;
  const slots = gridSlots([best, ...skills.map((s) => aiLapTime(IDEAL_LAP, s.pace) + (Math.random() - 0.5) * 0.6)]);
  const playerSlot = slots[0];
  const compounds = rivals.map(() => pickCompound());
  const opponents = rivals.map((r, i) => ({
    id: `ai-${i}`,
    team: liveryFor(r.team, r.driver, compounds[i]),
    slot: slots[i + 1],
    skill: skills[i],
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
  hud.flash(
    best < Infinity ? `GRID P${playerSlot + 1} - QUALIFIED ${formatLapTime(best)}` : 'NO TIME TRIAL LAP - STARTING FROM THE BACK',
    'info',
    3,
  );
  if (wetsFitted) hud.then('WET TRACK - FULL WETS FITTED', 'info', 3);
}

/** Fresh tyres off the blankets, a fuel load for the session, and an undamaged car for everyone. */
function prepareCars(fuel: number, rivalCompound: (id: string) => TyreCompound = () => COMPOUNDS.medium): void {
  for (const fc of game.field.cars) {
    fc.car.setTyres(BLANKET_TEMP, 0, fc.driver ? rivalCompound(fc.id) : playerCompound());
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

/** The racing line's ideal lap, the yardstick for rivals' qualifying times. */
const IDEAL_LAP = idealLap(track, game.field.line);

game.car.setTyres(BLANKET_TEMP, 0, playerCompound());
// Driving into the pits gets the tyres for the conditions.
game.field.pitTyres = (fc) => tyresFor(weather.wetness, fc.car.compound, drySlick());

setMode('menu');
game.start();

// Offline play and home-screen install. Only in production builds, so development always loads fresh code.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => void navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`));
}

// Exposed for debugging in the browser console during development.
if (import.meta.env.DEV) Object.assign(window, { game, getTimer: () => timer, getRace: () => race, getWeather: () => weather, setMode });
