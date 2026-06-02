import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DEFAULT_IGNORE_PATTERNS } from '../src/shared/constants.js';
import { DEFAULT_TOKEN_BUDGETS, type CodeMemoryConfig } from '../src/shared/types.js';
import { IndexManager } from '../src/indexer/index-manager.js';
import { closeDatabase, getDatabaseSync } from '../src/storage/database.js';

type WatchHandler = (path: string) => void;

const handlers = new Map<string, WatchHandler>();
const closeMock = vi.fn(async () => {});
const watchMock = vi.fn(() => {
  const watcher = {
    on: vi.fn((event: string, handler: WatchHandler) => {
      handlers.set(event, handler);
      return watcher;
    }),
    close: closeMock,
  };
  return watcher;
});

vi.mock('chokidar', () => ({
  default: { watch: watchMock },
}));

function createConfig(rootPath: string): CodeMemoryConfig {
  return {
    projectName: 'watch-service-test',
    rootPath,
    ignore: [...DEFAULT_IGNORE_PATTERNS, 'ignored/**'],
    languages: ['typescript'],
    indexing: {
      workers: 0,
      parseBatchSize: 10,
      edgeMode: 'dirty',
    },
    embedding: {
      provider: 'none',
      model: 'none',
    },
    llm: null,
    realtime: {
      watch: true,
      debounceMs: 10,
    },
    tokenBudgets: { ...DEFAULT_TOKEN_BUDGETS },
  };
}

