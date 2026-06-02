import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import type { CodeMemoryConfig } from '../src/shared/types.js';
import { DEFAULT_TOKEN_BUDGETS } from '../src/shared/types.js';
import { DEFAULT_IGNORE_PATTERNS } from '../src/shared/constants.js';
import { IndexManager } from '../src/indexer/index-manager.js';
import { closeDatabase, getDatabase, getDatabaseSync, openExistingDatabase } from '../src/storage/database.js';
import { registerSearchCodeTool } from '../src/mcp/tools/search-code.js';
import { registerGetContextPackTool } from '../src/mcp/tools/get-context-pack.js';

const fixtureRoot = resolve('tests/fixtures/sample-ts-project');

type ToolResult = Promise<{ content: Array<{ type: 'text'; text: string }> }>;
type ToolHandler = (args: Record<string, unknown>) => ToolResult;

class FakeMcpServer {
  readonly handlers = new Map<string, ToolHandler>();

  tool(
    name: string,
    _description: string,
    _schema: unknown,
    handler: ToolHandler,
  ): void {
    this.handlers.set(name, handler);
  }
}

function createConfig(rootPath: string, projectName = 'sample-ts-project'): CodeMemoryConfig {
  return {
    projectName,
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

function queryRows(sql: string, params: unknown[] = []): unknown[][] {
  const rows = getDatabaseSync().exec(sql, params);
  return rows[0]?.values ?? [];
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

async function indexMinimalProject(rootPath: string, projectName: string, symbolName: string): Promise<void> {
  mkdirSync(join(rootPath, 'src'), { recursive: true });
  mkdirSync(join(rootPath, '.code-memory'), { recursive: true });
  writeFileSync(
    join(rootPath, 'src', 'index.ts'),
    `export function ${symbolName}(): string {\n  return "${symbolName}";\n}\n`,
    'utf-8',
  );
  const config = createConfig(rootPath, projectName);
  writeFileSync(
    join(rootPath, '.code-memory', 'config.json'),
    JSON.stringify(config, null, 2),
    'utf-8',
  );

  const manager = new IndexManager(rootPath, config);
  await manager.fullIndex();
}

function querySymbolIdForRepo(rootPath: string, symbolName: string): string {
  const db = openExistingDatabase(rootPath);
  try {
    const row = db.get<{ id: string }>(
      `SELECT s.id
       FROM symbols s
       WHERE s.name = ?
       LIMIT 1`,
      [symbolName],
    );
    if (!row) throw new Error('Missing symbol ' + symbolName);
    return row.id;
  } finally {
    db.close();
  }
}

describe('MCP vector search', () => {
  let tempRoot: string;

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), 'code-memory-mcp-vector-'));
    cpSync(fixtureRoot, tempRoot, { recursive: true });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await closeDatabase();
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it('passes vector mode through search_code when a vector provider is available', async () => {
    await indexFixture(tempRoot);
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
    const server = new FakeMcpServer();
    registerSearchCodeTool(server as never, getDatabaseSync(), vectorProvider as never);

    const result = await server.handlers.get('search_code')!({
      query: 'semantic token minting',
      limit: 5,
      searchMode: 'vector',
    });
    const text = result.content[0].text;

    expect(vectorProvider.search).toHaveBeenCalled();
    expect(text).toContain('issueTokens (function)');
    expect(text).toContain('Sources: vector');
  });

  it('routes vector providers by repo instead of reusing the default provider', async () => {
    const firstRoot = join(tempRoot, 'first');
    const secondRoot = join(tempRoot, 'second');
    await indexMinimalProject(firstRoot, 'first-project', 'alphaOnly');
    await closeDatabase();
    await indexMinimalProject(secondRoot, 'second-project', 'betaOnly');
    await closeDatabase();

    const alphaId = querySymbolIdForRepo(firstRoot, 'alphaOnly');
    const betaId = querySymbolIdForRepo(secondRoot, 'betaOnly');
    await getDatabase(firstRoot);

    const defaultProvider = {
      isAvailable: () => true,
      search: vi.fn(async () => [{ id: alphaId, rank: 1 }]),
    };
    const routedProvider = {
      isAvailable: () => true,
      search: vi.fn(async () => [{ id: betaId, rank: 1 }]),
    };
    const resolver = vi.fn(async (projectRoot: string) => {
      expect(projectRoot).toBe(secondRoot);
      return routedProvider as never;
    });
    const server = new FakeMcpServer();
    registerSearchCodeTool(
      server as never,
      getDatabaseSync(),
      defaultProvider as never,
      resolver,
    );

    const routedResult = await server.handlers.get('search_code')!({
      repo: secondRoot,
      query: 'semantic beta',
      limit: 5,
      searchMode: 'vector',
    });
    const routedText = routedResult.content[0].text;

    expect(resolver).toHaveBeenCalledWith(secondRoot);
    expect(routedProvider.search).toHaveBeenCalled();
    expect(defaultProvider.search).not.toHaveBeenCalled();
    expect(routedText).toContain('betaOnly (function)');
    expect(routedText).not.toContain('alphaOnly (function)');

    const defaultResult = await server.handlers.get('search_code')!({
      query: 'semantic alpha',
      limit: 5,
      searchMode: 'vector',
    });
    const defaultText = defaultResult.content[0].text;

    expect(defaultProvider.search).toHaveBeenCalledTimes(1);
    expect(routedProvider.search).toHaveBeenCalledTimes(1);
    expect(defaultText).toContain('alphaOnly (function)');
    expect(defaultText).not.toContain('betaOnly (function)');
  });

  it('routes get_context_pack vector search through the target repo provider', async () => {
    const firstRoot = join(tempRoot, 'first-context');
    const secondRoot = join(tempRoot, 'second-context');
    await indexMinimalProject(firstRoot, 'first-context-project', 'alphaOnlyContext');
    await closeDatabase();
    await indexMinimalProject(secondRoot, 'second-context-project', 'betaOnlyContext');
    await closeDatabase();

    const alphaId = querySymbolIdForRepo(firstRoot, 'alphaOnlyContext');
    const betaId = querySymbolIdForRepo(secondRoot, 'betaOnlyContext');
    await getDatabase(firstRoot);

    const defaultProvider = {
      isAvailable: () => true,
      search: vi.fn(async () => [{ id: alphaId, rank: 1 }]),
    };
    const routedProvider = {
      isAvailable: () => true,
      search: vi.fn(async () => [{ id: betaId, rank: 1 }]),
    };
    const resolver = vi.fn(async (projectRoot: string) => {
      expect(projectRoot).toBe(secondRoot);
      return routedProvider as never;
    });
    const server = new FakeMcpServer();
    registerGetContextPackTool(
      server as never,
      getDatabaseSync(),
      defaultProvider as never,
      resolver,
    );

    const result = await server.handlers.get('get_context_pack')!({
      repo: secondRoot,
      query: 'semantic routed context',
      tokenBudget: 2000,
      levels: 'L4',
    });
    const text = result.content[0].text;

    expect(resolver).toHaveBeenCalledWith(secondRoot);
    expect(routedProvider.search).toHaveBeenCalled();
    expect(defaultProvider.search).not.toHaveBeenCalled();
    expect(text).toContain('betaOnlyContext');
    expect(text).not.toContain('alphaOnlyContext');
  });
});
