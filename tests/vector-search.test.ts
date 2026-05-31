import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import type { CodeMemoryConfig } from '../src/shared/types.js';
import { DEFAULT_TOKEN_BUDGETS } from '../src/shared/types.js';
import { DEFAULT_IGNORE_PATTERNS } from '../src/shared/constants.js';
import { IndexManager } from '../src/indexer/index-manager.js';
import { closeDatabase, getDatabaseSync } from '../src/storage/database.js';
import { HybridSearchEngine } from '../src/search/hybrid-search.js';
import { closeVectorStore, searchVectors } from '../src/search/vector-search.js';

const fixtureRoot = resolve('tests/fixtures/sample-ts-project');

function createConfig(rootPath: string, embedding = true): CodeMemoryConfig {
  return {
    projectName: 'sample-ts-project',
    rootPath,
    ignore: [...DEFAULT_IGNORE_PATTERNS],
    languages: ['typescript', 'javascript'],
    embedding: embedding
      ? {
          provider: 'ollama',
          model: 'test-embed',
          baseUrl: 'http://embedding.local',
          dimensions: 3,
        }
      : {
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

function queryRows(sql: string, params: unknown[] = []): unknown[][] {
  const rows = getDatabaseSync().exec(sql, params);
  return rows[0]?.values ?? [];
}

function vectorFor(text: string): number[] {
  if (text.includes('async login')) return [1, 0, 0];
  if (text.includes('issueTokens')) return [0, 1, 0];
  return [0, 0, 1];
}

async function indexFixture(rootPath: string, config = createConfig(rootPath)): Promise<void> {
  mkdirSync(join(rootPath, '.code-memory'), { recursive: true });
  writeFileSync(
    join(rootPath, '.code-memory', 'config.json'),
    JSON.stringify(config, null, 2),
    'utf-8',
  );

  const manager = new IndexManager(rootPath, config);
  await manager.fullIndex();
}

describe('vector-backed hybrid search', () => {
  let tempRoot: string;

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), 'code-memory-vector-'));
    cpSync(fixtureRoot, tempRoot, { recursive: true });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    closeVectorStore();
    await closeDatabase();
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it('generates chunk embeddings during indexing and makes them searchable', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body || '{}')) as { prompt?: string };
      return new Response(JSON.stringify({ embedding: vectorFor(body.prompt || '') }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }));

    await indexFixture(tempRoot);

    const embeddedChunks = queryRows(
      `SELECT s.name
       FROM chunks c
       JOIN symbols s ON s.id = c.symbol_id
       WHERE c.embedding_id IS NOT NULL
       ORDER BY s.name`,
    ).map(([name]) => String(name));
    expect(embeddedChunks).toEqual(expect.arrayContaining(['login', 'issueTokens']));

    const vectorResults = await searchVectors([1, 0, 0], {
      query: 'login flow',
      queryVector: [1, 0, 0],
      limit: 5,
    });

    expect(vectorResults).toContainEqual(expect.objectContaining({
      name: 'login',
      kind: 'method',
      filePath: 'src/services/AuthService.ts',
    }));
  });

  it('merges vector results into hybrid search when a vector provider is available', async () => {
    await indexFixture(tempRoot, createConfig(tempRoot, false));
    const issueTokensId = String(queryRows(
      `SELECT s.id
       FROM symbols s
       JOIN files f ON f.id = s.file_id
       WHERE s.name = 'issueTokens'
         AND f.path = 'src/services/token-service.ts'`,
    )[0][0]);
    const vectorProvider = {
      isAvailable: () => true,
      search: vi.fn(async () => [{ id: issueTokensId, rank: 1 }]),
    };

    const search = new HybridSearchEngine(
      getDatabaseSync(),
      undefined,
      vectorProvider as never,
    );
    const results = await search.search({
      query: 'semantic token minting',
      searchMode: 'hybrid',
      limit: 10,
    });

    expect(vectorProvider.search).toHaveBeenCalledWith('semantic token minting', {
      limit: 20,
      kindFilter: undefined,
      fileFilter: undefined,
    });
    const issueTokens = results.find((result) => result.name === 'issueTokens');
    expect(issueTokens?.sources).toContain('vector');
  });

  it('opens a separate vector store when indexing a different project in the same process', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body || '{}')) as { prompt?: string };
      return new Response(JSON.stringify({ embedding: vectorFor(body.prompt || '') }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }));

    await indexFixture(tempRoot);
    const secondRoot = mkdtempSync(join(tmpdir(), 'code-memory-vector-second-'));
    try {
      cpSync(fixtureRoot, secondRoot, { recursive: true });
      await closeDatabase();
      await indexFixture(secondRoot);

      expect(existsSync(join(tempRoot, '.code-memory', 'vectors'))).toBe(true);
      expect(existsSync(join(secondRoot, '.code-memory', 'vectors'))).toBe(true);
    } finally {
      rmSync(secondRoot, { recursive: true, force: true });
    }
  });

  it('does not mark vector search enabled when no chunk embedding succeeds', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('offline', { status: 503 })));

    await indexFixture(tempRoot);

    const embeddedChunkCount = Number(queryRows(
      'SELECT COUNT(*) FROM chunks WHERE embedding_id IS NOT NULL',
    )[0][0]);
    const vectorSearch = String(queryRows(
      "SELECT value FROM index_metadata WHERE key = 'vector_search'",
    )[0][0]);

    expect(embeddedChunkCount).toBe(0);
    expect(vectorSearch).toBe('disabled');
  });

  it('keeps vector search enabled after an incremental index with no file changes', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body || '{}')) as { prompt?: string };
      return new Response(JSON.stringify({ embedding: vectorFor(body.prompt || '') }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }));

    const config = createConfig(tempRoot);
    await indexFixture(tempRoot, config);

    const manager = new IndexManager(tempRoot, config);
    await manager.incrementalIndex();

    const embeddedChunkCount = Number(queryRows(
      'SELECT COUNT(*) FROM chunks WHERE embedding_id IS NOT NULL',
    )[0][0]);
    const vectorSearch = String(queryRows(
      "SELECT value FROM index_metadata WHERE key = 'vector_search'",
    )[0][0]);

    expect(embeddedChunkCount).toBeGreaterThan(0);
    expect(vectorSearch).toBe('enabled');
  });
});
