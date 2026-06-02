import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { CONFIG_DIR } from '../shared/constants.js';

export interface IndexLock {
  path: string;
  release(): void;
}

const LOCK_FILE = 'index.lock';
const STALE_LOCK_MS = 6 * 60 * 60 * 1000;

export function acquireIndexLock(rootPath: string, now: Date = new Date()): IndexLock {
  const lockPath = join(rootPath, CONFIG_DIR, LOCK_FILE);
  mkdirSync(dirname(lockPath), { recursive: true });

  if (existsSync(lockPath)) {
    const existing = readLock(lockPath);
    const ageMs = existing?.acquiredAt ? now.getTime() - Date.parse(existing.acquiredAt) : 0;
    if (existing && Number.isFinite(ageMs) && ageMs > STALE_LOCK_MS) {
      rmSync(lockPath, { force: true });
    } else {
      throw new Error('Code Memory index is already running for this project: ' + lockPath);
    }
  }

  writeFileSync(lockPath, JSON.stringify({
    pid: process.pid,
    acquiredAt: now.toISOString(),
  }, null, 2));

  let released = false;
  return {
    path: lockPath,
    release(): void {
      if (released) return;
      released = true;
      rmSync(lockPath, { force: true });
    },
  };
}

function readLock(lockPath: string): { pid?: number; acquiredAt?: string } | null {
  try {
    return JSON.parse(readFileSync(lockPath, 'utf-8')) as { pid?: number; acquiredAt?: string };
  } catch {
    return null;
  }
}
