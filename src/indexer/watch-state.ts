import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CONFIG_DIR } from '../shared/constants.js';
import { safeJsonParse } from '../shared/utils.js';

export const WATCH_STATE_FILE = 'watch-state.json';

export interface PersistedWatchState {
  active: boolean;
  pid: number | null;
  startedAt: string | null;
  updatedAt: string;
  lastSyncAt: string | null;
  pendingFiles: string[];
  syncing: boolean;
  lastError: string | null;
  lastErrorAt: string | null;
}

export function readWatchState(projectRoot: string): PersistedWatchState | null {
  const filePath = getWatchStatePath(projectRoot);
  if (!existsSync(filePath)) return null;
  try {
    return safeJsonParse<PersistedWatchState>(readFileSync(filePath, 'utf-8'));
  } catch {
    return null;
  }
}

export function writeWatchState(
  projectRoot: string,
  patch: Partial<PersistedWatchState>,
): PersistedWatchState {
  const previous = readWatchState(projectRoot);
  const next: PersistedWatchState = {
    active: previous?.active ?? false,
    pid: previous?.pid ?? null,
    startedAt: previous?.startedAt ?? null,
    lastSyncAt: previous?.lastSyncAt ?? null,
    pendingFiles: previous?.pendingFiles ?? [],
    syncing: previous?.syncing ?? false,
    lastError: previous?.lastError ?? null,
    lastErrorAt: previous?.lastErrorAt ?? null,
    ...patch,
    updatedAt: new Date().toISOString(),
  };
  const dir = join(projectRoot, CONFIG_DIR);
  mkdirSync(dir, { recursive: true });
  writeFileSync(getWatchStatePath(projectRoot), JSON.stringify(next, null, 2) + '\n', 'utf-8');
  return next;
}

export function getWatchStatePath(projectRoot: string): string {
  return join(projectRoot, CONFIG_DIR, WATCH_STATE_FILE);
}
