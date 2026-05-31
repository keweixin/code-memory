import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import type { CodeMemoryConfig, SearchResult } from '../src/shared/types.js';
import { DEFAULT_TOKEN_BUDGETS } from '../src/shared/types.js';
import { DEFAULT_IGNORE_PATTERNS } from '../src/shared/constants.js';
import { IndexManager } from '../src/indexer/index-manager.js';
import { closeDatabase, getDatabaseSync } from '../src/storage/database.js';
import { HybridSearchEngine } from '../src/search/hybrid-search.js';

const fixtureRoot = resolve('tests/fixtures/sample-ts-project');

function createConfig(rootPath: string): CodeMemoryConfig {
  return {
    projectName: 'hybrid-search-enrichment',
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

describe('hybrid search enrichment', () => {
  let tempRoot: string;

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), 'code-memory-hybrid-enrich-'));
    cpSync(fixtureRoot, tempRoot, { recursive: true });
  });

  afterEach(async () => {
    await closeDatabase();
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it('batch-loads symbol and file metadata instead of querying per result', async () => {
    const config = createConfig(tempRoot);
    mkdirSync(join(tempRoot, '.code-memory'), { recursive: true });
    writeFileSync(join(tempRoot, '.code-memory', 'config.json'), JSON.stringify(config, null, 2), 'utf-8');
    await new IndexManager(tempRoot, config).fullIndex();

    const db = getDatabaseSync();
    const symbolIds = db.all<{ id: string }>('SELECT id FROM symbols LIMIT 4').map((row) => row.id);
    const fileIds = db.all<{ id: string }>('SELECT id FROM files LIMIT 2').map((row) => row.id);
    const merged = [...symbolIds, ...fileIds].map((id, index) => ({
      id,
      score: 1 / (index + 1),
      sources: ['keyword' as const],
    }));

    const execSpy = vi.spyOn(db, 'exec');
    const allSpy = vi.spyOn(db, 'all');
    const search = new HybridSearchEngine(db) as unknown as {
      enrichResults(results: typeof merged, limit: number): SearchResult[];
    };

    const enriched = search.enrichResults(merged, merged.length);

    expect(enriched).toHaveLength(merged.length);
    expect(allSpy).toHaveBeenCalledTimes(2);
    expect(execSpy).not.toHaveBeenCalled();
  });
});
