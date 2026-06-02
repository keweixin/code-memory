import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import type { CodeMemoryConfig, SearchResult } from '../src/shared/types.js';
import { DEFAULT_TOKEN_BUDGETS } from '../src/shared/types.js';
import { DEFAULT_IGNORE_PATTERNS } from '../src/shared/constants.js';
import { IndexManager } from '../src/indexer/index-manager.js';
import { closeDatabase, getDatabaseSync } from '../src/storage/database.js';
import { HybridSearchEngine } from '../src/search/hybrid-search.js';
import { markContextUsed } from '../src/memory/context-ledger.js';

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

function ledgerSymbolKey(result: SearchResult): string {
  return [
    result.filePath,
    result.name,
    result.kind,
    result.lineRange?.[0] ?? 0,
    result.lineRange?.[1] ?? 0,
  ].join(':');
}

function ledgerChunkKey(result: SearchResult): string {
  return [
    result.filePath,
    result.name || 'file',
    result.lineRange?.[0] ?? 0,
    result.lineRange?.[1] ?? 0,
  ].join(':');
}

describe('hybrid search ledger-aware reranking', () => {
  let tempRoot: string;

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), 'code-memory-ledger-rerank-'));
    cpSync(fixtureRoot, tempRoot, { recursive: true });
  });

  afterEach(async () => {
    await closeDatabase();
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it('lowers repeated files, symbols, and chunks before context packing', async () => {
    await indexFixture(tempRoot);
    const search = new HybridSearchEngine(getDatabaseSync());

    const baseline = await search.searchCode('login', {
      limit: 50,
      searchMode: 'keyword',
    });
    const login = baseline.find((result) =>
      result.name === 'login' &&
      result.filePath === 'src/services/AuthService.ts'
    );
    expect(login).toBeDefined();

    markContextUsed({
      sessionId: 'ledger-rerank',
      query: 'login',
      returnedFiles: [login!.filePath],
      returnedSymbols: [ledgerSymbolKey(login!)],
      returnedChunks: [ledgerChunkKey(login!)],
      tokenEstimate: 500,
      evidenceIds: ['symbol:' + login!.id],
    });

    const reranked = await search.searchCode('login', {
      limit: 50,
      searchMode: 'keyword',
      sessionId: 'ledger-rerank',
      avoidRepeated: true,
    });
    const repeatedLogin = reranked.find((result) => result.id === login!.id);

    expect(repeatedLogin).toBeDefined();
    expect(repeatedLogin!.score).toBeLessThan(login!.score);
    expect(repeatedLogin!.scoreBreakdown?.ledgerPenalty).toBeGreaterThan(0);
    expect(repeatedLogin!.scoreBreakdown?.finalScore).toBe(repeatedLogin!.score);
  });

  it('exposes rank-based RRF score breakdown instead of raw score fusion', async () => {
    await indexFixture(tempRoot);
    const search = new HybridSearchEngine(getDatabaseSync());

    const results = await search.searchCode('login', {
      limit: 10,
      searchMode: 'keyword',
    });
    const login = results.find((result) =>
      result.name === 'login' &&
      result.filePath === 'src/services/AuthService.ts'
    );

    expect(login).toBeDefined();
    expect(login!.scoreBreakdown).toEqual(expect.objectContaining({
      keywordRank: expect.any(Number),
      rrfKeyword: expect.any(Number),
      finalScore: login!.score,
    }));
    expect(login!.scoreBreakdown?.vectorRank).toBeUndefined();
    expect(login!.scoreBreakdown?.rrfVector).toBeUndefined();
  });

  it('does not penalize repeated context unless avoidRepeated is enabled', async () => {
    await indexFixture(tempRoot);
    const search = new HybridSearchEngine(getDatabaseSync());

    const baseline = await search.searchCode('login', {
      limit: 50,
      searchMode: 'keyword',
    });
    const login = baseline.find((result) =>
      result.name === 'login' &&
      result.filePath === 'src/services/AuthService.ts'
    );
    expect(login).toBeDefined();

    markContextUsed({
      sessionId: 'ledger-rerank-disabled',
      query: 'login',
      returnedFiles: [login!.filePath],
      returnedSymbols: [ledgerSymbolKey(login!)],
      returnedChunks: [ledgerChunkKey(login!)],
      tokenEstimate: 500,
    });

    const unpenalized = await search.searchCode('login', {
      limit: 50,
      searchMode: 'keyword',
      sessionId: 'ledger-rerank-disabled',
      avoidRepeated: false,
    });
    const sameLogin = unpenalized.find((result) => result.id === login!.id);

    expect(sameLogin).toBeDefined();
    expect(sameLogin!.scoreBreakdown?.ledgerPenalty).toBeUndefined();
  });
});
