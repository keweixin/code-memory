import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DEFAULT_IGNORE_PATTERNS } from '../src/shared/constants.js';
import { DEFAULT_TOKEN_BUDGETS, type CodeMemoryConfig } from '../src/shared/types.js';
import { contentHash } from '../src/shared/utils.js';
import { closeDatabase, getDatabaseSync } from '../src/storage/database.js';
import * as gitIntegration from '../src/scanner/git-integration.js';

vi.mock('../src/scanner/git-integration.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/scanner/git-integration.js')>();
  return {
    ...actual,
    getFileContentHash: vi.fn(actual.getFileContentHash),
  };
});

function createConfig(rootPath: string): CodeMemoryConfig {
  return {
    projectName: 'hash-io-test',
    rootPath,
    ignore: [...DEFAULT_IGNORE_PATTERNS],
    languages: ['typescript'],
    indexing: {
      workers: 0,
      parseBatchSize: 10,
      edgeMode: 'full',
    },
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

function writeConfig(rootPath: string, config = createConfig(rootPath)): void {
  mkdirSync(join(rootPath, '.code-memory'), { recursive: true });
  writeFileSync(join(rootPath, '.code-memory', 'config.json'), JSON.stringify(config, null, 2), 'utf-8');
}

function queryValue(sql: string, params: unknown[] = []): unknown {
  return getDatabaseSync().exec(sql, params)[0]?.values[0]?.[0];
}

describe('index hash I/O boundaries', () => {
  let tempRoot: string;

  afterEach(async () => {
    vi.clearAllMocks();
    await closeDatabase();
    if (tempRoot) rmSync(tempRoot, { recursive: true, force: true });
  });

  it('stores parser-provided content hashes without hashing parsed source files again', async () => {
    tempRoot = mkdtempSync(join(tmpdir(), 'code-memory-hash-io-'));
    mkdirSync(join(tempRoot, 'src'), { recursive: true });
    const source = [
      'export function login(): string {',
      "  return 'ok';",
      '}',
      '',
    ].join('\n');
    writeFileSync(join(tempRoot, 'src', 'main.ts'), source, 'utf-8');
    const config = createConfig(tempRoot);
    writeConfig(tempRoot, config);

    const { IndexManager } = await import('../src/indexer/index-manager.js');
    await new IndexManager(tempRoot, config).fullIndex();

    expect(gitIntegration.getFileContentHash).not.toHaveBeenCalled();
    expect(queryValue("SELECT hash FROM files WHERE path = 'src/main.ts'")).toBe(contentHash(source));
  });

  it('hashes existing files only during incremental dirty detection, not during parse storage', async () => {
    tempRoot = mkdtempSync(join(tmpdir(), 'code-memory-hash-io-'));
    mkdirSync(join(tempRoot, 'src'), { recursive: true });
    writeFileSync(join(tempRoot, 'src', 'main.ts'), 'export const value = 1;\n', 'utf-8');
    const config = createConfig(tempRoot);
    writeConfig(tempRoot, config);

    const { IndexManager } = await import('../src/indexer/index-manager.js');
    await new IndexManager(tempRoot, config).fullIndex();
    vi.clearAllMocks();

    const changedSource = 'export const value = 2;\n';
    writeFileSync(join(tempRoot, 'src', 'main.ts'), changedSource, 'utf-8');
    await new IndexManager(tempRoot, config).incrementalIndex();

    expect(gitIntegration.getFileContentHash).toHaveBeenCalledTimes(1);
    expect(queryValue("SELECT hash FROM files WHERE path = 'src/main.ts'")).toBe(contentHash(changedSource));
  });
});
