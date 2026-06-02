import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import type { CodeMemoryConfig } from '../src/shared/types.js';
import { DEFAULT_TOKEN_BUDGETS } from '../src/shared/types.js';
import { DEFAULT_IGNORE_PATTERNS } from '../src/shared/constants.js';
import { IndexManager } from '../src/indexer/index-manager.js';
import { closeDatabase } from '../src/storage/database.js';
import { HybridSearchEngine } from '../src/search/hybrid-search.js';
import { queryIndex } from '../src/cli/commands/query.js';

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

async function indexFixture(rootPath: string): Promise<void> {
  const config = createConfig(rootPath);
  mkdirSync(join(rootPath, '.code-memory'), { recursive: true });
  writeFileSync(
    join(rootPath, '.code-memory', 'config.json'),
    JSON.stringify(config, null, 2),
    'utf-8',
  );

  const manager = new IndexManager(rootPath, config);
  await manager.fullIndex();
}

describe('CLI query command', () => {
  let tempRoot: string;
  let originalCwd: string;

  beforeEach(async () => {
    originalCwd = process.cwd();
    tempRoot = mkdtempSync(join(tmpdir(), 'code-memory-cli-'));
    cpSync(fixtureRoot, tempRoot, { recursive: true });
    process.chdir(tempRoot);
    await indexFixture(tempRoot);
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    vi.restoreAllMocks();
    await closeDatabase();
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it('passes --mode through to the hybrid search engine', async () => {
    const searchSpy = vi
      .spyOn(HybridSearchEngine.prototype, 'searchCode')
      .mockResolvedValue([]);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await queryIndex('login', {
      limit: '3',
      mode: 'graph',
      json: true,
    });

    expect(searchSpy).toHaveBeenCalledWith('login', {
      limit: 3,
      searchMode: 'graph',
    });
    expect(logSpy).toHaveBeenCalledWith('[]');
  });

  it('defaults to hybrid mode for CLI queries', async () => {
    const searchSpy = vi
      .spyOn(HybridSearchEngine.prototype, 'searchCode')
      .mockResolvedValue([]);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await queryIndex('login', {
      limit: '3',
      json: true,
    });

    expect(searchSpy).toHaveBeenCalledWith('login', {
      limit: 3,
      searchMode: 'hybrid',
    });
    expect(logSpy).toHaveBeenCalledWith('[]');
  });

  it('falls back invalid CLI search modes to hybrid', async () => {
    const searchSpy = vi
      .spyOn(HybridSearchEngine.prototype, 'searchCode')
      .mockResolvedValue([]);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await queryIndex('login', {
      limit: '3',
      mode: 'typo',
      json: true,
    });

    expect(searchSpy).toHaveBeenCalledWith('login', {
      limit: 3,
      searchMode: 'hybrid',
    });
    expect(logSpy).toHaveBeenCalledWith('[]');
  });

  it('passes vector mode through to the hybrid search engine', async () => {
    const searchSpy = vi
      .spyOn(HybridSearchEngine.prototype, 'searchCode')
      .mockResolvedValue([]);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await queryIndex('login', {
      limit: '3',
      mode: 'vector',
      json: true,
    });

    expect(searchSpy).toHaveBeenCalledWith('login', {
      limit: 3,
      searchMode: 'vector',
    });
    expect(logSpy).toHaveBeenCalledWith('[]');
  });
});
