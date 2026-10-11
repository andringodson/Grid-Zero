import './ui/hud.css';
import { Game } from './game/Game.ts';
import { LapTimer } from './game/LapTimer.ts';
import { loadBestLap, saveBestLap } from './game/storage.ts';
import { TEAMS } from './game/teams.ts';
import { Input } from './input/Input.ts';
import { detectQualityTier, QUALITY } from './render/quality.ts';
import { HALDEN_RING } from './track/circuits.ts';
import { Track } from './track/Track.ts';
import { Hud } from './ui/hud.ts';

const container = document.getElementById('app')!;
const input = new Input();
const track = new Track(HALDEN_RING);
const timer = new LapTimer(track.length, track.sectorStarts, loadBestLap(track.id));
const hud = new Hud(document.body, track);

const game = new Game({
  container,
  track,
  team: TEAMS[0],
  quality: QUALITY[detectQualityTier()],
  assists: { steering: true, autoGears: true, tractionControl: true, abs: true },
  input,
  onFrame(g, info) {
    if (info.input.reset) hud.onTiming(timer.invalidate('reset'));
    if (!g.paused) {
      const events = timer.update(g.world.projection.s, info.dt, g.world.allWheelsOff(g.car));
      hud.onTiming(events);
      for (const e of events) if (e.type === 'lap' && e.personalBest) saveBestLap(track.id, e.record);
    }
    hud.update(info.dt, g.car, timer, g.world.projection.s);
  },
});
game.start();

// Exposed for debugging in the browser console during development.
if (import.meta.env.DEV) Object.assign(window, { game, timer });
