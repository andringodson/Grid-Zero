import type { LapRecord } from './LapTimer.ts';

/**
 * Personal bests live in the browser's local storage. Storage can be missing or throw (private browsing, blocked
 * site data), so every access is guarded and the game simply starts without a best lap.
 */

const key = (trackId: string) => `grid-zero:best:${trackId}`;

export function loadBestLap(trackId: string): LapRecord | null {
  try {
    const raw = localStorage.getItem(key(trackId));
    if (!raw) return null;
    const r = JSON.parse(raw) as LapRecord;
    return typeof r.time === 'number' && Array.isArray(r.trace) && Array.isArray(r.sectors) ? r : null;
  } catch {
    return null;
  }
}

export function saveBestLap(trackId: string, record: LapRecord): void {
  try {
    localStorage.setItem(key(trackId), JSON.stringify(record));
  } catch {
    // Not saved; the best lap still holds for this session.
  }
}

export function loadSetting<T>(name: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(`grid-zero:${name}`);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

export function saveSetting(name: string, value: unknown): void {
  try {
    localStorage.setItem(`grid-zero:${name}`, JSON.stringify(value));
  } catch {
    // Settings fall back to defaults next time.
  }
}
