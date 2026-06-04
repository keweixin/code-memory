import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import type { CodeMemoryConfig } from '../src/shared/types.js';
import { DEFAULT_TOKEN_BUDGETS } from '../src/shared/types.js';
import { DEFAULT_IGNORE_PATTERNS } from '../src/shared/constants.js';
import { IndexManager } from '../src/indexer/index-manager.js';
import { closeDatabase, getDatabaseSync } from '../src/storage/database.js';
import { registerGetRepoMapTool } from '../src/mcp/tools/get-repo-map.js';

const fixtureRoot = resolve('tests/fixtures/sample-ts-project');

type ToolResult = Promise<{ content: Array<{ type: 'text'; text: string }> }>;
type ToolHandler = (args: Record<string, unknown>) => ToolResult;
type StructuredToolResult<TData = Record<string, unknown>> = {
  status: string;
  project: { root: string; repoName: string; dbPath: string };
  freshness: { indexStatus: string; changedFiles: string[]; recommendedAction: string };
  data: TData;
  nextAction: { tool?: string; command?: string; reason: string };
  display: string;
};

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

function parseStructured<TData = Record<string, unknown>>(
  result: Awaited<ToolResult>,
): StructuredToolResult<TData> {
  return JSON.parse(result.content[0].text) as StructuredToolResult<TData>;
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

describe('MCP repo map', () => {
  let tempRoot: string;

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), 'code-memory-repo-map-'));
    cpSync(fixtureRoot, tempRoot, { recursive: true });
  });

  afterEach(async () => {
    await closeDatabase();
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it('includes indexed symbols for files in the focused directory', async () => {
    await indexFixture(tempRoot);
    const server = new FakeMcpServer();
    registerGetRepoMapTool(server as never, getDatabaseSync());

    const result = await server.handlers.get('get_repo_map')!({
      tokenBudget: 4000,
      directory: 'src/services',
    });
    const structured = parseStructured<{
      tokenBudget: number;
      directory: string;
      fileCount: number;
      symbolCount: number;
      files: Array<{ path: string; symbols: Array<{ name: string; kind: string }> }>;
    }>(result);

    expect(structured.status).toBe('ready');
    expect(structured.project.root).toBe(tempRoot);
    expect(structured.data.tokenBudget).toBe(4000);
    expect(structured.data.directory).toBe('src/services');
    expect(structured.data.fileCount).toBeGreaterThan(0);
    expect(structured.data.symbolCount).toBeGreaterThan(0);
    const serviceFiles = structured.data.files.map((file) => file.path);
    expect(serviceFiles).toContain('src/services/AuthService.ts');
    expect(serviceFiles).not.toContain('src/repositories/user-repository.ts');
    const authSymbols = structured.data.files
      .find((file) => file.path === 'src/services/AuthService.ts')
      ?.symbols.map((symbol) => `${symbol.name}:${symbol.kind}`);
    expect(authSymbols).toEqual(expect.arrayContaining([
      'LoginRequest:interface',
      'AuthService:class',
      'login:method',
    ]));
    expect(structured.data.files.some((file) =>
      file.symbols.some((symbol) => `${symbol.name}:${symbol.kind}` === 'issueTokens:function'))).toBe(true);
    expect(structured.display).toContain('AuthService.ts [source] [typescript]');
    expect(structured.display).toContain('symbols: {LoginRequest:interface');
    expect(structured.display).toContain('AuthService:class');
    expect(structured.display).toContain('login:method');
    expect(structured.display).toContain('issueTokens:function');
    expect(structured.display).not.toContain('user-repository.ts');
  });
});
