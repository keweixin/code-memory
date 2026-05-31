import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DEFAULT_IGNORE_PATTERNS } from '../src/shared/constants.js';
import { DEFAULT_TOKEN_BUDGETS, type CodeMemoryConfig, type ParseResult } from '../src/shared/types.js';
import type { DiscoveredFile } from '../src/scanner/file-discovery.js';
import { IndexManager } from '../src/indexer/index-manager.js';
import { closeDatabase, getDatabaseSync } from '../src/storage/database.js';

function createManyFileProject(fileCount: number): { root: string; config: CodeMemoryConfig } {
  const root = mkdtempSync(join(tmpdir(), 'code-memory-streaming-'));
  mkdirSync(join(root, 'src'), { recursive: true });
  for (let i = 0; i < fileCount; i++) {
    writeFileSync(
      join(root, 'src', `file-${i}.ts`),
      `export function value${i}() { return ${i}; }\n`,
      'utf-8',
    );
  }

  const config: CodeMemoryConfig = {
    projectName: 'streaming-test',
    rootPath: root,
    ignore: [...DEFAULT_IGNORE_PATTERNS],
    languages: ['typescript'],
    embedding: {
      provider: 'none',
      model: 'none',
    },
    indexing: {
      workers: 0,
      parseBatchSize: 3,
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

describe('streaming index writes', () => {
  const roots: string[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    await closeDatabase();
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('uses the batched parser path instead of collecting all parse results first', async () => {
    const { root, config } = createManyFileProject(12);
    roots.push(root);
    const manager = new IndexManager(root, config);
    const parseAllSpy = vi.spyOn(manager as unknown as {
      parseDiscoveredFiles(files: DiscoveredFile[], workers: number): Promise<unknown[]>;
    }, 'parseDiscoveredFiles');
    const storeSpy = vi.spyOn(manager as unknown as {
      storeParseResult(result: ParseResult, discovered: DiscoveredFile): void;
    }, 'storeParseResult');

    await manager.fullIndex();

    expect(parseAllSpy).not.toHaveBeenCalled();
    expect(storeSpy).toHaveBeenCalledTimes(12);
    expect(Number(getDatabaseSync().exec('SELECT COUNT(*) FROM files')[0].values[0][0])).toBe(12);
  });
});
