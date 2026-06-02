import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DEFAULT_IGNORE_PATTERNS } from '../src/shared/constants.js';
import { DEFAULT_TOKEN_BUDGETS, type CodeMemoryConfig } from '../src/shared/types.js';
import { IndexManager } from '../src/indexer/index-manager.js';
import { acquireIndexLock } from '../src/indexer/index-lock.js';
import { closeDatabase, getDatabaseSync } from '../src/storage/database.js';
import { MAX_COLLECTING_PARSE_FILES, parseFilesWithWorkers } from '../src/indexer/parse-worker-pool.js';
import type { DiscoveredFile } from '../src/scanner/file-discovery.js';

function createProject(): { root: string; config: CodeMemoryConfig } {
  const root = mkdtempSync(join(tmpdir(), 'code-memory-lifecycle-'));
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', 'index.ts'), 'export function hello() { return "world"; }\n', 'utf-8');

  const config: CodeMemoryConfig = {
    projectName: 'lifecycle-test',
    rootPath: root,
    ignore: [...DEFAULT_IGNORE_PATTERNS],
    languages: ['typescript'],
    embedding: {
      provider: 'none',
      model: 'none',
    },
    indexing: {
      workers: 0,
      parseBatchSize: 2,
      edgeMode: 'full',
    },
    llm: null,
    realtime: {
      watch: false,
      debounceMs: 80,
    },
    tokenBudgets: { ...DEFAULT_TOKEN_BUDGETS },
  };

  mkdirSync(join(root, '.code-memory'), { recursive: true });
  writeFileSync(join(root, '.code-memory', 'config.json'), JSON.stringify(config, null, 2), 'utf-8');
  return { root, config };
}

function queryValue(key: string): string | null {
  const rows = getDatabaseSync().exec('SELECT value FROM index_metadata WHERE key = ?', [key]);
  return rows[0]?.values[0]?.[0] ? String(rows[0].values[0][0]) : null;
}

describe('index lifecycle', () => {
  const roots: string[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    await closeDatabase();
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('prevents two indexers from acquiring the same project lock', () => {
    const { root } = createProject();
    roots.push(root);

    const first = acquireIndexLock(root);
    expect(() => acquireIndexLock(root)).toThrow(/already running/i);
    first.release();
    expect(existsSync(join(root, '.code-memory', 'index.lock'))).toBe(false);
  });

  it('replaces stale locks', () => {
    const { root } = createProject();
    roots.push(root);
    const lockPath = join(root, '.code-memory', 'index.lock');
    writeFileSync(lockPath, JSON.stringify({
      pid: 123,
      acquiredAt: new Date(0).toISOString(),
    }));

    const lock = acquireIndexLock(root, new Date('2026-05-31T12:00:00.000Z'));
    expect(existsSync(lockPath)).toBe(true);
    lock.release();
  });

  it('clears is_indexing and releases the lock when full indexing fails', async () => {
    const { root, config } = createProject();
    roots.push(root);
    const manager = new IndexManager(root, config);
    vi.spyOn(manager as unknown as {
      rebuildGraphEdges(mode: 'full' | 'dirty', dirtyFileIds?: string[]): Promise<number>;
    }, 'rebuildGraphEdges').mockRejectedValue(new Error('forced edge failure'));

    await expect(manager.fullIndex()).rejects.toThrow('forced edge failure');

    expect(queryValue('is_indexing')).toBe('false');
    expect(queryValue('index_status')).toBe('failed');
    expect(queryValue('last_index_error')).toContain('forced edge failure');
    expect(queryValue('index_run_id')).toMatch(/^full-/);
    expect(queryValue('index_started_at')).toBeTruthy();
    expect(queryValue('index_completed_at')).toBeTruthy();
    expect(existsSync(join(root, '.code-memory', 'index.lock'))).toBe(false);
  });

  it('records completed lifecycle metadata after a successful full index', async () => {
    const { root, config } = createProject();
    roots.push(root);

    await new IndexManager(root, config).fullIndex();

    expect(queryValue('is_indexing')).toBe('false');
    expect(queryValue('index_status')).toBe('completed');
    expect(queryValue('last_index_error')).toBe(null);
    expect(queryValue('index_run_id')).toMatch(/^full-/);
    expect(queryValue('index_started_at')).toBeTruthy();
    expect(queryValue('index_completed_at')).toBeTruthy();
  });

  it('rejects collecting worker parsing for large file batches', async () => {
    const files = Array.from({ length: MAX_COLLECTING_PARSE_FILES + 1 }, (_, index) => ({
      path: join('virtual', 'file-' + index + '.ts'),
      relativePath: 'src/file-' + index + '.ts',
      language: 'typescript',
      role: 'source',
      size: 1,
      hash: String(index),
      lastModified: Date.now(),
    })) as DiscoveredFile[];

    await expect(parseFilesWithWorkers(files, {
      workers: 2,
      rootPath: 'virtual',
    })).rejects.toThrow(/parseFilesWithWorkersBatched/);
  });
});
