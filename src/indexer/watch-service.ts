import chokidar, { type FSWatcher } from 'chokidar';
import { isAbsolute, relative, resolve } from 'node:path';
import { DEFAULT_DEBOUNCE_MS, MAX_WATCH_BATCH_MS } from '../shared/constants.js';
import type { CodeMemoryConfig } from '../shared/types.js';
import { createLogger } from '../shared/logger.js';
import { getDatabase, getDatabaseSync, saveDatabase } from '../storage/database.js';
import { IndexManager } from './index-manager.js';
import { createIgnoreRule, isIgnored } from '../scanner/ignore-rules.js';
import { normalizePath } from '../shared/utils.js';
import { MemoryManager } from '../memory/memory-manager.js';
import { writeWatchState } from './watch-state.js';

const log = createLogger('watch');

export interface WatchService {
  close(): Promise<void>;
}

export interface PendingFile {
  path: string;
  lastSeenMs: number;
  indexing: boolean;
}

export type WatchServiceWithState = WatchService & {
  getPendingFiles(): PendingFile[];
};

interface WatchSyncMetadata {
  triggerReason?: string;
  syncDurationMs?: number;
  pendingCount?: number;
}

const activeWatchStates = new Map<string, WatchServiceWithState>();

export function getActiveWatchState(projectRoot?: string): WatchServiceWithState | undefined {
  if (projectRoot) return activeWatchStates.get(projectRoot);
  const first = activeWatchStates.values().next();
  return first.done ? undefined : first.value;
}

export function setActiveWatchState(projectRoot: string, state: WatchServiceWithState | null): void {
  if (state) {
    activeWatchStates.set(projectRoot, state);
  } else {
    activeWatchStates.delete(projectRoot);
  }
}

export function startIndexWatcher(
  projectRoot: string,
  config: CodeMemoryConfig,
  options: { debounceMs?: number } = {},
): WatchService {
  return startIndexWatcherWithState(projectRoot, config, options);
}

