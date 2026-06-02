import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, cpSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { closeDatabase, getDatabase, getDatabaseSync } from '../../src/storage/database.js';
import { IndexManager } from '../../src/indexer/index-manager.js';
import { registerSearchCodeTool } from '../../src/mcp/tools/search-code.js';
import { registerFindDefinitionTool } from '../../src/mcp/tools/find-definition.js';
import { registerGetContextPackTool } from '../../src/mcp/tools/get-context-pack.js';
import { DEFAULT_IGNORE_PATTERNS } from '../../src/shared/constants.js';
import { DEFAULT_TOKEN_BUDGETS } from '../../src/shared/types.js';
import type { CodeMemoryConfig } from '../../src/shared/types.js';

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

describe('bench: query', () => {
  let tempRoot: string;
  let server: FakeMcpServer;

  beforeAll(async () => {
    tempRoot = mkdtempSync(join(tmpdir(), 'cm-bench-q-'));
    cpSync(fixtureRoot, tempRoot, { recursive: true });

    const config = createConfig(tempRoot);
    mkdirSync(join(tempRoot, '.code-memory'), { recursive: true });
    writeFileSync(
      join(tempRoot, '.code-memory', 'config.json'),
      JSON.stringify(config, null, 2),
      'utf-8',
    );

    await getDatabase(tempRoot);
    const manager = new IndexManager(tempRoot, config);
    await manager.fullIndex();
    await closeDatabase();

    // Re-open for query tools
    await getDatabase(tempRoot);
    const queryDb = getDatabaseSync();

    server = new FakeMcpServer();
    registerSearchCodeTool(server as never, queryDb);
    registerFindDefinitionTool(server as never, queryDb);
    registerGetContextPackTool(server as never, queryDb);
  });

  afterAll(async () => {
    await closeDatabase();
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it('measures get_context_pack response time', async () => {
    const handler = server.handlers.get('get_context_pack');
    if (!handler) {
      console.log('get_context_pack tool not registered, skipping');
      return;
    }

    const startMs = performance.now();
    const result = await handler({ query: 'main function', tokenBudget: 4000 });
    const elapsedMs = performance.now() - startMs;

    console.log(`get_context_pack time: ${elapsedMs.toFixed(0)}ms`);
    expect(elapsedMs).toBeLessThan(5000);
    expect(result.content[0].text).toBeDefined();
  });

  it('measures search_code response time', async () => {
    const handler = server.handlers.get('search_code');
    if (!handler) {
      console.log('search_code tool not registered, skipping');
      return;
    }

    const startMs = performance.now();
    const result = await handler({ query: 'login', limit: 15, searchMode: 'hybrid' });
    const elapsedMs = performance.now() - startMs;

    console.log(`search_code time: ${elapsedMs.toFixed(0)}ms`);
    expect(elapsedMs).toBeLessThan(5000);
    expect(result.content[0].text).toBeDefined();
  });

  it('measures find_definition response time', async () => {
    const handler = server.handlers.get('find_definition');
    if (!handler) {
      console.log('find_definition tool not registered, skipping');
      return;
    }

    const startMs = performance.now();
    const result = await handler({ symbolName: 'AuthService' });
    const elapsedMs = performance.now() - startMs;

    console.log(`find_definition time: ${elapsedMs.toFixed(0)}ms`);
    expect(elapsedMs).toBeLessThan(5000);
    expect(result.content[0].text).toBeDefined();
  });
});
