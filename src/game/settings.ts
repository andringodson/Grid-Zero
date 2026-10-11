import type { Assists } from '../physics/Car.ts';
import { detectQualityTier, type QualityTier } from '../render/quality.ts';
import type { TouchSteering } from '../ui/touch.ts';
import { loadSetting, saveSetting } from './storage.ts';
import { TEAMS } from './teams.ts';

export interface Settings {
  quality: QualityTier;
  assists: Assists;
  volume: number;
  touchSteering: TouchSteering;
  teamId: string;
}

const DEFAULT_ASSISTS: Assists = { steering: true, autoGears: true, tractionControl: true, abs: true };

export function loadSettings(): Settings {
  const saved = loadSetting<Partial<Settings>>('settings', {});
  return {
    quality: saved.quality ?? detectQualityTier(),
    assists: { ...DEFAULT_ASSISTS, ...saved.assists },
    volume: typeof saved.volume === 'number' ? saved.volume : 0.8,
    touchSteering: saved.touchSteering === 'tilt' ? 'tilt' : 'drag',
    teamId: TEAMS.some((t) => t.id === saved.teamId) ? saved.teamId! : TEAMS[0].id,
  };
}

export function saveSettings(s: Settings): void {
  saveSetting('settings', s);
}