describe('watch service', () => {
  let tempRoot: string;
  let tempRoots: string[] = [];

  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    handlers.clear();
    watchMock.mockClear();
    closeMock.mockClear();
    await closeDatabase();
    if (tempRoot) rmSync(tempRoot, { recursive: true, force: true });
    for (const root of tempRoots) {
      rmSync(root, { recursive: true, force: true });
    }
    tempRoots = [];
  });

  it('uses project ignore rules for watched paths', async () => {
    tempRoot = mkdtempSync(join(tmpdir(), 'code-memory-watch-ignore-'));
    mkdirSync(join(tempRoot, 'ignored'), { recursive: true });
    mkdirSync(join(tempRoot, 'src'), { recursive: true });
    const { startIndexWatcher } = await import('../src/indexer/watch-service.js');

    const service = startIndexWatcher(tempRoot, createConfig(tempRoot));
    const options = watchMock.mock.calls[0]?.[1] as { ignored?: (path: string) => boolean };

    expect(options.ignored?.(join(tempRoot, 'ignored', 'main.ts'))).toBe(true);
    expect(options.ignored?.(join(tempRoot, 'src', 'main.ts'))).toBe(false);

    await service.close();
  });

  it('passes changed paths to incremental indexing after debounce', async () => {
    vi.useFakeTimers();
    tempRoot = mkdtempSync(join(tmpdir(), 'code-memory-watch-paths-'));
    mkdirSync(join(tempRoot, 'src'), { recursive: true });
    const incrementalSpy = vi
      .spyOn(IndexManager.prototype, 'incrementalIndex')
      .mockResolvedValue({} as Awaited<ReturnType<IndexManager['incrementalIndex']>>);
    const { startIndexWatcher } = await import('../src/indexer/watch-service.js');

    const service = startIndexWatcher(tempRoot, createConfig(tempRoot), { debounceMs: 10 });
    handlers.get('change')?.(join(tempRoot, 'src', 'main.ts'));
    await vi.runAllTimersAsync();

    expect(incrementalSpy).toHaveBeenCalledWith({
      changedPaths: ['src/main.ts'],
      forceAll: false,
      fallbackToScan: true,
    });
    await vi.waitFor(() => {
      expect(getDatabaseSync().get<{ value: string }>(
        "SELECT value FROM index_metadata WHERE key = 'watch_last_trigger_reason'",
      )?.value).toBe('change');
    });
    expect(getDatabaseSync().get<{ value: string }>(
      "SELECT value FROM index_metadata WHERE key = 'watch_last_changed_paths'",
    )?.value).toBe(JSON.stringify(['src/main.ts']));
    expect(getDatabaseSync().get<{ value: string }>(
      "SELECT value FROM index_metadata WHERE key = 'watch_pending_count'",
    )?.value).toBe('1');

    await service.close();
  });

  it('passes deleted paths to incremental indexing after debounce', async () => {
    vi.useFakeTimers();
    tempRoot = mkdtempSync(join(tmpdir(), 'code-memory-watch-unlink-'));
    mkdirSync(join(tempRoot, 'src'), { recursive: true });
    const incrementalSpy = vi
      .spyOn(IndexManager.prototype, 'incrementalIndex')
      .mockResolvedValue({} as Awaited<ReturnType<IndexManager['incrementalIndex']>>);
    const { startIndexWatcher } = await import('../src/indexer/watch-service.js');

    const service = startIndexWatcher(tempRoot, createConfig(tempRoot), { debounceMs: 10 });
    handlers.get('unlink')?.(join(tempRoot, 'src', 'removed.ts'));
    await vi.runAllTimersAsync();

    expect(incrementalSpy).toHaveBeenCalledWith({
      changedPaths: ['src/removed.ts'],
      forceAll: false,
      fallbackToScan: true,
    });

    await service.close();
  });

  it('records watcher backend failures in watch metadata', async () => {
    tempRoot = mkdtempSync(join(tmpdir(), 'code-memory-watch-error-'));
    const { startIndexWatcher } = await import('../src/indexer/watch-service.js');

    const service = startIndexWatcher(tempRoot, createConfig(tempRoot));
    handlers.get('error')?.('watch backend unavailable');
    await vi.waitFor(() => {
      expect(getDatabaseSync().get<{ value: string }>(
        "SELECT value FROM index_metadata WHERE key = 'watch_sync_status'",
      )?.value).toBe('failed');
    });
    expect(getDatabaseSync().get<{ value: string }>(
      "SELECT value FROM index_metadata WHERE key = 'last_watch_error'",
    )?.value).toBe('watch backend unavailable');
    expect(getDatabaseSync().get<{ value: string }>(
      "SELECT value FROM index_metadata WHERE key = 'watch_last_trigger_reason'",
    )?.value).toBe('error');

    await service.close();
  });

  it('reports indexing=true only for files currently being indexed', async () => {
    vi.useFakeTimers();
    tempRoot = mkdtempSync(join(tmpdir(), 'code-memory-watch-inflight-'));
    mkdirSync(join(tempRoot, 'src'), { recursive: true });

    let resolveIndex!: () => void;
    const indexPromise = new Promise<void>((resolve) => { resolveIndex = resolve; });
    vi
      .spyOn(IndexManager.prototype, 'incrementalIndex')
      .mockImplementation(async () => {
        await indexPromise;
        return {} as Awaited<ReturnType<IndexManager['incrementalIndex']>>;
      });

    const { startIndexWatcher } = await import('../src/indexer/watch-service.js');
    const service = startIndexWatcher(tempRoot, createConfig(tempRoot), { debounceMs: 10 });

    handlers.get('change')?.(join(tempRoot, 'src', 'a.ts'));
    vi.advanceTimersByTime(10);

    handlers.get('change')?.(join(tempRoot, 'src', 'b.ts'));

    const pending = service.getPendingFiles();
    expect(pending.find((f) => f.path === 'src/a.ts')?.indexing).toBe(true);
    expect(pending.find((f) => f.path === 'src/b.ts')?.indexing).toBe(false);

    resolveIndex();
    await vi.runAllTimersAsync();
    await service.close();
  });

  it('supports multiple watchers with different project roots', async () => {
    const rootA = mkdtempSync(join(tmpdir(), 'code-memory-watch-multi-a-'));
    const rootB = mkdtempSync(join(tmpdir(), 'code-memory-watch-multi-b-'));
    mkdirSync(join(rootA, 'src'), { recursive: true });
    mkdirSync(join(rootB, 'src'), { recursive: true });
    tempRoots = [rootA, rootB];

    vi
      .spyOn(IndexManager.prototype, 'incrementalIndex')
      .mockResolvedValue({} as Awaited<ReturnType<IndexManager['incrementalIndex']>>);

    const { startIndexWatcher, getActiveWatchState } = await import('../src/indexer/watch-service.js');

    const serviceA = startIndexWatcher(rootA, createConfig(rootA));
    const serviceB = startIndexWatcher(rootB, createConfig(rootB));

    expect(getActiveWatchState(rootA)).toBe(serviceA);
    expect(getActiveWatchState(rootB)).toBe(serviceB);

    await serviceA.close();
    expect(getActiveWatchState(rootA)).toBeUndefined();
    expect(getActiveWatchState(rootB)).toBe(serviceB);

    await serviceB.close();
  });
});
