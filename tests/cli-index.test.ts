import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createCli } from '../src/cli/cli.js';
import { DEFAULT_IGNORE_PATTERNS } from '../src/shared/constants.js';
import { DEFAULT_TOKEN_BUDGETS, type CodeMemoryConfig } from '../src/shared/types.js';
import { closeDatabase, getDatabaseSync } from '../src/storage/database.js';

const fixtureRoot = resolve('tests/fixtures/sample-ts-project');

function createConfig(rootPath: string): CodeMemoryConfig {
  return {
    projectName: 'sample-ts-project',
    rootPath,
    ignore: [...DEFAULT_IGNORE_PATTERNS],
    languages: ['typescript', 'javascript'],
    embedding: {
      provider: 'none',
      model: 'none',
    },
    llm: null,
    realtime: {
      watch: false,
      debounceMs: 80,
    },
    tokenBudgets: { ...DEFAULT_TOKEN_BUDGETS },
  };
}

describe('CLI index command', () => {
  let tempRoot: string;
  let originalCwd: string;

  beforeEach(() => {
    originalCwd = process.cwd();
    tempRoot = mkdtempSync(join(tmpdir(), 'code-memory-index-cli-'));
    cpSync(fixtureRoot, tempRoot, { recursive: true });
    mkdirSync(join(tempRoot, '.code-memory'), { recursive: true });
    writeFileSync(
      join(tempRoot, '.code-memory', 'config.json'),
      '\uFEFF' + JSON.stringify(createConfig(tempRoot), null, 2),
      'utf-8',
    );
    process.chdir(tempRoot);
    vi.spyOn(process, 'exit').mockImplementation((code?: string | number | null | undefined) => {
      throw new Error('process.exit ' + code);
    });
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    vi.restoreAllMocks();
    await closeDatabase();
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it('indexes projects whose config file starts with a UTF-8 BOM', async () => {
    const program = createCli();
    program.exitOverride();

    await program.parseAsync(['node', 'code-memory', 'index', '--full']);

    expect(existsSync(join(tempRoot, '.code-memory', 'index.db'))).toBe(true);
  });

  it('reports project identity and retrieval capabilities in status json', async () => {
    const program = createCli();
    program.exitOverride();
    await program.parseAsync(['node', 'code-memory', 'index', '--full']);

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const statusProgram = createCli();
    statusProgram.exitOverride();

    await statusProgram.parseAsync(['node', 'code-memory', 'status', '--json']);

    const output = logSpy.mock.calls.map((call) => String(call[0])).join('\n');
    const status = JSON.parse(output) as {
      project: string;
      rootPath: string;
      languages: string[];
      embeddingProvider: string;
      embeddingModel: string;
      vectorSearch: string;
      files: number;
      symbols: number;
      chunks: number;
    };

    expect(status.project).toBe('sample-ts-project');
    expect(status.rootPath).toBe(tempRoot);
    expect(status.languages).toEqual(['typescript', 'javascript']);
    expect(status.embeddingProvider).toBe('none');
    expect(status.embeddingModel).toBe('none');
    expect(status.vectorSearch).toBe('disabled');
    expect(status.files).toBeGreaterThanOrEqual(14);
    expect(status.symbols).toBeGreaterThan(0);
    expect(status.chunks).toBeGreaterThan(0);
  });

  it('reports enabled vector search from status json when metadata proves it', async () => {
    const program = createCli();
    program.exitOverride();
    await program.parseAsync(['node', 'code-memory', 'index', '--full']);
    getDatabaseSync().run(
      `INSERT OR REPLACE INTO index_metadata (key, value) VALUES
        ('embedding_provider', 'ollama'),
        ('embedding_model', 'test-embed'),
        ('vector_search', 'enabled')`,
    );

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const statusProgram = createCli();
    statusProgram.exitOverride();

    await statusProgram.parseAsync(['node', 'code-memory', 'status', '--json']);

    const output = logSpy.mock.calls.map((call) => String(call[0])).join('\n');
    const status = JSON.parse(output) as {
      embeddingProvider: string;
      embeddingModel: string;
      vectorSearch: string;
    };

    expect(status.embeddingProvider).toBe('ollama');
    expect(status.embeddingModel).toBe('test-embed');
    expect(status.vectorSearch).toBe('enabled');
  });

  it('reports stale only until sync indexes the current working tree', async () => {
    execSync('git init', { cwd: tempRoot, stdio: 'ignore' });
    execSync('git config user.email code-memory-test@example.com', { cwd: tempRoot, stdio: 'ignore' });
    execSync('git config user.name "Code Memory Test"', { cwd: tempRoot, stdio: 'ignore' });
    writeFileSync(join(tempRoot, '.gitignore'), '.code-memory/\n', 'utf-8');
    execSync('git add .', { cwd: tempRoot, stdio: 'ignore' });
    execSync('git commit -m initial', { cwd: tempRoot, stdio: 'ignore' });

    const program = createCli();
    program.exitOverride();
    await program.parseAsync(['node', 'code-memory', 'index', '--full']);

    const targetFile = join(tempRoot, 'src', 'services', 'AuthService.ts');
    const originalContent = readFileSync(targetFile, 'utf-8');
    const updatedContent = originalContent.replace('Invalid credentials', 'Invalid login');
    expect(updatedContent).not.toBe(originalContent);
    writeFileSync(targetFile, updatedContent, 'utf-8');
    const gitStatus = execSync('git status --porcelain --untracked-files=all', { cwd: tempRoot, encoding: 'utf-8' });
    expect(gitStatus).toContain('src/services/AuthService.ts');

    const staleStatus = await readStatusJson(['status', '--json', '--staleness']);
    expect(staleStatus.staleness.indexStatus).toBe('stale');
    expect(staleStatus.staleness.changedFiles).toBeGreaterThan(0);

    const syncProgram = createCli();
    syncProgram.exitOverride();
    await syncProgram.parseAsync(['node', 'code-memory', 'sync', '--workers', '0']);

    const freshStatus = await readStatusJson(['status', '--json', '--staleness']);
    expect(freshStatus.staleness.indexStatus).toBe('fresh');
    expect(freshStatus.staleness.changedFiles).toBe(0);
  });

  it('prints watch sync failures in human-readable staleness status', async () => {
    const program = createCli();
    program.exitOverride();
    await program.parseAsync(['node', 'code-memory', 'index', '--full']);

    const db = getDatabaseSync();
    db.run(
      'INSERT OR REPLACE INTO index_metadata (key, value) VALUES (?, ?)',
      ['watch_sync_status', 'failed'],
    );
    db.run(
      'INSERT OR REPLACE INTO index_metadata (key, value) VALUES (?, ?)',
      ['last_watch_error', 'simulated status failure'],
    );
    db.run(
      'INSERT OR REPLACE INTO index_metadata (key, value) VALUES (?, ?)',
      ['last_watch_error_at', '2026-06-01T00:00:00.000Z'],
    );
    db.run(
      'INSERT OR REPLACE INTO index_metadata (key, value) VALUES (?, ?)',
      ['watch_last_trigger_reason', 'change'],
    );
    db.run(
      'INSERT OR REPLACE INTO index_metadata (key, value) VALUES (?, ?)',
      ['watch_last_changed_paths', JSON.stringify(['src/services/AuthService.ts'])],
    );
    db.run(
      'INSERT OR REPLACE INTO index_metadata (key, value) VALUES (?, ?)',
      ['watch_last_sync_duration_ms', '42'],
    );
    db.run(
      'INSERT OR REPLACE INTO index_metadata (key, value) VALUES (?, ?)',
      ['watch_pending_count', '1'],
    );

    const text = await readStatusText(['status', '--staleness']);
    expect(text).toContain('Watch Sync:  failed');
    expect(text).toContain('Watch Event: change');
    expect(text).toContain('Watch Paths: 1 tracked');
    expect(text).toContain('Pending:     1');
    expect(text).toContain('Watch Time:  42 ms');
    expect(text).toContain('Watch Error: simulated status failure');
    expect(text).toContain('Error Time:  2026-06-01T00:00:00.000Z');
  });

  it('reports watch sync failures and recommended action in staleness json', async () => {
    const program = createCli();
    program.exitOverride();
    await program.parseAsync(['node', 'code-memory', 'index', '--full']);

    const db = getDatabaseSync();
    db.run(
      'INSERT OR REPLACE INTO index_metadata (key, value) VALUES (?, ?)',
      ['watch_sync_status', 'failed'],
    );
    db.run(
      'INSERT OR REPLACE INTO index_metadata (key, value) VALUES (?, ?)',
      ['last_watch_error', 'simulated json watch failure'],
    );
    db.run(
      'INSERT OR REPLACE INTO index_metadata (key, value) VALUES (?, ?)',
      ['last_watch_error_at', '2026-06-01T00:00:00.000Z'],
    );
    db.run(
      'INSERT OR REPLACE INTO index_metadata (key, value) VALUES (?, ?)',
      ['watch_last_trigger_reason', 'unlink'],
    );
    db.run(
      'INSERT OR REPLACE INTO index_metadata (key, value) VALUES (?, ?)',
      ['watch_last_changed_paths', JSON.stringify(['src/services/AuthService.ts'])],
    );
    db.run(
      'INSERT OR REPLACE INTO index_metadata (key, value) VALUES (?, ?)',
      ['watch_last_sync_duration_ms', '99'],
    );
    db.run(
      'INSERT OR REPLACE INTO index_metadata (key, value) VALUES (?, ?)',
      ['watch_pending_count', '1'],
    );

    const status = await readStatusJson(['status', '--json', '--staleness']);

    expect(status.staleness.indexStatus).toBe('failed');
    expect(status.staleness.watchSyncStatus).toBe('failed');
    expect(status.staleness.watchLastTriggerReason).toBe('unlink');
    expect(status.staleness.watchLastChangedPaths).toEqual(['src/services/AuthService.ts']);
    expect(status.staleness.watchLastSyncDurationMs).toBe(99);
    expect(status.staleness.watchPendingCount).toBe(1);
    expect(status.staleness.lastWatchError).toBe('simulated json watch failure');
    expect(status.staleness.lastWatchErrorAt).toBe('2026-06-01T00:00:00.000Z');
    expect(status.staleness.recommendedAction).toBe(
      'inspect watch error and run code-memory sync after fixing it',
    );
  });
});

async function readStatusJson(args: string[]): Promise<{
  staleness: {
    indexStatus: string;
    changedFiles: number;
    watchSyncStatus?: string;
    watchLastChangedPaths?: string[];
    watchLastTriggerReason?: string;
    watchLastSyncDurationMs?: number;
    watchPendingCount?: number;
    lastWatchError?: string;
    lastWatchErrorAt?: string;
    recommendedAction?: string;
  };
}> {
  const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  try {
    const statusProgram = createCli();
    statusProgram.exitOverride();
    await statusProgram.parseAsync(['node', 'code-memory', ...args]);
    const output = logSpy.mock.calls.map((call) => String(call[0])).join('\n');
    return JSON.parse(output) as {
      staleness: {
        indexStatus: string;
        changedFiles: number;
        watchSyncStatus?: string;
        watchLastChangedPaths?: string[];
        watchLastTriggerReason?: string;
        watchLastSyncDurationMs?: number;
        watchPendingCount?: number;
        lastWatchError?: string;
        lastWatchErrorAt?: string;
        recommendedAction?: string;
      };
    };
  } finally {
    logSpy.mockRestore();
  }
}

async function readStatusText(args: string[]): Promise<string> {
  const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  try {
    const statusProgram = createCli();
    statusProgram.exitOverride();
    await statusProgram.parseAsync(['node', 'code-memory', ...args]);
    return logSpy.mock.calls.map((call) => String(call[0])).join('\n');
  } finally {
    logSpy.mockRestore();
  }
}
