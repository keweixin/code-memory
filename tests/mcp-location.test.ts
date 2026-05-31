import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import type { CodeMemoryConfig } from '../src/shared/types.js';
import { DEFAULT_TOKEN_BUDGETS } from '../src/shared/types.js';
import { DEFAULT_IGNORE_PATTERNS } from '../src/shared/constants.js';
import { IndexManager } from '../src/indexer/index-manager.js';
import { getDatabaseSync, closeDatabase } from '../src/storage/database.js';
import { registerFindDefinitionTool } from '../src/mcp/tools/find-definition.js';
import { registerFindReferencesTool } from '../src/mcp/tools/find-references.js';
import { registerGetRelatedTestsTool } from '../src/mcp/tools/get-related-tests.js';
import { registerSearchCodeTool } from '../src/mcp/tools/search-code.js';
import { registerSearchSymbolsTool } from '../src/mcp/tools/search-symbols.js';
import { registerExplainModuleTool } from '../src/mcp/tools/explain-module.js';
import { registerGetCallGraphTool } from '../src/mcp/tools/get-call-graph.js';
import { registerImpactAnalysisTool } from '../src/mcp/tools/impact-analysis.js';

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

describe('MCP location output', () => {
  let tempRoot: string;

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), 'code-memory-mcp-'));
    cpSync(fixtureRoot, tempRoot, { recursive: true });
  });

  afterEach(async () => {
    await closeDatabase();
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it('reports definition locations with line and column coordinates', async () => {
    await indexFixture(tempRoot);
    const server = new FakeMcpServer();
    registerFindDefinitionTool(server as never, getDatabaseSync());

    const result = await server.handlers.get('find_definition')!({
      symbolName: 'login',
      filePath: 'src/services/AuthService.ts',
    });
    const text = result.content[0].text;

    expect(text).toContain('Location: src/services/AuthService.ts:24:');
    expect(text).toMatch(/Location: src\/services\/AuthService\.ts:24:\d+-45:\d+/);
    expect(text).not.toContain('Lines: 24-45');
  });

  it('reports reference locations with line and column coordinates', async () => {
    await indexFixture(tempRoot);
    const server = new FakeMcpServer();
    registerFindReferencesTool(server as never, getDatabaseSync());

    const result = await server.handlers.get('find_references')!({
      symbolName: 'findUserByEmail',
      maxResults: 10,
    });
    const text = result.content[0].text;

    expect(text).toMatch(/src\/services\/AuthService\.ts:24:\d+-45:\d+/);
    expect(text).not.toContain('Line 24:');
  });

  it('reports file-level import references from REFERENCES graph edges', async () => {
    await indexFixture(tempRoot);
    const server = new FakeMcpServer();
    registerFindReferencesTool(server as never, getDatabaseSync());

    const result = await server.handlers.get('find_references')!({
      symbolName: 'TokenPair',
      maxResults: 10,
    });
    const text = result.content[0].text;

    expect(text).toMatch(/src\/services\/AuthService\.ts:7:\d+-7:\d+: referenced by AuthService\.ts \(file\)/);
  });

  it('uses TESTS graph edges when finding related tests for a source file', async () => {
    await indexFixture(tempRoot);
    const server = new FakeMcpServer();
    registerGetRelatedTestsTool(server as never, getDatabaseSync());

    const result = await server.handlers.get('get_related_tests')!({
      target: 'src/services/AuthService.ts',
    });
    const text = result.content[0].text;

    expect(text).toContain('tests/auth.test.js');
    expect(text).toContain('Method: graph (TESTS edge)');
  });

  it('includes file-level TESTS graph edges in impact analysis for a source file', async () => {
    await indexFixture(tempRoot);
    const server = new FakeMcpServer();
    registerImpactAnalysisTool(server as never, getDatabaseSync());

    const result = await server.handlers.get('impact_analysis')!({
      target: 'src/services/AuthService.ts',
    });
    const text = result.content[0].text;

    expect(text).toContain('tests/auth.test.js');
    expect(text).toContain('Test: auth.test.js');
  });

  it('reports search_code result locations with line and column coordinates', async () => {
    await indexFixture(tempRoot);
    const server = new FakeMcpServer();
    registerSearchCodeTool(server as never, getDatabaseSync());

    const result = await server.handlers.get('search_code')!({
      query: 'login',
      limit: 5,
      searchMode: 'keyword',
    });
    const text = result.content[0].text;

    expect(text).toMatch(/Location: src\/services\/AuthService\.ts:\d+:\d+-\d+:\d+/);
    expect(text).not.toContain('Lines:');
  });

  it('reports search_symbols result locations with line and column coordinates', async () => {
    await indexFixture(tempRoot);
    const server = new FakeMcpServer();
    registerSearchSymbolsTool(server as never, getDatabaseSync());

    const result = await server.handlers.get('search_symbols')!({
      query: 'login',
      kind: 'method',
      limit: 5,
    });
    const text = result.content[0].text;

    expect(text).toMatch(/Location: src\/services\/AuthService\.ts:24:\d+-45:\d+/);
    expect(text).not.toContain('Lines: 24-45');
  });

  it('reports explain_module symbol locations with line and column coordinates', async () => {
    await indexFixture(tempRoot);
    const server = new FakeMcpServer();
    registerExplainModuleTool(server as never, getDatabaseSync());

    const result = await server.handlers.get('explain_module')!({
      filePath: 'src/services/AuthService.ts',
    });
    const text = result.content[0].text;

    expect(text).toMatch(/src\/services\/AuthService\.ts:24:\d+-45:\d+: login/);
    expect(text).not.toContain('L24-L45');
  });

  it('reports get_call_graph node locations with line and column coordinates', async () => {
    await indexFixture(tempRoot);
    const server = new FakeMcpServer();
    registerGetCallGraphTool(server as never, getDatabaseSync());

    const result = await server.handlers.get('get_call_graph')!({
      symbolName: 'login',
      depth: 1,
    });
    const text = result.content[0].text;

    expect(text).toMatch(/login \[method\] \(src\/services\/AuthService\.[jt]s:\d+:\d+-\d+:\d+\)/);
    expect(text).not.toMatch(/login \[method\] \(src\/services\/AuthService\.[jt]s\)/);
  });
});
