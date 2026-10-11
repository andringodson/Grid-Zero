import { Game } from './game/Game.ts';
import { TEAMS } from './game/teams.ts';
import { Input } from './input/Input.ts';
import { detectQualityTier, QUALITY } from './render/quality.ts';
import { HALDEN_RING } from './track/circuits.ts';
import { Track } from './track/Track.ts';

const container = document.getElementById('app')!;
const input = new Input();
const track = new Track(HALDEN_RING);

const game = new Game({
  container,
  track,
  team: TEAMS[0],
  quality: QUALITY[detectQualityTier()],
  assists: { steering: true, autoGears: true, tractionControl: true, abs: true },
  input,
});
game.start();

// Exposed for debugging in the browser console during development.
if (import.meta.env.DEV) (window as unknown as { game: Game }).game = game;
