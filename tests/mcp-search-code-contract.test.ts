import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import type { CodeMemoryConfig } from '../src/shared/types.js';
import { DEFAULT_TOKEN_BUDGETS } from '../src/shared/types.js';
import { DEFAULT_IGNORE_PATTERNS } from '../src/shared/constants.js';
import { IndexManager } from '../src/indexer/index-manager.js';
import { closeDatabase, getDatabaseSync } from '../src/storage/database.js';
import { registerSearchCodeTool } from '../src/mcp/tools/search-code.js';
import { markContextUsed } from '../src/memory/context-ledger.js';

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

describe('MCP search_code contract', () => {
  let tempRoot: string;

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), 'code-memory-search-contract-'));
    cpSync(fixtureRoot, tempRoot, { recursive: true });
  });

  afterEach(async () => {
    await closeDatabase();
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it('surfaces intent diagnostics and score breakdowns', async () => {
    await indexFixture(tempRoot);
    const server = new FakeMcpServer();
    registerSearchCodeTool(server as never, getDatabaseSync());

    const result = await server.handlers.get('search_code')!({
      query: 'login',
      limit: 5,
      searchMode: 'hybrid',
      intent: 'debug',
    });
    const text = result.content[0].text;

    expect(text).toContain('=== Index Diagnostics ===');
    expect(text).toContain('Index status:');
    expect(text).toContain('Changed files:');
    expect(text).toContain('Intent: debug');
    expect(text).toContain('Graph profile:');
    expect(text).toContain('Score breakdown:');
    expect(text).toMatch(/Score breakdown: .*finalScore=\d+\.\d{3}/);
  });

  it('surfaces rank-based keyword score breakdowns for file content matches', async () => {
    await indexFixture(tempRoot);
    const server = new FakeMcpServer();
    registerSearchCodeTool(server as never, getDatabaseSync());

    const result = await server.handlers.get('search_code')!({
      query: 'login',
      limit: 5,
      searchMode: 'keyword',
    });
    const text = result.content[0].text;

    expect(text).toMatch(/Score breakdown: .*keywordRank=\d+/);
    expect(text).toMatch(/Score breakdown: .*rrfKeyword=\d+\.\d{3}/);
    expect(text).toMatch(/Score breakdown: .*finalScore=\d+\.\d{3}/);
  });

  it('honors session ledger parameters by reporting repeated-context penalties', async () => {
    await indexFixture(tempRoot);
    markContextUsed({
      sessionId: 'search-code-ledger',
      query: 'login',
      returnedFiles: ['src/services/AuthService.ts'],
      tokenEstimate: 250,
    });

    const server = new FakeMcpServer();
    registerSearchCodeTool(server as never, getDatabaseSync());

    const result = await server.handlers.get('search_code')!({
      query: 'login',
      limit: 50,
      searchMode: 'keyword',
      sessionId: 'search-code-ledger',
      avoidRepeated: true,
    });
    const text = result.content[0].text;

    expect(text).toContain('Ledger: penalized=');
    expect(text).toContain('Ledger penalty:');
  });
});