export function startIndexWatcherWithState(
  projectRoot: string,
  config: CodeMemoryConfig,
  options: { debounceMs?: number } = {},
): WatchServiceWithState {
  const debounceMs = options.debounceMs ?? config.realtime?.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const manager = new IndexManager(projectRoot, {
    ...config,
    indexing: {
      ...(config.indexing || {}),
      edgeMode: 'dirty',
    },
  });

  let timer: NodeJS.Timeout | null = null;
  let maxTimer: NodeJS.Timeout | null = null;
  let running = false;
  let pending = false;
  let lastTriggerReason = 'unknown';
  const pendingPaths = new Map<string, number>();
  const inFlightPaths = new Set<string>();
  const ignoreRule = createIgnoreRule(projectRoot, config.ignore);
  const resolvedRoot = resolve(projectRoot);

  const watcher: FSWatcher = chokidar.watch(projectRoot, {
    ignored: (candidatePath) => shouldIgnoreWatchPath(resolvedRoot, candidatePath, ignoreRule),
    ignoreInitial: true,
    persistent: true,
  });
  writeWatchState(projectRoot, {
    active: true,
    pid: process.pid,
    startedAt: new Date().toISOString(),
    pendingFiles: [],
    syncing: false,
    lastError: null,
    lastErrorAt: null,
  });

  const schedule = (changedPath?: string, triggerReason = 'unknown') => {
    const normalizedPath = changedPath
      ? normalizeWatchPath(resolvedRoot, changedPath)
      : null;
    if (normalizedPath) {
      pendingPaths.set(normalizedPath, Date.now());
    }
    lastTriggerReason = triggerReason;
    pending = true;
    writeWatchState(projectRoot, {
      active: true,
      pid: process.pid,
      pendingFiles: [...pendingPaths.keys()],
      syncing: running,
    });
    if (timer) clearTimeout(timer);
    timer = setTimeout(runIndex, debounceMs);
    if (!maxTimer) maxTimer = setTimeout(runIndex, MAX_WATCH_BATCH_MS);
  };

  async function runIndex(): Promise<void> {
    if (timer) clearTimeout(timer);
    if (maxTimer) clearTimeout(maxTimer);
    timer = null;
    maxTimer = null;
    if (!pending || running) return;
    pending = false;
    running = true;
    const changedPaths = [...pendingPaths.keys()];
    for (const p of changedPaths) inFlightPaths.add(p);
    const pendingCount = pendingPaths.size;
    const triggerReason = lastTriggerReason;
    const startedAt = Date.now();
    writeWatchState(projectRoot, {
      active: true,
      pid: process.pid,
      pendingFiles: changedPaths,
      syncing: true,
    });
    try {
      await manager.incrementalIndex({
        changedPaths,
        forceAll: false,
        fallbackToScan: true,
      });

      // Auto-lifecycle: check memory invalidation after successful incremental index
      try {
        const memoryManager = new MemoryManager();
        const invalidatedIds = memoryManager.checkInvalidation(changedPaths);
        if (invalidatedIds.length > 0) {
          log.info(`[Auto-Lifecycle] Watch triggered: Invalidated ${invalidatedIds.length} memories affected by file changes.`);
        }
      } catch (memErr) {
        log.error('Automated memory invalidation failed: ' + (memErr instanceof Error ? memErr.message : String(memErr)));
      }

      await recordWatchSyncSuccess(projectRoot, changedPaths, {
        triggerReason,
        syncDurationMs: Date.now() - startedAt,
        pendingCount,
      });
      writeWatchState(projectRoot, {
        active: true,
        pid: process.pid,
        lastSyncAt: new Date().toISOString(),
        pendingFiles: [],
        syncing: false,
        lastError: null,
        lastErrorAt: null,
      });
      log.info('Watch sync complete (' + changedPaths.length + ' path(s))');
    } catch (err) {
      await recordWatchSyncFailure(projectRoot, err, changedPaths, {
        triggerReason,
        syncDurationMs: Date.now() - startedAt,
        pendingCount,
      });
      writeWatchState(projectRoot, {
        active: true,
        pid: process.pid,
        pendingFiles: changedPaths,
        syncing: false,
        lastError: err instanceof Error ? err.message : String(err),
        lastErrorAt: new Date().toISOString(),
      });
      log.error('Watch sync failed', err);
    } finally {
      for (const path of changedPaths) {
        pendingPaths.delete(path);
      }
      inFlightPaths.clear();
      running = false;
      if (pending) schedule();
    }
  }

  watcher.on('add', (path) => schedule(path, 'add'));
  watcher.on('change', (path) => schedule(path, 'change'));
  watcher.on('unlink', (path) => schedule(path, 'unlink'));
  watcher.on('error', (err) => {
    void recordWatchSyncFailure(projectRoot, err, [...pendingPaths.keys()], {
      triggerReason: 'error',
      pendingCount: pendingPaths.size,
    });
    writeWatchState(projectRoot, {
      active: true,
      pid: process.pid,
      pendingFiles: [...pendingPaths.keys()],
      syncing: false,
      lastError: err instanceof Error ? err.message : String(err),
      lastErrorAt: new Date().toISOString(),
    });
    log.error('Watch backend failed', err);
  });

  const service: WatchServiceWithState = {
    async close() {
      if (timer) clearTimeout(timer);
      if (maxTimer) clearTimeout(maxTimer);
      await watcher.close();
      activeWatchStates.delete(projectRoot);
      writeWatchState(projectRoot, {
        active: false,
        pid: null,
        pendingFiles: [],
        syncing: false,
      });
    },
    getPendingFiles(): PendingFile[] {
      const result: PendingFile[] = [];
      for (const [path, lastSeenMs] of pendingPaths) {
        result.push({ path, lastSeenMs, indexing: inFlightPaths.has(path) });
      }
      return result;
    },
  };

  setActiveWatchState(projectRoot, service);
  return service;
}

export async function recordWatchSyncSuccess(
  projectRoot: string,
  changedPaths: string[] = [],
  metadata: WatchSyncMetadata = {},
): Promise<void> {
  await writeWatchMetadata(projectRoot, (db) => {
    db.run(
      "DELETE FROM index_metadata WHERE key IN ('last_watch_error', 'last_watch_error_at')",
    );
    db.run(
      'INSERT OR REPLACE INTO index_metadata (key, value) VALUES (?, ?)',
      ['watch_sync_status', 'ok'],
    );
    writeWatchPathMetadata(db, changedPaths, metadata);
  });
}

