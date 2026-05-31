import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import type { CodeMemoryConfig } from '../src/shared/types.js';
import { DEFAULT_TOKEN_BUDGETS } from '../src/shared/types.js';
import { DEFAULT_IGNORE_PATTERNS } from '../src/shared/constants.js';
import { IndexManager } from '../src/indexer/index-manager.js';
import { closeDatabase, getDatabaseSync } from '../src/storage/database.js';
import { HybridSearchEngine } from '../src/search/hybrid-search.js';
import { ContextPacker } from '../src/search/context-packer.js';

const fixtureRoot = resolve('tests/fixtures/sample-ts-project');

function createConfig(rootPath: string): CodeMemoryConfig {
  return {
    projectName: 'context-pack-quality',
    rootPath,
    ignore: [...DEFAULT_IGNORE_PATTERNS],
    languages: ['typescript', 'javascript'],
    indexing: {
      workers: 0,
      parseBatchSize: 20,
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

describe('context pack quality', () => {
  let tempRoot: string;

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), 'code-memory-context-quality-'));
    cpSync(fixtureRoot, tempRoot, { recursive: true });
  });

  afterEach(async () => {
    await closeDatabase();
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it('returns real snippets and explains why they were selected', async () => {
    const config = createConfig(tempRoot);
    mkdirSync(join(tempRoot, '.code-memory'), { recursive: true });
    writeFileSync(join(tempRoot, '.code-memory', 'config.json'), JSON.stringify(config, null, 2), 'utf-8');
    const manager = new IndexManager(tempRoot, config);
    await manager.fullIndex();

    const db = getDatabaseSync();
    const results = await new HybridSearchEngine(db).searchCode('login', {
      searchMode: 'hybrid',
      limit: 5,
    });
    const pack = await new ContextPacker(db).pack('login', results, {
      tokenBudget: 8000,
      includeProjectCard: true,
      includeMemories: true,
      maxLevel: 'L4',
    });

    expect(pack.codeSnippets.length).toBeGreaterThan(0);
    expect(pack.codeSnippets.some((snippet) => snippet.content.includes('login'))).toBe(true);
    expect(pack.codeSnippets[0].reason).toMatch(/score|Matched|graph|keyword/i);
    expect(pack.files[0].language).not.toBe('unknown');
  }, 20_000);
});
