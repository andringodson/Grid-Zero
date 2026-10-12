import type { Assists } from '../physics/Car.ts';
import type { TyreCompound } from '../physics/tyre.ts';
import { detectQualityTier, type QualityTier } from '../render/quality.ts';
import type { TouchSteering } from '../ui/touch.ts';
import { loadSetting, saveSetting } from './storage.ts';
import { TEAMS } from './teams.ts';

export type Difficulty = 'easy' | 'medium' | 'hard';

export interface Settings {
  quality: QualityTier;
  assists: Assists;
  volume: number;
  touchSteering: TouchSteering;
  teamId: string;
  difficulty: Difficulty;
  raceLaps: number;
  compound: TyreCompound['id'];
}

/** AI pace range per difficulty, as a fraction of the racing line's limit. Hard is close to a clean flying lap. */
export const DIFFICULTY_PACE: Record<Difficulty, [number, number]> = {
  easy: [0.86, 0.9],
  medium: [0.9, 0.945],
  hard: [0.945, 0.985],
};

/** How rarely rivals make mistakes, and how steady their lap times are. */
export const DIFFICULTY_CONSISTENCY: Record<Difficulty, number> = {
  easy: 0.6,
  medium: 0.75,
  hard: 0.9,
};

export const RACE_LAPS = [3, 5, 10] as const;

const DEFAULT_ASSISTS: Assists = { steering: true, autoGears: true, tractionControl: true, abs: true };

export function loadSettings(): Settings {
  const saved = loadSetting<Partial<Settings>>('settings', {});
  return {
    quality: saved.quality ?? detectQualityTier(),
    assists: { ...DEFAULT_ASSISTS, ...saved.assists },
    volume: typeof saved.volume === 'number' ? saved.volume : 0.8,
    touchSteering: saved.touchSteering === 'tilt' ? 'tilt' : 'drag',
    teamId: TEAMS.some((t) => t.id === saved.teamId) ? saved.teamId! : TEAMS[0].id,
    difficulty: saved.difficulty === 'easy' || saved.difficulty === 'hard' ? saved.difficulty : 'medium',
    raceLaps: (RACE_LAPS as readonly number[]).includes(saved.raceLaps ?? 0) ? saved.raceLaps! : 3,
    compound: saved.compound === 'soft' || saved.compound === 'hard' ? saved.compound : 'medium',
  };
}

export function saveSettings(s: Settings): void {
  saveSetting('settings', s);
}
