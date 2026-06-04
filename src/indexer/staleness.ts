import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CONFIG_DIR, DATABASE_FILE } from '../shared/constants.js';
import type { SqlJsDatabase } from '../storage/database.js';
import { contentHash, normalizePath } from '../shared/utils.js';

export type IndexFreshness = 'fresh' | 'stale' | 'missing' | 'rebuilding' | 'failed';

export interface IndexStaleness {
  indexStatus: IndexFreshness;
  changedFiles: number;
  lastIndexedAt: string | null;
  lastIndexedCommit: string | null;
  currentCommit: string | null;
  recommendedAction: string | null;
  watchSyncStatus: string | null;
  watchLastChangedPaths: string[];
  watchLastTriggerReason: string | null;
  watchLastSyncDurationMs: number | null;
  watchPendingCount: number;
  lastWatchError: string | null;
  lastWatchErrorAt: string | null;
}

export function getIndexStaleness(projectRoot: string, db?: SqlJsDatabase): IndexStaleness {
  const dbPath = join(projectRoot, CONFIG_DIR, DATABASE_FILE);
  if (!existsSync(dbPath)) {
    return {
      indexStatus: 'missing',
      changedFiles: 0,
      lastIndexedAt: null,
      lastIndexedCommit: null,
      currentCommit: getGitValue(projectRoot, 'rev-parse HEAD'),
      recommendedAction: 'run code-memory init -i',
      watchSyncStatus: null,
      watchLastChangedPaths: [],
      watchLastTriggerReason: null,
      watchLastSyncDurationMs: null,
      watchPendingCount: 0,
      lastWatchError: null,
      lastWatchErrorAt: null,
    };
  }

  const meta = db ? readMetadata(db) : new Map<string, string>();
  const currentCommit = getGitValue(projectRoot, 'rev-parse HEAD');
  const lastIndexedCommit = meta.get('current_commit') || null;
  const lastIndexedAt = meta.get('last_incremental_index') || meta.get('last_full_index') || null;
  const changedFiles = db ? getStaleIndexedFileCount(projectRoot, db) : getRelevantGitChangedPaths(projectRoot).length;
  const rebuilding = meta.get('is_indexing') === 'true';
  const lastWatchError = meta.get('last_watch_error') || null;
  const watchFailed = meta.get('watch_sync_status') === 'failed' || Boolean(lastWatchError);
  const stale = Boolean(changedFiles > 0 || (currentCommit && lastIndexedCommit && currentCommit !== lastIndexedCommit));

  return {
    indexStatus: rebuilding ? 'rebuilding' : watchFailed ? 'failed' : stale ? 'stale' : 'fresh',
    changedFiles,
    lastIndexedAt,
    lastIndexedCommit,
    currentCommit,
    recommendedAction: rebuilding
      ? 'wait for current indexing run to finish'
      : lastWatchError
        ? 'inspect watch error and run code-memory sync after fixing it'
        : stale
          ? 'run code-memory sync'
          : null,
    watchSyncStatus: meta.get('watch_sync_status') || null,
    watchLastChangedPaths: parseJsonStringArray(meta.get('watch_last_changed_paths') || meta.get('last_watch_changed_paths')),
    watchLastTriggerReason: meta.get('watch_last_trigger_reason') || null,
    watchLastSyncDurationMs: parseNullableNumber(meta.get('watch_last_sync_duration_ms')),
    watchPendingCount: parseNullableNumber(meta.get('watch_pending_count')) ?? 0,
    lastWatchError,
    lastWatchErrorAt: meta.get('last_watch_error_at') || null,
  };
}

function parseJsonStringArray(value: string | undefined): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === 'string')
      : [];
  } catch {
    return [];
  }
}

function parseNullableNumber(value: string | undefined): number | null {
  if (!value) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function readMetadata(db: SqlJsDatabase): Map<string, string> {
  const meta = new Map<string, string>();
  try {
    const result = db.exec('SELECT key, value FROM index_metadata');
    if (result.length > 0) {
      for (const row of result[0].values) {
        meta.set(String(row[0]), String(row[1]));
      }
    }
  } catch {
    // Older or corrupt indexes are reported by doctor/status separately.
  }
  return meta;
}

function getStaleIndexedFileCount(projectRoot: string, db: SqlJsDatabase): number {
  const changedPaths = getRelevantGitChangedPaths(projectRoot);
  if (changedPaths.length === 0) return 0;

  let count = 0;
  for (const relPath of changedPaths) {
    const normalizedPath = normalizePath(relPath);
    if (isNeverIndexedPath(normalizedPath)) continue;
    const indexed = db.get<{ hash: string }>(
      'SELECT hash FROM files WHERE path = ?',
      [normalizedPath],
    );
    const absolutePath = join(projectRoot, normalizedPath);
    if (!existsSync(absolutePath)) {
      if (indexed) count++;
      continue;
    }
    try {
      const currentHash = hashFileSync(absolutePath);
      if (!indexed || indexed.hash !== currentHash) count++;
    } catch {
      count++;
    }
  }
  return count;
}

function getRelevantGitChangedPaths(projectRoot: string): string[] {
  return getGitChangedPaths(projectRoot)
    .filter((relPath) => !isNeverIndexedPath(normalizePath(relPath)));
}

function getGitChangedPaths(projectRoot: string): string[] {
  const porcelain = getGitValue(projectRoot, 'status --porcelain --untracked-files=all', false);
  if (!porcelain) return [];
  const paths = new Set<string>();
  for (const line of porcelain.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const status = line.slice(0, 2);
    const rawPath = line.slice(3).trim();
    if (!rawPath) continue;
    if (status.startsWith('R') || status.startsWith('C')) {
      const [, target] = rawPath.split(/\s+->\s+/);
      paths.add(target || rawPath);
      continue;
    }
    paths.add(rawPath);
  }
  return [...paths];
}

function hashFileSync(filePath: string): string {
  return contentHash(readFileSync(filePath, 'utf-8'));
}

function isNeverIndexedPath(filePath: string): boolean {
  return /(^|\/)(\.git|\.code-memory|node_modules|dist)(\/|$)/.test(filePath);
}

function getGitValue(projectRoot: string, args: string, trim = true): string | null {
  try {
    const output = execSync(`git ${args}`, {
      cwd: projectRoot,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 10_000,
    });
    const value = trim ? output.trim() : output;
    return value.trim() ? value : null;
  } catch {
    return null;
  }
}