export async function recordWatchSyncFailure(
  projectRoot: string,
  err: unknown,
  changedPaths: string[] = [],
  metadata: WatchSyncMetadata = {},
): Promise<void> {
  const message = err instanceof Error ? err.message : String(err);
  await writeWatchMetadata(projectRoot, (db) => {
    db.run(
      'INSERT OR REPLACE INTO index_metadata (key, value) VALUES (?, ?)',
      ['watch_sync_status', 'failed'],
    );
    db.run(
      'INSERT OR REPLACE INTO index_metadata (key, value) VALUES (?, ?)',
      ['last_watch_error', message],
    );
    db.run(
      'INSERT OR REPLACE INTO index_metadata (key, value) VALUES (?, ?)',
      ['last_watch_error_at', new Date().toISOString()],
    );
    writeWatchPathMetadata(db, changedPaths, metadata);
  });
}

function normalizeWatchPath(projectRoot: string, changedPath: string): string | null {
  const resolvedPath = isAbsolute(changedPath)
    ? resolve(changedPath)
    : resolve(projectRoot, changedPath);
  const relativePath = relative(projectRoot, resolvedPath);
  if (!relativePath || relativePath === '.') return null;
  if (relativePath.startsWith('..') || isAbsolute(relativePath)) return null;
  return normalizePath(relativePath);
}

function shouldIgnoreWatchPath(projectRoot: string, candidatePath: string, ignoreRule: ReturnType<typeof createIgnoreRule>): boolean {
  const relativePath = normalizeWatchPath(projectRoot, candidatePath);
  if (!relativePath) return false;
  if (isIgnored(relativePath, ignoreRule)) return true;
  const segments = relativePath.split('/');
  for (let i = 1; i < segments.length; i++) {
    if (isIgnored(segments.slice(0, i).join('/'), ignoreRule)) return true;
  }
  return false;
}

function writeWatchPathMetadata(
  db: ReturnType<typeof getDatabaseSync>,
  changedPaths: string[],
  metadata: WatchSyncMetadata,
): void {
  const now = new Date().toISOString();
  const pendingCount = metadata.pendingCount ?? changedPaths.length;
  const durationMs = metadata.syncDurationMs ?? 0;
  const triggerReason = metadata.triggerReason ?? 'unknown';
  const serializedPaths = JSON.stringify(changedPaths.slice(0, 50));
  db.run(
    'INSERT OR REPLACE INTO index_metadata (key, value) VALUES (?, ?)',
    ['last_watch_changed_count', String(changedPaths.length)],
  );
  db.run(
    'INSERT OR REPLACE INTO index_metadata (key, value) VALUES (?, ?)',
    ['last_watch_changed_paths', serializedPaths],
  );
  db.run(
    'INSERT OR REPLACE INTO index_metadata (key, value) VALUES (?, ?)',
    ['last_watch_synced_at', now],
  );
  db.run(
    'INSERT OR REPLACE INTO index_metadata (key, value) VALUES (?, ?)',
    ['watch_last_changed_paths', serializedPaths],
  );
  db.run(
    'INSERT OR REPLACE INTO index_metadata (key, value) VALUES (?, ?)',
    ['watch_last_trigger_reason', triggerReason],
  );
  db.run(
    'INSERT OR REPLACE INTO index_metadata (key, value) VALUES (?, ?)',
    ['watch_last_sync_duration_ms', String(durationMs)],
  );
  db.run(
    'INSERT OR REPLACE INTO index_metadata (key, value) VALUES (?, ?)',
    ['watch_pending_count', String(pendingCount)],
  );
}

async function writeWatchMetadata(
  projectRoot: string,
  write: (db: ReturnType<typeof getDatabaseSync>) => void,
): Promise<void> {
  try {
    await getDatabase(projectRoot);
    write(getDatabaseSync());
    await saveDatabase();
  } catch (err) {
    log.warn('Failed to persist watch metadata: ' + (err instanceof Error ? err.message : String(err)));
  }
}
